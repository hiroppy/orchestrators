import { App } from "@slack/bolt";
import {
  ErrorCode,
  type ChatGetPermalinkArguments,
  type ChatGetPermalinkResponse,
  type ChatPostMessageArguments,
  type ChatPostMessageResponse,
  type ChatUpdateArguments,
  type ChatUpdateResponse,
  type UsersInfoArguments,
  type UsersInfoResponse,
} from "@slack/web-api";

import { TASK_STATUS_ACTION_ID, taskIdFromBlockId } from "./interactions.ts";
import {
  buildStatusChangedMessage,
  buildRelatedIssueMessage,
  buildTaskCard,
  buildTaskClosedMessage,
  buildThreadMessage,
  buildThreadMessageBlocks,
} from "./views.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";
import type { RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";
import type { ResolvedMentionConfig } from "../config/runtime.ts";

export type LinearStatusUpdater = (task: Task, status: string) => Promise<void>;
export type LinearWorkpadReplier = (
  task: Task,
  body: string,
  idempotencyKey: string,
) => Promise<boolean>;
const taskStatusQueues = new Map<string, Promise<void>>();
const threadReplyQueues = new Map<string, Promise<void>>();

export interface SlackAppOptions {
  botToken: string;
  appToken: string;
  mention?: ResolvedMentionConfig;
  updateLinearStatus: LinearStatusUpdater;
  createLinearWorkpadReply: LinearWorkpadReplier;
  store: WatcherStore;
}

export function createSlackApp({
  botToken,
  appToken,
  mention,
  updateLinearStatus,
  createLinearWorkpadReply,
  store,
}: SlackAppOptions): App {
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  registerStatusAction(app, store, updateLinearStatus, mention);
  app.message(async (args) => {
    await handleThreadReply(args, store, createLinearWorkpadReply);
  });
  return app;
}

export async function handleThreadReply(
  { message, client, logger }: MessageArguments,
  store: WatcherStore,
  createLinearWorkpadReply: LinearWorkpadReplier,
): Promise<void> {
  if (!isUserThreadReply(message)) return;

  const task = store.getTaskBySlackThread(message.channel, message.thread_ts);
  if (!task) return;

  const queueKey = `${message.channel}:${message.thread_ts}`;
  await withQueue(threadReplyQueues, queueKey, async () => {
    const replyRecorded = store.hasRecordedSlackMessage(task.id, message.ts, "workpad_replied");

    if (!replyRecorded) {
      try {
        const created = await createLinearWorkpadReply(
          task,
          message.text,
          `${message.channel}:${message.ts}`,
        );
        if (!created) return;

        store.addEvent({
          taskId: task.id,
          type: "workpad_replied",
          actor: message.user,
          body: message.text,
          slackThreadTs: message.ts,
        });
      } catch (error) {
        logger.error(error);
        return;
      }
    }

    if (store.hasRecordedSlackMessage(task.id, message.ts, "workpad_reply_acknowledged")) {
      return;
    }

    try {
      await addCopiedReplyReaction(client, message);
      store.addEvent({
        taskId: task.id,
        type: "workpad_reply_acknowledged",
        actor: message.user,
        slackThreadTs: message.ts,
      });
    } catch (error) {
      logger.error(error);
    }
  });
}

function registerStatusAction(
  app: App,
  store: WatcherStore,
  updateLinearStatus: LinearStatusUpdater,
  mention?: ResolvedMentionConfig,
): void {
  app.action(TASK_STATUS_ACTION_ID, async (args) => {
    await handleStatusAction(args, store, updateLinearStatus, mention);
  });
}

export async function handleStatusAction(
  { ack, action, body, client, logger }: StatusActionArguments,
  store: WatcherStore,
  updateLinearStatus: LinearStatusUpdater,
  mention?: ResolvedMentionConfig,
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
      const mentionTarget = mentionForStatusTransition(
        mention,
        existingTask.status,
        selectedStatus,
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
        mentionTarget,
      );
      await updateLinearStatus(existingTask, selectedStatus);
      await client.chat.update({
        channel: existingTask.parentChannelId,
        ts: existingTask.parentMessageTs,
        ...card,
      });
      const { task, fromStatus } = store.updateTaskStatus(taskId, selectedStatus);
      store.setRenderedSummary(task.id, JSON.stringify(card));

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

async function withQueue<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  queues.set(key, queued);

  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (queues.get(key) === queued) {
      queues.delete(key);
    }
  }
}

