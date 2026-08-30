import type { ChatPostMessageResponse } from "@slack/web-api";

import type { RelatedIssue } from "../domain/linear.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { Task } from "../domain/task.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import { taskIdFor, type TaskEventInput, type WatcherStore } from "../persistence/store.ts";
import { slackAssigneeIdFromMention } from "./assignee.ts";
import type { SlackClient } from "./client-types.ts";
import { initialTaskAssignees } from "./notifications.ts";
import {
  deliverStatusTimelineEvent,
  publishStatusTimeline,
  recordStatusTimeline,
  reloadStatusTimeline,
} from "./status-timeline.ts";
import { withTaskCardQueue } from "./task-card-queue.ts";
import { resolveSlackAssigneeLabels } from "./users.ts";
import {
  buildRelatedIssuesMessage,
  buildRelatedIssuesMessageBlocks,
  buildTaskCard,
  buildTaskClosedMessage,
  buildTaskClosedMessageBlocks,
  buildThreadMessage,
  buildThreadMessageBlocks,
  parentEventLabel,
} from "./views.ts";

export async function publishWatcherEvent(
  client: SlackClient,
  store: WatcherStore,
  destinationChannel: string,
  event: WatcherEvent,
  options: {
    defaultAssignees?: string[];
    onStatusTransition?: (task: Task, fromStatus: string) => Promise<void>;
    createStatusTransitionEvent?: (task: Task, fromStatus: string) => TaskEventInput | undefined;
    afterPublish?: (task: Task) => Promise<void>;
  } = {},
): Promise<void> {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  await withTaskCardQueue(taskId, async () => {
    const clearsActivity =
      event.type === "ended" || event.type === "retrying" || event.type === "blocked";
    const taskBeforeEvent = clearsActivity ? store.getTask(taskId) : undefined;
    const previousActivity = taskBeforeEvent?.currentActivity;
    const previousActivityPublishedAt = taskBeforeEvent?.activityPublishedAt;
    const activityCleared = Boolean(previousActivity);

    const { task: persistedTask, previousTask } = store.upsertTaskFromEventAtomically(
      event,
      (task, previous) =>
        previous && normalizeStatus(previous.status) !== normalizeStatus(task.status)
          ? options.createStatusTransitionEvent?.(task, previous.status)
          : undefined,
    );
    if (!persistedTask.parentMessageTs && store.getTaskAssignees(taskId).length === 0) {
      for (const assignee of initialTaskAssignees(
        options.defaultAssignees ?? [],
        event.creatorMention,
      )) {
        const assigneeId = slackAssigneeIdFromMention(assignee);
        if (assigneeId) store.assignTask(taskId, assigneeId);
      }
    }
    let task = persistedTask;
    const pullRequestChanged =
      event.pullRequest !== undefined &&
      (event.pullRequest.url !== previousTask?.pullRequest?.url ||
        event.pullRequest.number !== previousTask?.pullRequest?.number ||
        event.pullRequest.title !== previousTask?.pullRequest?.title);
    const statusChanged =
      previousTask !== undefined &&
      normalizeStatus(previousTask.status) !== normalizeStatus(task.status);
    if (statusChanged) {
      await options.onStatusTransition?.(task, previousTask.status);
    }
    const assignees = store.getTaskAssignees(taskId);
    const notificationAssignees = event.type === "blocked" ? assignees : undefined;
    const assigneeLabels = await resolveSlackAssigneeLabels(client, assignees);
    const card = buildTaskCard(
      task,
      store.getSelectableStatuses(task.serviceName),
      event,
      assigneeLabels,
    );
    const summary = JSON.stringify(card);
    const statusEvent = { ...event, pullRequest: undefined };
    const threadContext = {
      fromStatus: previousTask?.status,
      toStatus: task.status,
    };
    const statusBody = buildThreadMessage(statusEvent, threadContext);
    const needsTimelineAnchor =
      store.getLatestEventsByType(task.id, "status_timeline", 1).length === 0;
    const timelineDelivery = {
      taskId: task.id,
      event: {
        fromStatus: previousTask?.status ?? task.status,
        toStatus: task.status,
        occurredAt: new Date().toISOString(),
        source: {
          type: "automatic" as const,
          label: parentEventLabel(statusEvent),
          error: statusEvent.error,
        },
      },
      fallbackText: statusBody,
    };
    const pendingTimeline =
      statusChanged && task.parentChannelId && task.parentMessageTs && !clearsActivity
        ? recordStatusTimeline(store, timelineDelivery)
        : undefined;
    const announceTerminalParent =
      Boolean(previousTask?.parentMessageTs) &&
      enteredTerminalLinearState(previousTask?.linearStateType, task.linearStateType);
    if (!task.parentChannelId || !task.parentMessageTs) {
      const parent = await client.chat.postMessage({
        channel: destinationChannel,
        ...card,
      });
      if (!parent.channel || !parent.ts) {
        throw new Error(`Slack did not return channel/ts for task ${task.id}.`);
      }
      task = store.setParentMessage(task.id, parent.channel, parent.ts, summary);
    } else {
      try {
        await client.chat.update({
          channel: task.parentChannelId,
          ts: task.parentMessageTs,
          ...card,
        });
        store.setRenderedSummary(task.id, summary);
        if (announceTerminalParent) {
          const closedMessage = await postTaskClosedMessage(
            client,
            task.parentChannelId,
            task.parentMessageTs,
            task.status,
            task.title,
          );
          await postRelatedIssues(
            client,
            task.parentChannelId,
            closedMessage.ts,
            event.relatedIssues,
          );
        }
      } catch (error) {
        if (announceTerminalParent) {
          store.setTaskLinearStateType(task.id, previousTask?.linearStateType);
        }
        throw error;
      }
    }

    if (activityCleared) store.setTaskActivity(task.id, undefined);
    try {
      if (pendingTimeline) {
        await deliverStatusTimelineEvent(client, store, pendingTimeline);
      } else if (statusChanged || needsTimelineAnchor) {
        await publishStatusTimeline(client, store, timelineDelivery);
      } else if (pullRequestChanged || activityCleared) {
        const reloaded = await reloadStatusTimeline(client, store, task.id);
        if (activityCleared && !reloaded) {
          throw new Error(`Task has no delivered Timeline anchor: ${task.id}`);
        }
      }
    } catch (error) {
      if (previousActivity) {
        store.setTaskActivity(task.id, previousActivity);
        if (previousActivityPublishedAt) {
          store.markTaskActivityPublished(task.id, new Date(previousActivityPublishedAt));
        }
      }
      throw error;
    }

    const standaloneContext = { assignees: notificationAssignees };
    const standaloneBody = buildThreadMessage(statusEvent, standaloneContext);
    const standaloneBlocks = buildThreadMessageBlocks(statusEvent, standaloneContext);
    const shouldPostStandalone = notificationAssignees !== undefined;
    const reply = shouldPostStandalone
      ? await client.chat.postMessage({
          channel: task.parentChannelId!,
          thread_ts: task.parentMessageTs!,
          text: standaloneBody,
          ...(standaloneBlocks ? { blocks: standaloneBlocks } : {}),
        })
      : undefined;
    await options.afterPublish?.(task);
    store.addEvent({
      taskId: task.id,
      type: event.type,
      actor: "watcher",
      fromStatus: previousTask?.status,
      toStatus: task.status,
      body: statusChanged ? statusBody : standaloneBody,
      slackThreadTs: reply?.ts,
    });
  });
}

