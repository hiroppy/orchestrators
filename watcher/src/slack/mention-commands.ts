import type { WatcherStore } from "../persistence/store.ts";
import { slackAssigneeIdFromMention } from "../domain/slack-assignee.ts";
import type { Task } from "../domain/types.ts";
import { normalizeStatus } from "../domain/status.ts";
import { addSuccessReaction, type ReactionClient } from "./reactions.ts";
import { postSlackOperationError } from "./errors.ts";
import {
  buildHelpMessage,
  buildHelpMessageBlocks,
  buildStatusSummary,
  buildStatusSummaryBlocks,
  buildTaskCard,
  replaceTaskCardAssignees,
  STATUS_SUMMARY_STATUSES,
  type StatusSummaryContext,
  type TaskCard,
} from "./views.ts";
import type { SlackClient } from "./client-types.ts";
import { resolveSlackAssigneeLabels, resolveSlackDisplayName } from "./users.ts";
import { handleTakePrMention, type TakePrOptions } from "./take-pr.ts";
import { withTaskCardQueue } from "./task-card-queue.ts";
import { reloadStatusTimeline } from "./status-timeline.ts";

const STATUS_NAMES = new Set(STATUS_SUMMARY_STATUSES.map(normalizeStatus));
const MAX_ASSIGNEES_LENGTH = 2_000 - "*Assignees*\n".length;

type CommandHandler = (context: MentionCommandContext) => Promise<void>;
const commandHandlers: Record<string, CommandHandler> = {
  assign: handleAssignCommand,
  help: handleHelpCommand,
  status: handleStatusCommand,
  "take-pr": handleTakePrCommand,
  unassign: handleUnassignCommand,
};

export async function handleAppMention(
  { event, client, logger }: AppMentionArguments,
  store: WatcherStore,
  botUserId?: string,
  takePrOptions?: TakePrOptions,
  statusSummaryContext?: StatusSummaryContext,
): Promise<void> {
  const mention = parseMentionCommand(event, botUserId);
  if (!mention) return;
  const handler = commandHandlers[mention.command];
  if (!handler) return;

  try {
    await handler({
      event: mention.event,
      client,
      logger,
      store,
      args: mention.args,
      takePrOptions,
      statusSummaryContext,
    });
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      {
        channel: mention.event.channel,
        threadTs:
          mention.command === "take-pr"
            ? (mention.event.threadTs ?? mention.event.ts)
            : mention.event.threadTs,
      },
      commandFailureMessage(mention.command),
      logger,
    );
  }
}

function commandFailureMessage(command: string): string {
  if (command === "help") return "Failed to show the available commands.";
  if (command === "take-pr") return "Failed to start take-pr. No Linear issue was created.";
  if (command === "unassign") {
    return "Failed to unassign the user from the task. No assignment was changed.";
  }
  return "Failed to load the current task status.";
}

async function handleTakePrCommand({
  event,
  client,
  logger,
  store,
  args,
  takePrOptions,
}: MentionCommandContext): Promise<void> {
  if (!takePrOptions) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs: event.threadTs ?? event.ts },
      "The take-pr command is not configured.",
    );
    return;
  }
  await handleTakePrMention(event, args, client, logger, store, takePrOptions);
}

function parseMentionCommand(
  event: unknown,
  configuredBotUserId?: string,
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

  const botMentionMatch = configuredBotUserId
    ? value.text.match(new RegExp(`<@(${escapeRegExp(configuredBotUserId)})>`, "i"))
    : value.text.match(/<@([A-Z0-9]+)>/i);
  if (!botMentionMatch) return undefined;
  const [botMention, botUserId] = botMentionMatch;
  const commandText = value.text.slice((botMentionMatch.index ?? 0) + botMention.length);
  const [command, ...args] = commandText.trim().split(/\s+/);
  if (!command) return undefined;
  return {
    event: {
      channel: value.channel,
      ts: value.ts,
      text: value.text,
      botMention,
      botUserId,
      ...(typeof value.user === "string" ? { user: value.user } : {}),
      ...(typeof value.thread_ts === "string" ? { threadTs: value.thread_ts } : {}),
    },
    command: command.toLowerCase(),
    args,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handleAssignCommand({
  event,
  client,
  logger,
  store,
  args,
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

  const slackAssigneeId = args.length === 1 ? slackAssigneeIdFromMention(args[0]) : undefined;
  if (!slackAssigneeId) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Usage: ${event.botMention} \`assign @user-or-group\``,
    );
    return;
  }
  const assignees = store.getTaskAssignees(task.id);
  const slackMention = slackAssigneeId.startsWith("!subteam^")
    ? `<${slackAssigneeId}>`
    : `<@${slackAssigneeId}>`;
  const alreadyAssigned = assignees.includes(slackMention);
  if (!alreadyAssigned && [...assignees, slackMention].join(" ").length > MAX_ASSIGNEES_LENGTH) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Cannot assign ${slackMention}: task assignees reached Slack's text limit.`,
    );
    return;
  }

  if (!alreadyAssigned) {
    try {
      store.assignTask(task.id, slackAssigneeId);
    } catch (error) {
      logger.error(error);
      await postSlackOperationError(
        client,
        { channel: event.channel, threadTs },
        "Failed to assign the user to the task. No assignment was changed.",
        logger,
      );
      return;
    }
  }
  try {
    await refreshTaskAssignees(client, store, task, logger);
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "The user was assigned, but the task card could not be updated.",
      logger,
    );
    return;
  }
  await addSuccessReaction(client, { channel: event.channel, timestamp: event.ts });
}

