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
  buildStatusChangedMessageBlocks,
  buildStatusSummary,
  buildStatusSummaryBlocks,
  buildRelatedIssuesMessage,
  buildRelatedIssuesMessageBlocks,
  buildTaskCard,
  buildTaskClosedMessage,
  buildTaskClosedMessageBlocks,
  buildThreadMessage,
  buildThreadMessageBlocks,
  buildWatcherStartedMessage,
  buildWatcherStartedMessageBlocks,
  STATUS_SUMMARY_STATUSES,
} from "./views.ts";
import { taskIdFor, type TaskEventInput, type WatcherStore } from "../persistence/store.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";
import type { RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";
import type { ResolvedMentionConfig } from "../config/runtime.ts";

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
interface SlackReplyFile {
  filename: string;
  contentType: string;
  downloadUrl: string;
  size: number;
}

export interface SlackThreadReply {
  text: string;
  files: SlackReplyFile[];
  authorName: string;
}

export type LinearWorkpadReplier = (
  task: Task,
  reply: SlackThreadReply,
  idempotencyKey: string,
) => Promise<boolean>;
const taskStatusQueues = new Map<string, Promise<void>>();
const threadReplyQueues = new Map<string, Promise<void>>();
const SUPPORTED_FILE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const STATUS_COMMAND_STATUS_NAMES = new Set(STATUS_SUMMARY_STATUSES.map(normalizeStatus));
const MAX_NOTIFICATION_MENTIONS_LENGTH = 2_000 - "*Mentions*\n".length;
type MentionCommandHandler = (context: MentionCommandContext) => Promise<void>;
const mentionCommandHandlers: Record<string, MentionCommandHandler> = {
  assign: handleAssignCommand,
  status: handleStatusCommand,
};

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

export async function handleAppMention(
  { event, client, logger }: AppMentionArguments,
  store: WatcherStore,
  configuredMentionTargets: string[] = [],
): Promise<void> {
  const mention = parseMentionCommand(event);
  if (!mention) return;
  const handler = mentionCommandHandlers[mention.command];
  if (!handler) return;

  try {
    await handler({
      event: mention.event,
      client,
      logger,
      store,
      args: mention.args,
      configuredMentionTargets,
    });
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      {
        channel: mention.event.channel,
        threadTs: mention.event.threadTs,
      },
      "Failed to load the current task status.",
      logger,
    );
  }
}

function parseMentionCommand(
  event: unknown,
): { event: AppMentionEvent; command: string; args: string[] } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as Record<string, unknown>;
  if (
    typeof value.channel !== "string" ||
    typeof value.ts !== "string" ||
    typeof value.text !== "string" ||
    value.bot_id !== undefined
  ) {
    return undefined;
  }

  const [command, ...args] = value.text
    .replace(/<@[A-Z0-9]+>/i, " ")
    .trim()
    .split(/\s+/);
  if (!command) return undefined;
  return {
    event: {
      channel: value.channel,
      ts: value.ts,
      text: value.text,
      ...(typeof value.user === "string" ? { user: value.user } : {}),
      ...(typeof value.thread_ts === "string" ? { threadTs: value.thread_ts } : {}),
    },
    command: command.toLowerCase(),
    args,
  };
}

async function handleAssignCommand({
  event,
  client,
  store,
  args,
  configuredMentionTargets,
}: MentionCommandContext): Promise<void> {
  const threadTs = event.threadTs;
  if (!threadTs) return;

  const task = store.getTaskBySlackThread(event.channel, threadTs);
  if (!task) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "Run `assign` from a tracked task thread.",
    );
    return;
  }

  const slackUserId = args.length === 1 ? slackUserIdFromMention(args[0]) : undefined;
  if (!slackUserId) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "Usage: `@Orchestrators assign @user`",
    );
    return;
  }
  if (event.user !== slackUserId) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "You can only assign yourself to task notifications.",
    );
    return;
  }

  const assignedMentions = store.getTaskNotificationMentions(task.id);
  const slackMention = `<@${slackUserId}>`;
  const alreadyAssigned = assignedMentions.includes(slackMention);
  const combinedTargets = [
    ...new Set([...configuredMentionTargets, ...assignedMentions, slackMention]),
  ];
  if (!alreadyAssigned && combinedTargets.join(" ").length > MAX_NOTIFICATION_MENTIONS_LENGTH) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Cannot assign ${slackMention}: configured notification mentions reached Slack's text limit.`,
    );
    return;
  }

  if (!alreadyAssigned) store.assignTaskNotificationMention(task.id, slackUserId);
  await addSuccessReaction(client, {
    channel: event.channel,
    timestamp: event.ts,
  });
}

