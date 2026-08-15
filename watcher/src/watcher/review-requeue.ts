import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { TaskEvent, WatcherEvent } from "../domain/types.ts";
import type { updateLinearIssueStatus } from "../integrations/linear-status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { buildReviewRequeueMessage } from "../slack/views.ts";
import { deliverPendingReviewRequeueNotifications } from "./review-requeue-delivery.ts";
import {
  REVIEW_COMMENT_HANDLED_EVENT,
  REVIEW_REQUEUE_EVENT,
  REVIEW_REQUEUE_COMPLETED_EVENT,
  REVIEW_REQUEUE_PENDING_EVENT,
  REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT,
  type ReviewCommentDecision,
} from "./review-comments.ts";
import { linearTeamForService } from "./runtime-config.ts";
import { createPendingStatusHookEvent, deliverPendingStatusHooksSafely } from "./status-hooks.ts";

export async function requeueReviewTask({
  config,
  store,
  slackClient,
  watcherChannelId,
  event,
  decision,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  watcherChannelId: string;
  event: WatcherEvent;
  decision: ReviewCommentDecision;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const review = config.reviewComment;
  if (!decision.shouldRequeue || !review) return;
  if (!decision.commentAt) throw new Error("Review requeue is missing its comment timestamp");

  const task = store.getTask(taskIdFor(event.service, event.issueIdentifier))!;
  const pending = store.addEvent({
    taskId: task.id,
    type: REVIEW_REQUEUE_PENDING_EVENT,
    actor: "watcher",
    fromStatus: task.status,
    toStatus: review.inProgressStatus,
    body: JSON.stringify({ event, commentAt: decision.commentAt }),
  });
  await completeReviewRequeue({
    config,
    store,
    slackClient,
    watcherChannelId,
    pending,
    event,
    commentAt: decision.commentAt,
    updateLinearStatus,
  });
}

export async function recoverPendingReviewRequeues({
  config,
  store,
  slackClient,
  watcherChannelId,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  watcherChannelId: string;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  for (const pending of store.getUncompletedEvents(
    REVIEW_REQUEUE_PENDING_EVENT,
    REVIEW_REQUEUE_COMPLETED_EVENT,
  )) {
    const payload = JSON.parse(pending.body ?? "") as {
      event: WatcherEvent;
      commentAt: string;
    };
    await completeReviewRequeue({
      config,
      store,
      slackClient,
      watcherChannelId,
      pending,
      ...payload,
      updateLinearStatus,
    });
  }
}

async function completeReviewRequeue({
  config,
  store,
  slackClient,
  watcherChannelId,
  pending,
  event,
  commentAt,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  watcherChannelId: string;
  pending: TaskEvent;
  event: WatcherEvent;
  commentAt: string;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const review = config.reviewComment;
  if (!review) return;
  const task = store.getTask(pending.taskId)!;
  const team = linearTeamForService(config, task.serviceName);
  await updateLinearStatus(task.issueIdentifier, review.inProgressStatus, {
    apiKey: team?.apiKey,
    issueId: event.linearIssueId,
    teamId: team?.teamId,
  });
  const fromStatus = pending.fromStatus ?? task.status;
  const message = buildReviewRequeueMessage(fromStatus, review.inProgressStatus);
  const { task: requeuedTask } = store.updateTaskStatusAtomically(
    task.id,
    review.inProgressStatus,
    (updatedTask) => {
      const statusHookEvent = createPendingStatusHookEvent(
        config.statusHooks ?? [],
        updatedTask,
        fromStatus,
        updatedTask.status,
        event.pullRequest,
      );
      return [
        ...(statusHookEvent ? [statusHookEvent] : []),
        {
          taskId: task.id,
          type: REVIEW_REQUEUE_COMPLETED_EVENT,
          actor: "watcher",
          fromStatus,
          toStatus: updatedTask.status,
          body: String(pending.id),
        },
        {
          taskId: task.id,
          type: REVIEW_REQUEUE_EVENT,
          actor: "watcher",
          fromStatus,
          toStatus: updatedTask.status,
          body: message,
        },
        {
          taskId: task.id,
          type: REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT,
          actor: "watcher",
          fromStatus,
          toStatus: updatedTask.status,
          body: JSON.stringify({ message, event }),
        },
        {
          taskId: task.id,
          type: REVIEW_COMMENT_HANDLED_EVENT,
          actor: "watcher",
          fromStatus,
          toStatus: updatedTask.status,
          body: commentAt,
        },
      ];
    },
  );
  await deliverPendingStatusHooksSafely({
    hooks: config.statusHooks ?? [],
    store,
    slackClient,
    watcherChannelId,
    taskId: requeuedTask.id,
  });
  await deliverPendingReviewRequeueNotifications(store, slackClient, task.id);
}