async function handleUnassignCommand({
  event,
  client,
  logger,
  store,
  args,
}: MentionCommandContext): Promise<void> {
  const threadTs = event.threadTs;
  if (!threadTs) {
    await postSlackOperationError(
      client,
      { channel: event.channel },
      "Run `unassign` from a tracked task thread.",
    );
    return;
  }

  const task = store.getTaskBySlackThread(event.channel, threadTs);
  if (!task) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "Run `unassign` from a tracked task thread.",
    );
    return;
  }

  const slackAssigneeId = args.length === 1 ? slackAssigneeIdFromMention(args[0]) : undefined;
  if (!slackAssigneeId) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Usage: ${event.botMention} \`unassign @user-or-group\``,
    );
    return;
  }
  store.unassignTask(task.id, slackAssigneeId);
  try {
    await refreshTaskAssignees(client, store, task, logger);
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "The user was unassigned, but the task card could not be updated.",
      logger,
    );
    return;
  }
  try {
    await addSuccessReaction(client, { channel: event.channel, timestamp: event.ts });
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "The user was unassigned, but the confirmation reaction could not be added.",
      logger,
    );
  }
}

async function refreshTaskAssignees(
  client: Pick<SlackClient, "chat" | "users">,
  store: WatcherStore,
  task: Task,
  logger: { error(error: unknown): void },
): Promise<void> {
  await withTaskCardQueue(task.id, async () => {
    const currentTask = store.getTask(task.id) ?? task;
    if (!currentTask.parentChannelId || !currentTask.parentMessageTs) return;

    const assignees = store.getTaskAssignees(currentTask.id);
    const assigneeLabels = await resolveSlackAssigneeLabels(client, assignees, logger);
    const baseCard = buildTaskCard(
      currentTask,
      store.getSelectableStatuses(currentTask.serviceName),
      undefined,
      assigneeLabels,
    );
    let currentCard = baseCard;
    try {
      if (currentTask.lastRenderedSummary) {
        const parsed = JSON.parse(currentTask.lastRenderedSummary) as unknown;
        if (isTaskCard(parsed)) currentCard = { ...parsed, text: baseCard.text };
      }
    } catch (error) {
      logger.error(error);
    }
    const card = replaceTaskCardAssignees(currentCard, assigneeLabels);
    await client.chat.update({
      channel: currentTask.parentChannelId,
      ts: currentTask.parentMessageTs,
      ...card,
    });
    store.setRenderedSummary(currentTask.id, JSON.stringify(card));
    await reloadStatusTimeline(client, store, currentTask.id);
  });
}

function isTaskCard(value: unknown): value is TaskCard {
  if (!value || typeof value !== "object") return false;
  const card = value as Partial<TaskCard>;
  return typeof card.text === "string" && Array.isArray(card.blocks) && card.metadata !== undefined;
}

async function handleStatusCommand({
  event,
  client,
  logger,
  store,
  args,
  statusSummaryContext,
}: MentionCommandContext): Promise<void> {
  if (args.length > 0) return;

  const tasks = store
    .getTasksForLinearSync()
    .filter((task) => STATUS_NAMES.has(normalizeStatus(task.status)));
  const slackLinks = new Map<string, string>();

  await Promise.all(
    tasks.map(async (task) => {
      if (!task.parentChannelId || !task.parentMessageTs) return;
      try {
        const response = await client.chat.getPermalink({
          channel: task.parentChannelId,
          message_ts: task.parentMessageTs,
        });
        if (response.permalink) slackLinks.set(task.id, response.permalink);
      } catch (error) {
        logger.error(error);
      }
    }),
  );

  await client.chat.postMessage({
    channel: event.channel,
    text: buildStatusSummary(tasks, slackLinks, statusSummaryContext),
    blocks: buildStatusSummaryBlocks(tasks, slackLinks, statusSummaryContext),
    unfurl_links: false,
    unfurl_media: false,
  });
}

async function handleHelpCommand({
  event,
  client,
  logger,
  args,
}: MentionCommandContext): Promise<void> {
  if (args.length > 0) return;
  const botName = await resolveSlackDisplayName(client, { id: event.botUserId }, logger);

  await client.chat.postMessage({
    channel: event.channel,
    text: buildHelpMessage(botName),
    blocks: buildHelpMessageBlocks(botName),
  });
}

interface AppMentionEvent {
  channel: string;
  ts: string;
  text: string;
  botMention: string;
  botUserId: string;
  user?: string;
  threadTs?: string;
}

interface AppMentionArguments {
  event: unknown;
  client: Pick<SlackClient, "chat" | "users"> & ReactionClient;
  logger: { error(error: unknown): void };
}

interface MentionCommandContext {
  event: AppMentionEvent;
  client: Pick<SlackClient, "chat" | "users"> & ReactionClient;
  logger: { error(error: unknown): void };
  store: WatcherStore;
  args: string[];
  takePrOptions?: TakePrOptions;
  statusSummaryContext?: StatusSummaryContext;
}
