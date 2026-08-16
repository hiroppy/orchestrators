import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";
import type { updateLinearIssueStatus } from "../integrations/linear-status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { buildReviewRequeueMessage } from "../slack/views.ts";
import { deliverPendingReviewRequeueNotifications } from "./review-requeue-delivery.ts";
import {
  REVIEW_COMMENT_HANDLED_EVENT,
  REVIEW_REQUEUE_EVENT,
  REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT,
  type ReviewRequeueDecision,
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
  decision: ReviewRequeueDecision;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const review = config.reviewComment;
  if (!decision.shouldRequeue || !review) return;

  const task = store.getTask(taskIdFor(event.service, event.issueIdentifier))!;
  const team = linearTeamForService(config, task.serviceName);
  try {
    await updateLinearStatus(task.issueIdentifier, review.inProgressStatus, {
      apiKey: team?.apiKey,
      issueId: event.linearIssueId,
      teamId: team?.teamId,
    });
  } catch (error) {
    throw new Error(
      `Failed to requeue ${task.issueIdentifier} from ${task.status} to ${review.inProgressStatus}.`,
      { cause: error },
    );
  }
  const sourceLabel =
    decision.reason === "merge-conflict"
      ? "Merge conflict detected"
      : "Inline review comment detected";
  const message = buildReviewRequeueMessage(sourceLabel, task.status, review.inProgressStatus);
  const { task: requeuedTask } = store.updateTaskStatusAtomically(
    task.id,
    review.inProgressStatus,
    (updatedTask, fromStatus) => {
      const statusHookEvent = createPendingStatusHookEvent(
        config.statusHooks ?? [],
        updatedTask,
        fromStatus,
        updatedTask.status,
        event.pullRequest,
      );
      const commentHandledEvent =
        decision.reason === "review-comment"
          ? [
              {
                taskId: task.id,
                type: REVIEW_COMMENT_HANDLED_EVENT,
                actor: "watcher",
                fromStatus,
                toStatus: updatedTask.status,
                body: decision.commentAt,
              },
            ]
          : [];
      return [
        ...(statusHookEvent ? [statusHookEvent] : []),
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
          body: JSON.stringify({ message, event, sourceLabel }),
        },
        ...commentHandledEvent,
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
