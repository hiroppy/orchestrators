import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";
import { normalizeStatus } from "../domain/status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";

export const REVIEW_REQUEUE_EVENT = "review_requeued";
export const REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT = "review_requeue_notification_pending";
export const REVIEW_REQUEUE_NOTIFIED_EVENT = "review_requeue_notified";
export const REVIEW_REQUEUE_NOTIFICATION_DELIVERED_EVENT = "review_requeue_notification_delivered";

export interface ReviewCommentDecision {
  shouldRequeue: boolean;
}

export interface ReviewRequeuePayload {
  message: string;
  event: WatcherEvent;
}

export function decideReviewComment(
  config: ResolvedWatcherRuntimeConfig,
  store: WatcherStore,
  event: WatcherEvent,
): ReviewCommentDecision {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  const review = config.reviewComment;
  const currentStatus = event.resolvedState ?? event.state ?? "";
  const isInReview = Boolean(
    review && normalizeStatus(currentStatus) === normalizeStatus(review.inReviewStatus),
  );
  const wasAlreadyInReview = Boolean(
    review &&
    normalizeStatus(store.getTask(taskId)?.status) === normalizeStatus(review.inReviewStatus),
  );
  const latestCommentAt = event.pullRequest?.latestReviewCommentAt;
  const enteredReviewAt = review
    ? store.getLatestTransitionTo(taskId, review.inReviewStatus)?.createdAt
    : undefined;
  const shouldRequeue = Boolean(
    isInReview &&
    wasAlreadyInReview &&
    latestCommentAt &&
    enteredReviewAt &&
    Date.parse(latestCommentAt) > Date.parse(enteredReviewAt),
  );

  return { shouldRequeue };
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
  if (typeof payload.message !== "string" || typeof payload.event !== "object") {
    throw new Error("Invalid review requeue pending payload");
  }
  return payload as unknown as ReviewRequeuePayload;
}
