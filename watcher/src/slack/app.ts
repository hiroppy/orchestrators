import { App } from "@slack/bolt";
import type { ChatPostMessageResponse } from "@slack/web-api";

import { TASK_STATUS_ACTION_ID, taskIdFromBlockId } from "./interactions.ts";
import {
  buildStatusChangedMessage,
  buildStatusChangedMessageBlocks,
  buildRelatedIssuesMessage,
  buildRelatedIssuesMessageBlocks,
  buildTaskCard,
  buildTaskClosedMessage,
  buildTaskClosedMessageBlocks,
  buildThreadMessage,
  buildThreadMessageBlocks,
  buildWatcherStartedMessage,
  buildWatcherStartedMessageBlocks,
} from "./views.ts";
import { taskIdFor, type TaskEventInput, type WatcherStore } from "../persistence/store.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";
import type { RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";
import type { ResolvedMentionConfig } from "../config/runtime.ts";
import { withQueue } from "./async-queue.ts";
import { notificationTargetsForWatcherEvent } from "./notifications.ts";
import { handleAppMention } from "./mention-commands.ts";
import { handleThreadReply, type LinearWorkpadReplier } from "./thread-reply-handler.ts";
import { resolveSlackDisplayName } from "./users.ts";
import type { SlackClient } from "./client-types.ts";

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
const taskStatusQueues = new Map<string, Promise<void>>();

export interface SlackAppOptions {
  botToken: string;
  appToken: string;
  updateLinearStatus: LinearStatusUpdater;
  createLinearWorkpadReply: LinearWorkpadReplier;
  store: WatcherStore;
  botUserId: string;
  configuredMentionTargets?: string[];
  createStatusTransitionEvent?: StatusTransitionEventFactory;
  onStatusTransition?: StatusTransitionHandler;
}

export function createSlackApp({
  botToken,
  appToken,
  updateLinearStatus,
  createLinearWorkpadReply,
  store,
  botUserId,
  configuredMentionTargets = [],
  createStatusTransitionEvent,
  onStatusTransition,
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
  app.event("app_mention", async (args) => {
    await handleAppMention(args, store, configuredMentionTargets);
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

    await withTaskStatusQueue(taskId, async () => {
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
      const mentionTarget = undefined;

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
        mentionTarget,
      );
      await updateLinearStatus(existingTask, selectedStatus);
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
      await onStatusTransition?.(task, fromStatus, selectedStatus, client);

      const actorDisplayName = await resolveSlackDisplayName(client, actionBody.user, logger);
      const statusChangedLine = buildStatusChangedMessage(
        actorDisplayName,
        fromStatus,
        selectedStatus,
      );
      const historyLine = [statusChangedLine, mentionTarget].filter(Boolean).join(" | ");
      const reply = await client.chat.postMessage({
        channel: existingTask.parentChannelId,
        thread_ts: existingTask.parentMessageTs,
        text: historyLine,
        blocks: buildStatusChangedMessageBlocks(actorDisplayName, fromStatus, selectedStatus),
      });
      store.addEvent({
        taskId: task.id,
        type: "status_changed",
        actor,
        fromStatus,
        toStatus: selectedStatus,
        body: historyLine,
        slackThreadTs: reply.ts,
      });
    });
  } catch (error) {
    logger.error(error);
  }
}

async function withTaskStatusQueue<T>(taskId: string, run: () => Promise<T>): Promise<T> {
  return withQueue(taskStatusQueues, taskId, run);
}

export async function publishWatcherEvent(
  client: SlackClient,
  store: WatcherStore,
  destinationChannel: string,
  event: WatcherEvent,
  mention?: ResolvedMentionConfig,
  options: {
    forceMention?: boolean;
    onStatusTransition?: (task: Task, fromStatus: string) => Promise<void>;
    createStatusTransitionEvent?: (task: Task, fromStatus: string) => TaskEventInput | undefined;
    afterPublish?: (task: Task) => Promise<void>;
  } = {},
): Promise<void> {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  const isNewPullRequest =
    event.pullRequest !== undefined && !store.hasRecordedPullRequest(taskId, event.pullRequest.url);
  const { task: persistedTask, previousTask } = store.upsertTaskFromEventAtomically(
    event,
    (task, previous) =>
      previous && normalizeStatus(previous.status) !== normalizeStatus(task.status)
        ? options.createStatusTransitionEvent?.(task, previous.status)
        : undefined,
  );
  let task = persistedTask;
  const statusChanged =
    previousTask !== undefined &&
    normalizeStatus(previousTask.status) !== normalizeStatus(task.status);
  if (statusChanged) {
    await options.onStatusTransition?.(task, previousTask.status);
  }
  const notifications = notificationTargetsForWatcherEvent(
    mention,
    previousTask?.status,
    task.status,
    event.type,
    event.creatorMention ?? undefined,
    options.forceMention,
    store.getTaskNotificationMentions(taskId),
  );
  const card = buildTaskCard(
    task,
    store.getSelectableStatuses(task.serviceName),
    event,
    notifications?.creator,
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

  const threadEvent =
    isNewPullRequest || statusChanged ? event : { ...event, pullRequest: undefined };
  const threadContext = {
    fromStatus: previousTask?.status,
    toStatus: task.status,
  };
  const notificationContext = { ...threadContext, mentions: notifications?.mentions };
  const threadBody = buildThreadMessage(threadEvent, notifications?.creator, notificationContext);
  const threadBlocks = buildThreadMessageBlocks(
    threadEvent,
    notifications?.creator,
    notificationContext,
  );
  const reply = shouldPostThreadMessage(statusChanged, isNewPullRequest, Boolean(notifications))
    ? await client.chat.postMessage({
        channel: task.parentChannelId!,
        thread_ts: task.parentMessageTs!,
        text: threadBody,
        ...(threadBlocks ? { blocks: threadBlocks } : {}),
      })
    : undefined;
  await options.afterPublish?.(task);
  store.addEvent({
    taskId: task.id,
    type: event.type,
    actor: "watcher",
    fromStatus: previousTask?.status,
    toStatus: task.status,
    body: threadBody,
    slackThreadTs: reply?.ts,
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
    text: buildTaskClosedMessage(status, response.permalink),
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

export async function publishWatcherStarted(
  client: SlackClient,
  destinationChannel: string,
  serviceNames: string[],
): Promise<void> {
  await client.chat.postMessage({
    channel: destinationChannel,
    text: buildWatcherStartedMessage(serviceNames),
    blocks: buildWatcherStartedMessageBlocks(serviceNames),
  });
}

function shouldPostThreadMessage(
  statusChanged: boolean,
  isNewPullRequest: boolean,
  hasNotifications: boolean,
): boolean {
  return statusChanged || isNewPullRequest || hasNotifications;
}

function normalizeStatus(status?: string): string | undefined {
  return status?.trim().toLowerCase();
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
