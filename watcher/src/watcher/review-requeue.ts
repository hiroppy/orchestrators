import type { ChatPostMessageArguments, WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";
import type { updateLinearIssueStatus } from "../integrations/linear-status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { withTaskCardQueue } from "../slack/task-card-queue.ts";
import {
  buildReviewRequeueLimitMessage,
  buildReviewRequeueMessage,
  buildReviewRequeueMessageBlocks,
  buildTaskCard,
} from "../slack/views.ts";
import { deliverPendingReviewLimitNotifications } from "./review-limit-delivery.ts";
import {
  REVIEW_REQUEUE_EVENT,
  REVIEW_REQUEUE_ATTEMPT_EVENT,
  REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
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

const REVIEW_REQUEUE_CARD_PENDING_EVENT = "review_requeue_card_pending";
const REVIEW_REQUEUE_CARD_COMPLETED_EVENT = "review_requeue_card_completed";
const REVIEW_REQUEUE_ANNOUNCEMENT_PENDING_EVENT = "review_requeue_announcement_pending";
const REVIEW_REQUEUE_ANNOUNCEMENT_COMPLETED_EVENT = "review_requeue_announcement_completed";

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
  await updateLinearStatus(task.issueIdentifier, review.inProgressStatus, {
    apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
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
      type: REVIEW_REQUEUE_CARD_PENDING_EVENT,
      actor: "watcher",
      fromStatus,
      toStatus: requeuedTask.status,
      body: JSON.stringify(withoutCreatorDetails(event)),
    },
    {
      taskId: task.id,
      type: REVIEW_REQUEUE_ANNOUNCEMENT_PENDING_EVENT,
      actor: "watcher",
      fromStatus,
      toStatus: requeuedTask.status,
      body: JSON.stringify({ reaction: review.reaction }),
    },
  ]);
  await deliverPendingReviewRequeueAnnouncements(store, slackClient, task.id);
  await deliverPendingReviewCardRefreshes(store, slackClient, requeuedTask.id);
}

export async function deliverPendingReviewRequeueAnnouncements(
  store: WatcherStore,
  slackClient: WebClient,
  onlyTaskId?: string,
): Promise<void> {
  const taskIds = onlyTaskId
    ? [onlyTaskId]
    : store.getTaskIdsWithIncompleteEvent(
        REVIEW_REQUEUE_ANNOUNCEMENT_PENDING_EVENT,
        REVIEW_REQUEUE_ANNOUNCEMENT_COMPLETED_EVENT,
      );
  for (const taskId of taskIds) {
    try {
      const pending = store.getLatestEvent(taskId, REVIEW_REQUEUE_ANNOUNCEMENT_PENDING_EVENT);
      const task = store.getTask(taskId);
      if (
        !pending?.body ||
        !pending.fromStatus ||
        !pending.toStatus ||
        !task?.parentChannelId ||
        !task.parentMessageTs
      )
        continue;
      const { reaction } = JSON.parse(pending.body) as { reaction?: unknown };
      if (typeof reaction !== "string") continue;
      const message = buildReviewRequeueMessage(reaction, pending.fromStatus, pending.toStatus);
      const announcement: ChatPostMessageArguments & { client_msg_id: string } = {
        channel: task.parentChannelId,
        thread_ts: task.parentMessageTs,
        text: message,
        blocks: buildReviewRequeueMessageBlocks(reaction, pending.fromStatus, pending.toStatus),
        client_msg_id: slackClientMessageId(pending.id),
      };
      await slackClient.chat.postMessage(announcement);
      store.addEvent({
        taskId,
        type: REVIEW_REQUEUE_ANNOUNCEMENT_COMPLETED_EVENT,
        actor: "watcher",
        fromStatus: pending.fromStatus,
        toStatus: pending.toStatus,
        body: String(pending.id),
      });
    } catch (error) {
      console.error(`Failed to announce review requeue for ${taskId}:`, error);
    }
  }
}

function slackClientMessageId(eventId: number): string {
  const suffix = eventId.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8001-${suffix}`;
}

export async function deliverPendingReviewCardRefreshes(
  store: WatcherStore,
  slackClient: WebClient,
  onlyTaskId?: string,
): Promise<void> {
  const taskIds = onlyTaskId
    ? [onlyTaskId]
    : store.getTaskIdsWithIncompleteEvent(
        REVIEW_REQUEUE_CARD_PENDING_EVENT,
        REVIEW_REQUEUE_CARD_COMPLETED_EVENT,
      );
  for (const taskId of taskIds) {
    try {
      const pending = store.getLatestEvent(taskId, REVIEW_REQUEUE_CARD_PENDING_EVENT);
      const task = store.getTask(taskId);
      if (!pending?.body || !pending.fromStatus || !task) continue;
      await refreshRequeuedTaskCard(
        store,
        slackClient,
        JSON.parse(pending.body) as WatcherEvent,
        taskId,
        pending.fromStatus,
      );
      store.addEvent({
        taskId,
        type: REVIEW_REQUEUE_CARD_COMPLETED_EVENT,
        actor: "watcher",
        fromStatus: pending.fromStatus,
        toStatus: task.status,
        body: String(pending.id),
      });
    } catch (error) {
      console.error(`Failed to refresh requeued task card for ${taskId}:`, error);
    }
  }
}

async function refreshRequeuedTaskCard(
  store: WatcherStore,
  slackClient: WebClient,
  event: WatcherEvent,
  taskId: string,
  fromStatus: string,
): Promise<void> {
  await withTaskCardQueue(taskId, async () => {
    const task = store.getTask(taskId)!;
    const card = buildTaskCard(
      task,
      store.getSelectableStatuses(task.serviceName),
      {
        ...event,
        state: fromStatus,
        resolvedState: task.status,
      },
      store.getTaskAssignees(task.id),
    );
    await slackClient.chat.update({
      channel: task.parentChannelId!,
      ts: task.parentMessageTs!,
      ...card,
    });
    store.setRenderedSummary(task.id, JSON.stringify(card));
  });
}

function withoutCreatorDetails(event: WatcherEvent): WatcherEvent {
  const { creatorName: _name, creatorEmail: _email, ...safeEvent } = event;
  return safeEvent;
}
