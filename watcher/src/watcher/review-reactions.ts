import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { PullRequest, WatcherEvent } from "../domain/types.ts";
import { normalizeStatus } from "../domain/status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { notificationIsEligible } from "../slack/notifications.ts";

export const REVIEW_REQUEUE_EVENT = "review_requeued";
export const REVIEW_REQUEUE_ATTEMPT_EVENT = "review_requeue_attempt";
export const REVIEW_REQUEUE_LIMIT_PENDING_EVENT = "review_requeue_limit_pending";
export const REVIEW_REQUEUE_LIMIT_NOTIFIED_EVENT = "review_requeue_limit_notified";
export const REVIEW_REQUEUE_LIMIT_EVENT = "review_requeue_limit_reached";
export const REVIEW_REQUEUE_RECONCILE_PENDING_EVENT = "review_requeue_reconcile_pending";
export const REVIEW_REQUEUE_RECONCILED_EVENT = "review_requeue_reconciled";

export interface ReviewReactionDecision {
  shouldRequeue: boolean;
  reachesLimit: boolean;
  hasPendingLimitNotification?: boolean;
  hasPendingReviewReconciliation?: boolean;
  deliverDeferredMention?: boolean;
}

export interface ReviewRequeuePayload {
  message: string;
  event: WatcherEvent;
  reaction?: string;
  maxRequeues?: number;
}

export function shouldSuppressReviewMention(decision: ReviewReactionDecision): boolean {
  return Boolean(
    decision.shouldRequeue ||
    decision.hasPendingLimitNotification ||
    decision.hasPendingReviewReconciliation,
  );
}

export function decideReviewReaction(
  config: ResolvedWatcherRuntimeConfig,
  store: WatcherStore,
  event: WatcherEvent,
  reconciliationIsAuthoritative = false,
): ReviewReactionDecision {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  const hasPendingReviewReconciliation = hasPendingEvent(
    store,
    taskId,
    REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
    REVIEW_REQUEUE_RECONCILED_EVENT,
  );
  const review = config.reviewReaction;
  const currentStatus = event.resolvedState ?? event.state ?? "";
  const isInReview = Boolean(
    review && normalizeStatus(currentStatus) === normalizeStatus(review.inReviewStatus),
  );
  if (
    isInReview &&
    hasPendingEvent(store, taskId, REVIEW_REQUEUE_LIMIT_PENDING_EVENT, REVIEW_REQUEUE_LIMIT_EVENT)
  ) {
    return {
      shouldRequeue: false,
      reachesLimit: false,
      hasPendingLimitNotification: true,
    };
  }

  if (!review || !isInReview || event.pullRequest?.hasConfiguredReaction !== true) {
    return {
      shouldRequeue: false,
      reachesLimit: false,
      hasPendingReviewReconciliation:
        hasPendingReviewReconciliation && !reconciliationIsAuthoritative && isInReview,
      deliverDeferredMention:
        hasPendingReviewReconciliation &&
        reconciliationIsAuthoritative &&
        isInReview &&
        event.pullRequest?.hasConfiguredReaction === false &&
        notificationIsEligible(config.notifications, undefined, currentStatus, event.type),
    };
  }

  const requeueCount = store.countEventsWithBody(
    taskId,
    REVIEW_REQUEUE_ATTEMPT_EVENT,
    reviewRequeueAttemptKey(event, review.reaction),
  );
  if (requeueCount >= review.maxRequeues) {
    return { shouldRequeue: false, reachesLimit: false };
  }

  return {
    shouldRequeue: true,
    reachesLimit: requeueCount + 1 === review.maxRequeues,
  };
}

export function reviewRequeueAttemptKey(event: WatcherEvent, reaction: string): string {
  const pullRequest = event.pullRequest;
  return JSON.stringify({
    pullRequestUrl: pullRequest?.url ?? null,
    headRefOid: pullRequest?.headRefOid ?? null,
    reaction,
  });
}

export function reviewReactionForStatus(
  config: ResolvedWatcherRuntimeConfig,
  status?: string | null,
): string | undefined {
  const review = config.reviewReaction;
  return review && status && normalizeStatus(status) === normalizeStatus(review.inReviewStatus)
    ? review.reaction
    : undefined;
}

export function hasPendingEvent(
  store: WatcherStore,
  taskId: string,
  pendingType: string,
  completedType: string,
): boolean {
  return store.countEventsAfterLatest(taskId, pendingType, completedType) > 0;
}

export function pendingReviewPullRequest(
  store: WatcherStore,
  taskId: string,
): PullRequest | undefined {
  const body = store.getLatestEvent(taskId, REVIEW_REQUEUE_LIMIT_PENDING_EVENT)?.body;
  if (!body) return undefined;

  try {
    return parseReviewRequeuePendingPayload(body).event.pullRequest;
  } catch {
    return undefined;
  }
}

export function parseReviewRequeuePendingPayload(body: string): ReviewRequeuePayload {
  const payload = JSON.parse(body) as Partial<Record<keyof ReviewRequeuePayload, unknown>>;
  if (typeof payload.message !== "string" || typeof payload.event !== "object") {
    throw new Error("Invalid review requeue pending payload");
  }
  if (payload.reaction !== undefined && typeof payload.reaction !== "string") {
    throw new Error("Invalid review requeue pending reaction");
  }
  if (payload.maxRequeues !== undefined && typeof payload.maxRequeues !== "number") {
    throw new Error("Invalid review requeue pending limit");
  }
  return payload as unknown as ReviewRequeuePayload;
}
