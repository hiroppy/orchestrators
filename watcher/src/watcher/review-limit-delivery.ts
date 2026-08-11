import type { WebClient } from "@slack/web-api";

import type { WatcherStore } from "../persistence/store.ts";
import { buildReviewRequeueLimitMessageBlocks, buildTaskCard } from "../slack/views.ts";
import {
  hasPendingEvent,
  parseReviewRequeuePendingPayload,
  REVIEW_REQUEUE_LIMIT_EVENT,
  REVIEW_REQUEUE_LIMIT_NOTIFIED_EVENT,
  REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
  REVIEW_REQUEUE_RECONCILED_EVENT,
  REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
} from "./review-reactions.ts";

export async function deliverPendingReviewLimitNotifications(
  store: WatcherStore,
  slackClient: WebClient,
  onlyTaskId?: string,
): Promise<Set<string>> {
  const taskIds = onlyTaskId
    ? [onlyTaskId]
    : store.getTaskIdsWithIncompleteEvent(
        REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
        REVIEW_REQUEUE_LIMIT_EVENT,
      );
  const completedTaskIds = new Set<string>();

  for (const taskId of taskIds) {
    try {
      if (await deliverPendingReviewLimitNotification(store, slackClient, taskId)) {
        completedTaskIds.add(taskId);
      }
    } catch (error) {
      console.error(`Failed to deliver pending review limit notification for ${taskId}:`, error);
    }
  }

  return completedTaskIds;
}

export function markReviewRequeueReconciled(store: WatcherStore, taskId: string): void {
  if (
    !hasPendingEvent(
      store,
      taskId,
      REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
      REVIEW_REQUEUE_RECONCILED_EVENT,
    )
  ) {
    return;
  }

  store.addEvent({ taskId, type: REVIEW_REQUEUE_RECONCILED_EVENT, actor: "watcher" });
}

async function deliverPendingReviewLimitNotification(
  store: WatcherStore,
  slackClient: WebClient,
  taskId: string,
): Promise<boolean> {
  const task = store.getTask(taskId);
  const pending = store.getLatestEvent(taskId, REVIEW_REQUEUE_LIMIT_PENDING_EVENT);
  const completed = store.getLatestEvent(taskId, REVIEW_REQUEUE_LIMIT_EVENT);
  if (
    !task?.parentChannelId ||
    !task.parentMessageTs ||
    !pending ||
    (completed && completed.id > pending.id)
  ) {
    return false;
  }

  if (!pending.body || !pending.fromStatus || !pending.toStatus) {
    throw new Error(`Invalid pending review requeue limit event for ${task.id}`);
  }
  const payload = parseReviewRequeuePendingPayload(pending.body);

  const notified = store.getLatestEvent(task.id, REVIEW_REQUEUE_LIMIT_NOTIFIED_EVENT);
  if (!notified || notified.id < pending.id) {
    const message = {
      channel: task.parentChannelId,
      thread_ts: task.parentMessageTs,
      text: payload.message,
      blocks: buildReviewRequeueLimitMessageBlocks(
        payload.reaction ?? reviewReactionFromMessage(payload.message),
        payload.maxRequeues ?? reviewRequeueLimitFromMessage(payload.message),
        pending.fromStatus,
        pending.toStatus,
      ),
      client_msg_id: slackClientMessageId(pending.id),
    };
    await slackClient.chat.postMessage(message);
    store.addEvent({
      taskId: task.id,
      type: REVIEW_REQUEUE_LIMIT_NOTIFIED_EVENT,
      actor: "watcher",
      fromStatus: pending.fromStatus,
      toStatus: pending.toStatus,
      body: payload.message,
    });
  }

  const updatedTask = store.getTask(task.id)!;
  const card = buildTaskCard(
    updatedTask,
    store.getSelectableStatuses(task.serviceName),
    {
      ...payload.event,
      state: pending.fromStatus,
      resolvedState: updatedTask.status,
    },
    store.getTaskAssignees(updatedTask.id),
  );
  await slackClient.chat.update({
    channel: task.parentChannelId,
    ts: task.parentMessageTs,
    ...card,
  });
  store.setRenderedSummary(task.id, JSON.stringify(card));
  store.addEvents([
    {
      taskId: task.id,
      type: REVIEW_REQUEUE_LIMIT_EVENT,
      actor: "watcher",
      fromStatus: pending.fromStatus,
      toStatus: pending.toStatus,
      body: payload.message,
    },
    {
      taskId: task.id,
      type: REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
      actor: "watcher",
      fromStatus: pending.fromStatus,
      toStatus: pending.toStatus,
      body: payload.message,
    },
  ]);
  store.setTaskLinearStateType(task.id, undefined);
  return true;
}

function slackClientMessageId(eventId: number): string {
  const suffix = eventId.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}

function reviewReactionFromMessage(message: string): string {
  return message.match(/^(.*?) review requeue limit reached/)?.[1] ?? "";
}

function reviewRequeueLimitFromMessage(message: string): number {
  return Number(message.match(/review requeue limit reached \((\d+)\//)?.[1] ?? 0);
}
