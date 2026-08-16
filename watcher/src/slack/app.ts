import { App } from "@slack/bolt";
import type { ChatPostMessageResponse } from "@slack/web-api";

import { TASK_STATUS_ACTION_ID, taskIdFromBlockId } from "./interactions.ts";
import {
  buildStatusChangedMessage,
  buildRelatedIssuesMessage,
  buildRelatedIssuesMessageBlocks,
  buildTaskCard,
  buildTaskClosedMessage,
  buildTaskClosedMessageBlocks,
  buildThreadMessage,
  buildThreadMessageBlocks,
  parentEventLabel,
  type StatusSummaryContext,
} from "./views.ts";
import { taskIdFor, type TaskEventInput, type WatcherStore } from "../persistence/store.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";
import type { RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";
import { normalizeStatus } from "../domain/status.ts";
import { slackAssigneeIdFromMention } from "../domain/slack-assignee.ts";
import { initialTaskAssignees } from "./notifications.ts";
import { withTaskCardQueue } from "./task-card-queue.ts";
import { handleAppMention } from "./mention-commands.ts";
import { handleThreadReply, type LinearWorkpadReplier } from "./thread-reply-handler.ts";
import { resolveSlackAssigneeLabels, resolveSlackDisplayName } from "./users.ts";
import { postSlackOperationError } from "./errors.ts";
import { escapeSlack } from "./view-formatting.ts";
import type { SlackClient } from "./client-types.ts";
import { publishStatusTimeline, reloadStatusTimeline } from "./status-timeline.ts";
import {
  handleTakePrAction,
  TAKE_PR_CONFIRM_ACTION_ID,
  TAKE_PR_SERVICE_ACTION_ID,
  type TakePrOptions,
} from "./take-pr.ts";

export * from "./client-types.ts";
export * from "./notifications.ts";
export { handleAppMention } from "./mention-commands.ts";
export * from "./thread-reply-handler.ts";

export type LinearStatusUpdater = (task: Task, status: string) => Promise<void>;
export type StatusTransitionHandler = (
  task: Task,
  fromStatus: string,
  toStatus: string,
  client: SlackClient,
) => Promise<void>;
export type StatusTransitionEventFactory = (
  task: Task,
  fromStatus: string,
  toStatus: string,
) => TaskEventInput | undefined;

export interface SlackAppOptions {
  botToken: string;
  appToken: string;
  updateLinearStatus: LinearStatusUpdater;
  createLinearWorkpadReply: LinearWorkpadReplier;
  store: WatcherStore;
  botUserId: string;
  createStatusTransitionEvent?: StatusTransitionEventFactory;
  onStatusTransition?: StatusTransitionHandler;
  takePr: TakePrOptions;
  statusSummary: StatusSummaryContext;
}

export function createSlackApp({
  botToken,
  appToken,
  updateLinearStatus,
  createLinearWorkpadReply,
  store,
  botUserId,
  createStatusTransitionEvent,
  onStatusTransition,
  takePr,
  statusSummary,
}: SlackAppOptions): App {
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });
  registerStatusAction(
    app,
    store,
    updateLinearStatus,
    createStatusTransitionEvent,
    onStatusTransition,
  );
  app.action(TAKE_PR_SERVICE_ACTION_ID, async ({ ack }) => {
    await ack();
  });
  app.action(TAKE_PR_CONFIRM_ACTION_ID, async (args) => {
    await handleTakePrAction(args, store, takePr);
  });
  app.event("app_mention", async (args) => {
    await handleAppMention(args, store, botUserId, takePr, statusSummary);
  });
  app.message(async (args) => {
    await handleThreadReply(args, store, createLinearWorkpadReply, botUserId);
  });
  return app;
}

function registerStatusAction(
  app: App,
  store: WatcherStore,
  updateLinearStatus: LinearStatusUpdater,
  createStatusTransitionEvent?: StatusTransitionEventFactory,
  onStatusTransition?: StatusTransitionHandler,
): void {
  app.action(TASK_STATUS_ACTION_ID, async (args) => {
    await handleStatusAction(
      args,
      store,
      updateLinearStatus,
      onStatusTransition,
      createStatusTransitionEvent,
    );
  });
}

