import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import type { Task } from "../domain/task.ts";
import { normalizeStatus } from "../domain/status.ts";
import { taskIdFor, type TaskEventInput, type WatcherStore } from "../persistence/store.ts";

export const REVIEW_REQUEUE_EVENT = "review_requeued";
export const REVIEW_REQUEUE_BASELINE_EVENT = "review_requeue_baseline";
export const REVIEW_COMMENT_HANDLED_EVENT = "review_comment_handled";
export const REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT = "review_requeue_notification_pending";
export const REVIEW_REQUEUE_NOTIFIED_EVENT = "review_requeue_notified";
export const REVIEW_REQUEUE_NOTIFICATION_DELIVERED_EVENT = "review_requeue_notification_delivered";

export type ReviewRequeueDecision =
  | { shouldRequeue: false }
  | { shouldRequeue: true; reason: "merge-conflict"; commentAt?: string }
  | { shouldRequeue: true; reason: "review-comment"; commentAt: string };

export interface ReviewRequeuePayload {
  message: string;
  event: WatcherEvent;
  sourceLabel?: string;
}

export function createReviewTransitionBaselineEvent(
  config: ResolvedWatcherRuntimeConfig,
  task: Task,
  fromStatus: string,
  toStatus: string,
): TaskEventInput | undefined {
  const review = config.reviewComment;
  const headRefOid = task.pullRequest?.headRefOid;
  if (
    !review ||
    !headRefOid ||
    normalizeStatus(fromStatus) !== normalizeStatus(review.inReviewStatus) ||
    normalizeStatus(toStatus) !== normalizeStatus(review.inProgressStatus)
  ) {
    return undefined;
  }
  return {
    taskId: task.id,
    type: REVIEW_REQUEUE_BASELINE_EVENT,
    actor: "watcher",
    fromStatus,
    toStatus,
    body: headRefOid,
  };
}

export function decideReviewRequeue(
  config: ResolvedWatcherRuntimeConfig,
  store: WatcherStore,
  event: WatcherEvent,
): ReviewRequeueDecision {
  const review = config.reviewComment;
  if (
    !review ||
    !event.resolvedState ||
    normalizeStatus(event.resolvedState) !== normalizeStatus(review.inReviewStatus)
  ) {
    return { shouldRequeue: false };
  }

  const latestCommentAt = event.pullRequest?.latestReviewCommentAt;
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  const handledCommentAt = store.getLatestEvent(taskId, REVIEW_COMMENT_HANDLED_EVENT)?.body;
  const unhandledCommentAt =
    latestCommentAt &&
    (!handledCommentAt || Date.parse(latestCommentAt) > Date.parse(handledCommentAt))
      ? latestCommentAt
      : undefined;

  if (event.pullRequest?.mergeable?.toLowerCase() === "conflicting") {
    return unhandledCommentAt
      ? { shouldRequeue: true, reason: "merge-conflict", commentAt: unhandledCommentAt }
      : { shouldRequeue: true, reason: "merge-conflict" };
  }

  return unhandledCommentAt
    ? { shouldRequeue: true, reason: "review-comment", commentAt: unhandledCommentAt }
    : { shouldRequeue: false };
}

export function shouldFetchReviewComments(
  config: ResolvedWatcherRuntimeConfig,
  status?: string | null,
): boolean {
  const review = config.reviewComment;
  return Boolean(
    review && status && normalizeStatus(status) === normalizeStatus(review.inReviewStatus),
  );
}

export function parseReviewRequeuePendingPayload(body: string): ReviewRequeuePayload {
  const payload = JSON.parse(body) as Partial<Record<keyof ReviewRequeuePayload, unknown>>;
  if (
    typeof payload.message !== "string" ||
    typeof payload.event !== "object" ||
    payload.event === null ||
    (payload.sourceLabel !== undefined && typeof payload.sourceLabel !== "string")
  ) {
    throw new Error("Invalid review requeue pending payload");
  }
  return payload as unknown as ReviewRequeuePayload;
}