async function postTaskClosedMessage(
  client: SlackClient,
  channel: string,
  messageTs: string,
  status: string,
  title: string,
): Promise<ChatPostMessageResponse> {
  const response = await client.chat.getPermalink({
    channel,
    message_ts: messageTs,
  });
  if (!response.permalink) {
    throw new Error(`Slack did not return a permalink for ${channel}:${messageTs}.`);
  }
  return client.chat.postMessage({
    channel,
    text: buildTaskClosedMessage(status, response.permalink, title),
    blocks: buildTaskClosedMessageBlocks(status, response.permalink, title),
    unfurl_links: false,
    unfurl_media: false,
  });
}

async function postRelatedIssues(
  client: SlackClient,
  channel: string,
  closedMessageTs: string | undefined,
  relatedIssues: RelatedIssue[] = [],
): Promise<void> {
  if (relatedIssues.length === 0) return;
  if (!closedMessageTs) {
    console.error(`Slack did not return a timestamp for the task closed message in ${channel}.`);
    return;
  }

  try {
    await client.chat.postMessage({
      channel,
      thread_ts: closedMessageTs,
      text: buildRelatedIssuesMessage(relatedIssues),
      blocks: buildRelatedIssuesMessageBlocks(relatedIssues),
    });
  } catch (error) {
    console.error("Failed to post related issues:", error);
  }
}