export async function handleStatusAction(
  { ack, action, body, client, logger }: StatusActionArguments,
  store: WatcherStore,
  updateLinearStatus: LinearStatusUpdater,
  onStatusTransition?: StatusTransitionHandler,
  createStatusTransitionEvent?: StatusTransitionEventFactory,
): Promise<void> {
  await ack();

  try {
    const selectedStatus = selectedStatusFromAction(action);
    const actionBody = body as StatusActionBody;
    const taskId =
      actionBody.message?.metadata?.event_payload?.task_id ??
      taskIdFromBlockId(actionBody.actions?.[0]?.block_id);
    const actor = actionBody.user?.id;

    if (!selectedStatus) throw new Error("Slack action did not include a selected status.");
    if (!taskId) throw new Error("Slack action did not include a task ID.");
    if (!actor) throw new Error("Slack action did not include a user ID.");

    const statusTransition = await withTaskCardQueue(taskId, async () => {
      const existingTask = store.getTask(taskId);
      if (!existingTask) throw new Error(`Task not found: ${taskId}`);
      const configuredStatuses = store.getSelectableStatuses(existingTask.serviceName);
      if (!configuredStatuses.includes(selectedStatus)) {
        throw new Error(
          `Status is not configured for ${existingTask.serviceName}: ${selectedStatus}`,
        );
      }
      if (existingTask.status === selectedStatus) return;
      if (!existingTask.parentChannelId || !existingTask.parentMessageTs) {
        throw new Error(`Task has no Slack parent message: ${taskId}`);
      }
      const assigneeLabels = await resolveSlackAssigneeLabels(
        client,
        store.getTaskAssignees(taskId),
        logger,
      );
      const card = buildTaskCard(
        {
          ...existingTask,
          status: selectedStatus,
          updatedAt: new Date().toISOString(),
        },
        configuredStatuses,
        {
          type: "updated",
          service: existingTask.serviceName,
          issueIdentifier: existingTask.issueIdentifier,
          resolvedState: selectedStatus,
        },
        assigneeLabels,
      );
      try {
        await updateLinearStatus(existingTask, selectedStatus);
      } catch (error) {
        await postSlackOperationError(
          client,
          {
            channel: existingTask.parentChannelId,
            threadTs: existingTask.parentMessageTs,
          },
          `Failed to confirm the Linear status update to ${escapeSlack(selectedStatus)}. The watcher still shows ${escapeSlack(existingTask.status)}; the Linear status may have changed. ${linearStatusErrorDetails(error)} Please check Linear before trying again.`,
          logger,
        );
        throw error;
      }
      await client.chat.update({
        channel: existingTask.parentChannelId,
        ts: existingTask.parentMessageTs,
        ...card,
      });
      const { task, fromStatus } = store.updateTaskStatusAtomically(
        taskId,
        selectedStatus,
        (updatedTask, previousStatus) =>
          createStatusTransitionEvent?.(updatedTask, previousStatus, selectedStatus),
      );
      store.setRenderedSummary(task.id, JSON.stringify(card));
      const actorDisplayName = await resolveSlackDisplayName(client, actionBody.user, logger);
      const statusChangedLine = buildStatusChangedMessage(
        actorDisplayName,
        fromStatus,
        selectedStatus,
      );
      await publishStatusTimeline(client, store, {
        taskId: task.id,
        event: {
          fromStatus,
          toStatus: selectedStatus,
          occurredAt: new Date().toISOString(),
          source: { type: "manual", actor: { id: actor, label: actorDisplayName } },
        },
        fallbackText: statusChangedLine,
      });
      store.addEvent({
        taskId: task.id,
        type: "status_changed",
        actor,
        fromStatus,
        toStatus: selectedStatus,
        body: statusChangedLine,
      });
      return { task, fromStatus };
    });
    if (statusTransition) {
      await onStatusTransition?.(
        statusTransition.task,
        statusTransition.fromStatus,
        selectedStatus,
        client,
      );
    }
  } catch (error) {
    logger.error(error);
  }
}

function linearStatusErrorDetails(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^Linear returned HTTP \d{3}\.$/.test(message)
    ? `Error: ${message}`
    : "See the watcher logs for error details.";
}

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

    const statusEvent = { ...event, pullRequest: undefined };
    const threadContext = {
      fromStatus: previousTask?.status,
      toStatus: task.status,
    };
    const statusBody = buildThreadMessage(statusEvent, threadContext);
    const needsTimelineAnchor =
      store.getLatestEventsByType(task.id, "status_timeline", 1).length === 0;
    if (activityCleared) store.setTaskActivity(task.id, undefined);
    try {
      if (statusChanged || needsTimelineAnchor) {
        await publishStatusTimeline(client, store, {
          taskId: task.id,
          event: {
            fromStatus: previousTask?.status ?? task.status,
            toStatus: task.status,
            occurredAt: new Date().toISOString(),
            source: {
              type: "automatic",
              label: parentEventLabel(statusEvent),
              error: statusEvent.error,
            },
          },
          fallbackText: statusBody,
        });
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

interface StatusActionBody {
  user?: { id?: string; name?: string; username?: string };
  message?: {
    metadata?: {
      event_payload?: { task_id?: string };
    };
  };
  actions?: Array<{ block_id?: string }>;
}

interface StatusActionArguments {
  ack: () => Promise<unknown>;
  action: unknown;
  body: unknown;
  client: SlackClient;
  logger: { error(error: unknown): void };
}

function selectedStatusFromAction(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const selectedOption = (action as { selected_option?: { value?: unknown } }).selected_option;
  return typeof selectedOption?.value === "string" ? selectedOption.value : undefined;
}
