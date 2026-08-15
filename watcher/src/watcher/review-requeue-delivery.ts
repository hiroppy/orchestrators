import type { WebClient } from "@slack/web-api";

import type { TaskEvent } from "../domain/types.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { buildTaskCard } from "../slack/views.ts";
import { publishStatusTimeline } from "../slack/status-timeline.ts";
import { withTaskCardQueue } from "../slack/task-card-queue.ts";
import {
  parseReviewRequeuePendingPayload,
  REVIEW_REQUEUE_NOTIFICATION_DELIVERED_EVENT,
  REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT,
  REVIEW_REQUEUE_NOTIFIED_EVENT,
} from "./review-comments.ts";

export async function deliverPendingReviewRequeueNotifications(
  store: WatcherStore,
  slackClient: WebClient,
  onlyTaskId?: string,
): Promise<void> {
  for (const pending of store.getUncompletedEvents(
    REVIEW_REQUEUE_NOTIFICATION_PENDING_EVENT,
    REVIEW_REQUEUE_NOTIFICATION_DELIVERED_EVENT,
    onlyTaskId,
  )) {
    try {
      await deliverPendingReviewRequeueNotification(store, slackClient, pending);
    } catch (error) {
      console.error(
        `Failed to deliver pending review requeue notification for ${pending.taskId}:`,
        error,
      );
    }
  }
}

async function deliverPendingReviewRequeueNotification(
  store: WatcherStore,
  slackClient: WebClient,
  pending: TaskEvent,
): Promise<void> {
  const task = store.getTask(pending.taskId);
  if (!task?.parentChannelId || !task.parentMessageTs) return;
  if (!pending.body || !pending.fromStatus || !pending.toStatus) {
    throw new Error(`Invalid pending review requeue notification event for ${task.id}`);
  }
  const payload = parseReviewRequeuePendingPayload(pending.body);
  const completionKey = String(pending.id);
  if (!store.hasEvent(task.id, REVIEW_REQUEUE_NOTIFIED_EVENT, completionKey)) {
    await publishStatusTimeline(slackClient, store, {
      taskId: task.id,
      event: {
        fromStatus: pending.fromStatus,
        toStatus: pending.toStatus,
        occurredAt: pending.createdAt,
        source: { type: "automatic", label: "Inline review comment detected" },
      },
      fallbackText: payload.message,
    });
    store.addEvent({
      taskId: pending.taskId,
      type: REVIEW_REQUEUE_NOTIFIED_EVENT,
      actor: "watcher",
      fromStatus: pending.fromStatus,
      toStatus: pending.toStatus,
      body: completionKey,
    });
  }
  await withTaskCardQueue(task.id, async () => {
    const updatedTask = store.getTask(task.id)!;
    const card = buildTaskCard(
      updatedTask,
      store.getSelectableStatuses(updatedTask.serviceName),
      { ...payload.event, state: pending.fromStatus, resolvedState: updatedTask.status },
      store.getTaskAssignees(updatedTask.id),
    );
    await slackClient.chat.update({
      channel: updatedTask.parentChannelId!,
      ts: updatedTask.parentMessageTs!,
      ...card,
    });
    store.setRenderedSummary(updatedTask.id, JSON.stringify(card));
  });
  store.addEvent({
    taskId: pending.taskId,
    type: REVIEW_REQUEUE_NOTIFICATION_DELIVERED_EVENT,
    actor: "watcher",
    fromStatus: pending.fromStatus,
    toStatus: pending.toStatus,
    body: completionKey,
  });
}