function slackUserIdFromMention(value: string | undefined): string | undefined {
  return value?.match(/^<@([A-Z0-9]+)>$/i)?.[1];
}

async function handleStatusCommand({
  event,
  client,
  logger,
  store,
  args,
}: MentionCommandContext): Promise<void> {
  if (args.length > 0) return;

  const tasks = store
    .getTasksForLinearSync()
    .filter((task) => STATUS_COMMAND_STATUS_NAMES.has(normalizeStatus(task.status)));
  const slackLinks = new Map<string, string>();

  await Promise.all(
    tasks.map(async (task) => {
      if (task.parentChannelId && task.parentMessageTs) {
        try {
          const response = await client.chat.getPermalink({
            channel: task.parentChannelId,
            message_ts: task.parentMessageTs,
          });
          if (response.permalink) slackLinks.set(task.id, response.permalink);
        } catch (error) {
          logger.error(error);
        }
      }
    }),
  );

  await client.chat.postMessage({
    channel: event.channel,
    text: buildStatusSummary(tasks, slackLinks),
    blocks: buildStatusSummaryBlocks(tasks, slackLinks),
    unfurl_links: false,
    unfurl_media: false,
  });
}

export async function handleThreadReply(
  { message, client, logger }: MessageArguments,
  store: WatcherStore,
  createLinearWorkpadReply: LinearWorkpadReplier,
  botUserId?: string,
): Promise<void> {
  const reply = parseUserThreadReply(message, botUserId);
  if (!reply) return;

  const task = store.getTaskBySlackThread(reply.channel, reply.thread_ts);
  if (!task) return;

  const queueKey = `${reply.channel}:${reply.thread_ts}`;
  await withQueue(threadReplyQueues, queueKey, async () => {
    const replyRecorded = store.hasRecordedSlackMessage(task.id, reply.ts, "workpad_replied");

    if (!replyRecorded) {
      try {
        const authorName = await resolveSlackDisplayName(client, { id: reply.user }, logger);
        const created = await createLinearWorkpadReply(
          task,
          {
            text: reply.text,
            authorName,
            files: reply.files.map((file) => ({
              filename: file.name,
              contentType: file.mimetype,
              downloadUrl: file.url_private_download ?? file.url_private,
              size: file.size,
            })),
          },
          `${reply.channel}:${reply.ts}`,
        );
        if (!created) {
          await postLinearReplyFailure(
            client,
            reply,
            "Linear の転記先 Workpad が見つかりませんでした。",
            logger,
          );
          return;
        }

        store.addEvent({
          taskId: task.id,
          type: "workpad_replied",
          actor: reply.user,
          body: reply.text,
          slackThreadTs: reply.ts,
        });
      } catch (error) {
        logger.error(error);
        await postLinearReplyFailure(client, reply, errorMessage(error), logger);
        return;
      }
    }

    if (store.hasRecordedSlackMessage(task.id, reply.ts, "workpad_reply_acknowledged")) {
      return;
    }

    try {
      await addSuccessReaction(client, {
        channel: reply.channel,
        timestamp: reply.ts,
      });
      store.addEvent({
        taskId: task.id,
        type: "workpad_reply_acknowledged",
        actor: reply.user,
        slackThreadTs: reply.ts,
      });
    } catch (error) {
      logger.error(error);
    }
  });
}

async function postLinearReplyFailure(
  client: MessageArguments["client"],
  reply: UserThreadReply,
  reason: string,
  logger: MessageArguments["logger"],
): Promise<void> {
  await postSlackOperationError(
    client,
    { channel: reply.channel, threadTs: reply.thread_ts },
    `Linear への転記に失敗しました。理由: ${reason}`,
    logger,
  );
}

