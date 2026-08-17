import type { ChatPostMessageArguments } from "@slack/web-api";
import { DEFAULT_REVIEW_READY_DELAY_MS } from "orchestrator-config";

import type { PullRequest } from "../domain/github.ts";
import type { Task } from "../domain/task.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { WatcherStore } from "../persistence/store.ts";

const REVIEW_READY_OBSERVED_EVENT = "review_ready_observed";
const REVIEW_READY_NOTIFICATION_PENDING_EVENT = "review_ready_notification_pending";
export const REVIEW_READY_NOTIFIED_EVENT = "review_ready_notified";
const REVIEW_READY_NOTIFICATION_DELIVERED_EVENT = "review_ready_notification_delivered";
export const REVIEW_READY_DELAY_MS = DEFAULT_REVIEW_READY_DELAY_MS;
const REVIEW_READY_RESET_BODY = "reset";

interface ReviewReadyPayload {
  key: string;
  sha: string;
  pullRequestUrl: string;
}

interface ReviewReadySlackClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<unknown>;
  };
}

export async function checkReviewReadyNotification({
  store,
  slackClient,
  task,
  inReviewStatus,
  pullRequest,
  delayMs = REVIEW_READY_DELAY_MS,
  now = new Date(),
}: {
  store: WatcherStore;
  slackClient: ReviewReadySlackClient;
  task: Task;
  inReviewStatus: string;
  pullRequest?: PullRequest;
  delayMs?: number;
  now?: Date;
}): Promise<void> {
  if (normalizeStatus(task.status) !== normalizeStatus(inReviewStatus)) {
    resetQuietWindow(store, task.id, now);
    return;
  }
  if (!pullRequest?.url || !pullRequest.headRefOid) return;
  if (pullRequest.isDraft || normalizeStatus(pullRequest.state ?? "open") !== "open") {
    resetQuietWindow(store, task.id, now);
    return;
  }

  const payload = reviewReadyPayload(pullRequest.url, pullRequest.headRefOid);
  if (store.hasEvent(task.id, REVIEW_READY_NOTIFIED_EVENT, payload.key)) return;

  const observed = store.getLatestEvent(task.id, REVIEW_READY_OBSERVED_EVENT);
  if (observed?.body !== payload.key) {
    store.addEvent({
      taskId: task.id,
      type: REVIEW_READY_OBSERVED_EVENT,
      actor: "watcher",
      body: payload.key,
      createdAt: now,
    });
    return;
  }
  if (now.getTime() - Date.parse(observed.createdAt) < delayMs) return;
  if (store.getTaskAssignees(task.id).length === 0) return;

  const body = JSON.stringify(payload);
  if (!store.hasEvent(task.id, REVIEW_READY_NOTIFICATION_PENDING_EVENT, body)) {
    store.addEvent({
      taskId: task.id,
      type: REVIEW_READY_NOTIFICATION_PENDING_EVENT,
      actor: "watcher",
      body,
      createdAt: now,
    });
  }
  await deliverPendingReviewReadyNotifications(store, slackClient, task.id, payload.key);
}

export async function checkReviewReadyNotificationSafely(
  options: Parameters<typeof checkReviewReadyNotification>[0],
): Promise<void> {
  try {
    await checkReviewReadyNotification(options);
  } catch (error) {
    console.error("Review-ready notification check failed; it will be retried:", error);
  }
}

function resetQuietWindow(store: WatcherStore, taskId: string, now: Date): void {
  const observed = store.getLatestEvent(taskId, REVIEW_READY_OBSERVED_EVENT);
  if (observed && observed.body !== REVIEW_READY_RESET_BODY) {
    store.addEvent({
      taskId,
      type: REVIEW_READY_OBSERVED_EVENT,
      actor: "watcher",
      body: REVIEW_READY_RESET_BODY,
      createdAt: now,
    });
  }
}

async function deliverPendingReviewReadyNotifications(
  store: WatcherStore,
  slackClient: ReviewReadySlackClient,
  taskId: string,
  expectedKey: string,
): Promise<void> {
  for (const pending of store.getUncompletedEvents(
    REVIEW_READY_NOTIFICATION_PENDING_EVENT,
    REVIEW_READY_NOTIFICATION_DELIVERED_EVENT,
    taskId,
  )) {
    try {
      const task = store.getTask(pending.taskId);
      if (!task?.parentChannelId || !task.parentMessageTs || !pending.body) continue;
      const payload = parseReviewReadyPayload(pending.body);
      const completionKey = String(pending.id);
      if (payload.key !== expectedKey) {
        store.addEvent({
          taskId: task.id,
          type: REVIEW_READY_NOTIFICATION_DELIVERED_EVENT,
          actor: "watcher",
          body: completionKey,
        });
        continue;
      }
      if (!store.hasEvent(task.id, REVIEW_READY_NOTIFIED_EVENT, payload.key)) {
        const assignees = store.getTaskAssignees(task.id);
        if (assignees.length === 0) continue;
        await slackClient.chat.postMessage({
          channel: task.parentChannelId,
          thread_ts: task.parentMessageTs,
          text: `Ready for review: ${assignees.join(" ")} <${payload.pullRequestUrl}|${task.issueIdentifier}> (SHA ${payload.sha.slice(0, 7)})`,
        });
        store.addEvent({
          taskId: task.id,
          type: REVIEW_READY_NOTIFIED_EVENT,
          actor: "watcher",
          body: payload.key,
        });
      }
      store.addEvent({
        taskId: task.id,
        type: REVIEW_READY_NOTIFICATION_DELIVERED_EVENT,
        actor: "watcher",
        body: completionKey,
      });
    } catch (error) {
      console.error(`Failed to deliver review-ready notification for ${pending.taskId}:`, error);
    }
  }
}

function reviewReadyPayload(pullRequestUrl: string, sha: string): ReviewReadyPayload {
  return {
    key: `${pullRequestUrl}#${sha}`,
    sha,
    pullRequestUrl,
  };
}

function parseReviewReadyPayload(body: string): ReviewReadyPayload {
  const payload = JSON.parse(body) as Partial<ReviewReadyPayload>;
  if (!payload.key || !payload.sha || !payload.pullRequestUrl) {
    throw new Error("Invalid review-ready notification payload");
  }
  return payload as ReviewReadyPayload;
}