export async function publishWatcherEvent(
  client: SlackClient,
  store: WatcherStore,
  destinationChannel: string,
  event: WatcherEvent,
  mention?: ResolvedMentionConfig,
): Promise<void> {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  const previousTask = store.getTask(taskId);
  const isNewPullRequest =
    event.pullRequest !== undefined && !store.hasRecordedPullRequest(taskId, event.pullRequest.url);
  let task = store.upsertTaskFromEvent(event);
  const mentionTarget = mentionTargetForWatcherEvent(
    mention,
    previousTask?.status,
    task.status,
    event.type,
  );
  const card = buildTaskCard(
    task,
    store.getSelectableStatuses(task.serviceName),
    event,
    mentionTarget,
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
        const closedMessage = await postParentPermalink(
          client,
          task.parentChannelId,
          task.parentMessageTs,
          task.status,
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

  const statusChanged =
    previousTask !== undefined &&
    normalizeStatus(previousTask.status) !== normalizeStatus(task.status);
  const threadEvent =
    isNewPullRequest || statusChanged ? event : { ...event, pullRequest: undefined };
  const threadContext = {
    fromStatus: previousTask?.status,
    toStatus: task.status,
    updatedAt: task.updatedAt,
  };
  const threadBody = buildThreadMessage(threadEvent, mentionTarget, threadContext);
  const threadBlocks = buildThreadMessageBlocks(threadEvent, mentionTarget, threadContext);
  const reply = shouldPostThreadMessage(statusChanged, isNewPullRequest, mentionTarget)
    ? await client.chat.postMessage({
        channel: task.parentChannelId!,
        thread_ts: task.parentMessageTs!,
        text: threadBody,
        ...(threadBlocks ? { blocks: threadBlocks } : {}),
      })
    : undefined;
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

async function postParentPermalink(
  client: SlackClient,
  channel: string,
  messageTs: string,
  status: string,
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

  for (const issue of relatedIssues) {
    try {
      await client.chat.postMessage({
        channel,
        thread_ts: closedMessageTs,
        text: buildRelatedIssueMessage(issue),
      });
    } catch (error) {
      console.error(`Failed to post related issue ${issue.identifier}:`, error);
    }
  }
}

export function mentionTargetForWatcherEvent(
  mention: ResolvedMentionConfig | undefined,
  previousStatus: string | undefined,
  currentStatus: string,
  eventType: WatcherEvent["type"],
): string | undefined {
  if (!mention) return undefined;
  return enteredMentionStatus(mention, previousStatus, currentStatus) ||
    mention.events.includes(eventType)
    ? mention.target
    : undefined;
}

function mentionForStatusTransition(
  mention: ResolvedMentionConfig | undefined,
  previousStatus: string,
  currentStatus: string,
): string | undefined {
  return mention && enteredMentionStatus(mention, previousStatus, currentStatus)
    ? mention.target
    : undefined;
}

function enteredMentionStatus(
  mention: ResolvedMentionConfig,
  previousStatus: string | undefined,
  currentStatus: string,
): boolean {
  const normalizedCurrent = normalizeStatus(currentStatus);
  return (
    mention.statuses.some((status) => normalizeStatus(status) === normalizedCurrent) &&
    normalizeStatus(previousStatus) !== normalizedCurrent
  );
}

function normalizeStatus(status?: string): string | undefined {
  return status?.trim().toLowerCase();
}

export async function publishWatcherStarted(
  client: SlackClient,
  destinationChannel: string,
  serviceNames: string[],
): Promise<void> {
  const serviceLabel = serviceNames.length === 1 ? "service" : "services";
  const heading = `Watcher started | monitoring ${serviceNames.length} ${serviceLabel}`;
  await client.chat.postMessage({
    channel: destinationChannel,
    text: [heading, ...serviceNames.map((name) => `- ${name}`)].join("\n"),
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              {
                type: "text",
                text: heading,
              },
            ],
          },
          {
            type: "rich_text_list",
            style: "bullet",
            elements: serviceNames.map((name) => ({
              type: "rich_text_section",
              elements: [{ type: "text", text: name }],
            })),
          },
        ],
      },
    ],
  });
}

