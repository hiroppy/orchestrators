import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";
import type { updateLinearIssueStatus } from "../integrations/linear-status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { buildReviewRequeueLimitMessage, buildReviewRequeueMessage } from "../slack/views.ts";
import {
  deliverPendingReviewLimitNotifications,
  deliverPendingReviewRequeueNotifications,
} from "./review-limit-delivery.ts";
import {
  REVIEW_REQUEUE_EVENT,
  REVIEW_REQUEUE_ATTEMPT_EVENT,
  REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
  REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT,
  type ReviewReactionDecision,
  reviewRequeueAttemptKey,
} from "./review-reactions.ts";
import { linearTeamForService } from "./runtime-config.ts";
import { createPendingStatusHookEvent, deliverPendingStatusHooksSafely } from "./status-hooks.ts";

interface RequeueReviewTaskOptions {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  watcherChannelId: string;
  event: WatcherEvent;
  decision: ReviewReactionDecision;
  updateLinearStatus: typeof updateLinearIssueStatus;
}

export async function requeueReviewTask({
  config,
  store,
  slackClient,
  watcherChannelId,
  event,
  decision,
  updateLinearStatus,
}: RequeueReviewTaskOptions): Promise<void> {
  const review = config.reviewReaction;
  if (!decision.shouldRequeue || !review) return;

  const taskId = taskIdFor(event.service, event.issueIdentifier);
  const task = store.getTask(taskId)!;
  const team = linearTeamForService(config, task.serviceName);
  await updateLinearStatus(task.issueIdentifier, review.inProgressStatus, {
    apiKey: team?.apiKey,
    issueId: event.linearIssueId,
    teamId: team?.teamId,
  });
  const { task: requeuedTask, fromStatus } = store.updateTaskStatusAtomically(
    task.id,
    review.inProgressStatus,
    (updatedTask, previousStatus) =>
      createPendingStatusHookEvent(
        config.statusHooks ?? [],
        updatedTask,
        previousStatus,
        updatedTask.status,
        event.pullRequest,
      ),
  );
  await deliverPendingStatusHooksSafely({
    hooks: config.statusHooks ?? [],
    store,
    slackClient,
    watcherChannelId,
    taskId: requeuedTask.id,
  });

  const requeueEvent = {
    taskId: task.id,
    type: REVIEW_REQUEUE_EVENT,
    actor: "watcher",
    fromStatus,
    toStatus: requeuedTask.status,
    body: buildReviewRequeueMessage(review.reaction, fromStatus, requeuedTask.status),
  };
  const attemptEvent = {
    taskId: task.id,
    type: REVIEW_REQUEUE_ATTEMPT_EVENT,
    actor: "watcher",
    body: reviewRequeueAttemptKey(event, review.reaction),
  };

  if (decision.reachesLimit) {
    const limitMessage = buildReviewRequeueLimitMessage(
      review.reaction,
      review.maxRequeues,
      fromStatus,
      requeuedTask.status,
    );
    store.addEvents([
      attemptEvent,
      requeueEvent,
      {
        taskId: task.id,
        type: REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
        actor: "watcher",
        fromStatus,
        toStatus: requeuedTask.status,
        body: JSON.stringify({
          message: limitMessage,
          event: withoutCreatorDetails(event),
          reaction: review.reaction,
          maxRequeues: review.maxRequeues,
        }),
      },
    ]);
    await deliverPendingReviewLimitNotifications(store, slackClient, task.id);
    return;
  }

  store.addEvents([
    attemptEvent,
    requeueEvent,
    {
      taskId: task.id,
      type: REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT,
      actor: "watcher",
      fromStatus,
      toStatus: requeuedTask.status,
      body: JSON.stringify({
        message: requeueEvent.body,
        event: withoutCreatorDetails(event),
        reaction: review.reaction,
      }),
    },
  ]);
  await deliverPendingReviewRequeueNotifications(store, slackClient, task.id);
}

function withoutCreatorDetails(event: WatcherEvent): WatcherEvent {
  const { creatorName: _name, creatorEmail: _email, ...safeEvent } = event;
  return safeEvent;
}
