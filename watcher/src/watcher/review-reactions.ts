import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { PullRequest, WatcherEvent } from "../domain/types.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { notificationIsEligible } from "../slack/app.ts";

export const REVIEW_REQUEUE_EVENT = "review_requeued";
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
        notificationIsEligible(config.mention, undefined, currentStatus, event.type),
    };
  }

  let requeueCount = store.countEventsAfterLatest(
    taskId,
    REVIEW_REQUEUE_EVENT,
    REVIEW_REQUEUE_LIMIT_EVENT,
  );
  if (review.maxRequeues > 0) requeueCount %= review.maxRequeues;
  if (requeueCount >= review.maxRequeues) {
    return { shouldRequeue: false, reachesLimit: false };
  }

  return {
    shouldRequeue: true,
    reachesLimit: requeueCount + 1 === review.maxRequeues,
  };
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
  parsePayload: (body: string) => { event: WatcherEvent },
): PullRequest | undefined {
  const body = store.getLatestEvent(taskId, REVIEW_REQUEUE_LIMIT_PENDING_EVENT)?.body;
  if (!body) return undefined;

  try {
    return parsePayload(body).event.pullRequest;
  } catch {
    return undefined;
  }
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}