function shouldPostThreadMessage(
  statusChanged: boolean,
  isNewPullRequest: boolean,
  mentionTarget?: string,
): boolean {
  return statusChanged || isNewPullRequest || Boolean(mentionTarget);
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

export interface SlackClient {
  chat: {
    getPermalink(args: ChatGetPermalinkArguments): Promise<ChatGetPermalinkResponse>;
    postMessage(args: ChatPostMessageArguments): Promise<ChatPostMessageResponse>;
    update(args: ChatUpdateArguments): Promise<ChatUpdateResponse>;
  };
  users?: {
    info(args: UsersInfoArguments): Promise<UsersInfoResponse>;
  };
}

interface StatusActionArguments {
  ack: () => Promise<unknown>;
  action: unknown;
  body: unknown;
  client: SlackClient;
  logger: { error(error: unknown): void };
}

interface MessageArguments {
  message: unknown;
  client: {
    reactions: {
      add(args: { channel: string; name: string; timestamp: string }): Promise<unknown>;
    };
  };
  logger: { error(error: unknown): void };
}

interface UserThreadReply {
  channel: string;
  thread_ts: string;
  ts: string;
  user: string;
  text: string;
}

async function addCopiedReplyReaction(
  client: MessageArguments["client"],
  message: UserThreadReply,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.reactions.add({
        channel: message.channel,
        name: "white_check_mark",
        timestamp: message.ts,
      });
      return;
    } catch (error) {
      if (slackError(error) === "already_reacted") return;
      if (attempt >= 3 || !isTransientSlackError(error)) throw error;
    }
  }
}

function slackError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : undefined;
}

function isTransientSlackError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: unknown; statusCode?: unknown };
  if (details.code === ErrorCode.RequestError || details.code === ErrorCode.RateLimitedError) {
    return true;
  }
  if (details.code === ErrorCode.HTTPError) {
    return typeof details.statusCode !== "number" || details.statusCode >= 500;
  }
  return (
    details.code === ErrorCode.PlatformError &&
    ["fatal_error", "internal_error", "request_timeout", "service_unavailable"].includes(
      slackError(error) ?? "",
    )
  );
}

function isUserThreadReply(message: unknown): message is UserThreadReply {
  if (!message || typeof message !== "object") return false;

  const event = message as Record<string, unknown>;
  return (
    typeof event.channel === "string" &&
    typeof event.thread_ts === "string" &&
    typeof event.ts === "string" &&
    typeof event.user === "string" &&
    typeof event.text === "string" &&
    event.text.trim().length > 0 &&
    (event.subtype === undefined ||
      event.subtype === "thread_broadcast" ||
      event.subtype === "file_share") &&
    event.bot_id === undefined
  );
}

function selectedStatusFromAction(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const selectedOption = (action as { selected_option?: { value?: unknown } }).selected_option;
  return typeof selectedOption?.value === "string" ? selectedOption.value : undefined;
}

async function resolveSlackDisplayName(
  client: SlackClient,
  user?: StatusActionBody["user"],
  logger?: StatusActionArguments["logger"],
): Promise<string> {
  const fallback = user?.id ?? "Unknown user";
  if (!user?.id || !client.users) return fallback;

  try {
    const response = await client.users.info({ user: user.id });
    return (
      response.user?.profile?.display_name ||
      response.user?.real_name ||
      response.user?.name ||
      fallback
    );
  } catch (error) {
    logger?.error(
      new Error(
        `Failed to resolve Slack display name for ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return fallback;
  }
}