async function postSlackOperationError(
  client: { chat?: Pick<SlackClient["chat"], "postMessage"> },
  message: { channel: string; threadTs?: string },
  reason: string,
  logger?: { error(error: unknown): void },
): Promise<void> {
  if (!client.chat) return;

  try {
    await client.chat.postMessage({
      channel: message.channel,
      ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
      text: `[error] ${reason}`,
    });
  } catch (error) {
    if (logger) logger.error(error);
    else throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    blocks: buildTaskClosedMessageBlocks(status, response.permalink),
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

export function notificationTargetsForWatcherEvent(
  mention: ResolvedMentionConfig | undefined,
  previousStatus: string | undefined,
  currentStatus: string,
  eventType: WatcherEvent["type"],
  creatorMention?: string,
  force = false,
  taskMentions: string[] = [],
): { creator?: string; mentions: string[] } | undefined {
  if (!notificationIsEligible(mention, previousStatus, currentStatus, eventType, force)) {
    return undefined;
  }
  const targets = [...new Set([...taskMentions, ...(mention?.targets ?? [])])];
  if (!creatorMention && targets.length === 0) return undefined;
  return { creator: creatorMention, mentions: targets };
}

export function notificationIsEligible(
  mention: ResolvedMentionConfig | undefined,
  previousStatus: string | undefined,
  currentStatus: string,
  eventType: WatcherEvent["type"],
  force = false,
): boolean {
  if (force) return true;
  if (!mention) return false;
  return (
    enteredMentionStatus(mention, previousStatus, currentStatus) ||
    mention.events.includes(eventType)
  );
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
  client: ReactionClient & {
    chat?: Pick<SlackClient["chat"], "postMessage">;
    users?: SlackClient["users"];
  };
  logger: { error(error: unknown): void };
}

interface AppMentionEvent {
  channel: string;
  ts: string;
  text: string;
  user?: string;
  threadTs?: string;
}

interface AppMentionArguments {
  event: unknown;
  client: Pick<SlackClient, "chat"> & ReactionClient;
  logger: { error(error: unknown): void };
}

interface MentionCommandContext {
  event: AppMentionEvent;
  client: Pick<SlackClient, "chat"> & ReactionClient;
  logger: { error(error: unknown): void };
  store: WatcherStore;
  args: string[];
  configuredMentionTargets: string[];
}

interface UserThreadReply {
  channel: string;
  thread_ts: string;
  ts: string;
  user: string;
  text: string;
  files: SlackFile[];
}

interface SlackFile {
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
  url_private_download?: string;
}

async function addSuccessReaction(
  client: ReactionClient,
  message: { channel: string; timestamp: string },
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.reactions.add({
        channel: message.channel,
        name: "white_check_mark",
        timestamp: message.timestamp,
      });
      return;
    } catch (error) {
      if (slackError(error) === "already_reacted") return;
      if (attempt >= 3 || !isTransientSlackError(error)) throw error;
      await sleep(slackRetryDelayMs(error));
    }
  }
}

interface ReactionClient {
  reactions: {
    add(args: { channel: string; name: string; timestamp: string }): Promise<unknown>;
  };
}

function slackRetryDelayMs(error: unknown): number {
  if (!error || typeof error !== "object") return 100;
  const details = error as { code?: unknown; retryAfter?: unknown };
  return details.code === ErrorCode.RateLimitedError && typeof details.retryAfter === "number"
    ? details.retryAfter * 1000
    : 100;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUserThreadReply(message: unknown, botUserId?: string): UserThreadReply | undefined {
  if (!message || typeof message !== "object") return undefined;

  const event = message as Record<string, unknown>;
  const files = Array.isArray(event.files) ? event.files.filter(isSupportedSlackFile) : [];
  const isSupportedSubtype =
    event.subtype === undefined ||
    event.subtype === "thread_broadcast" ||
    event.subtype === "file_share";
  if (
    typeof event.channel !== "string" ||
    typeof event.thread_ts !== "string" ||
    typeof event.ts !== "string" ||
    typeof event.user !== "string" ||
    typeof event.text !== "string" ||
    isRecognizedMentionCommand(event.text, botUserId) ||
    (event.text.trim().length === 0 && files.length === 0) ||
    !isSupportedSubtype ||
    event.bot_id !== undefined
  ) {
    return undefined;
  }

  return {
    channel: event.channel,
    thread_ts: event.thread_ts,
    ts: event.ts,
    user: event.user,
    text: event.text,
    files,
  };
}

function isRecognizedMentionCommand(text: string, botUserId?: string): boolean {
  if (!botUserId) return false;
  const match = text.match(/^\s*<@([A-Z0-9]+)>\s+(?:assign|status)(?:\s|$)/i);
  return match?.[1]?.toLowerCase() === botUserId.toLowerCase();
}

function isSupportedSlackFile(file: unknown): file is SlackFile {
  if (!file || typeof file !== "object") return false;

  const value = file as Record<string, unknown>;
  return (
    typeof value.name === "string" &&
    typeof value.mimetype === "string" &&
    SUPPORTED_FILE_CONTENT_TYPES.has(value.mimetype) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.url_private === "string" &&
    (value.url_private_download === undefined || typeof value.url_private_download === "string")
  );
}

function selectedStatusFromAction(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const selectedOption = (action as { selected_option?: { value?: unknown } }).selected_option;
  return typeof selectedOption?.value === "string" ? selectedOption.value : undefined;
}

async function resolveSlackDisplayName(
  client: Pick<SlackClient, "users">,
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
