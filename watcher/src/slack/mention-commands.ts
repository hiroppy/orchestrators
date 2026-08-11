import type { WatcherStore } from "../persistence/store.ts";
import { addSuccessReaction, type ReactionClient } from "./reactions.ts";
import { postSlackOperationError } from "./errors.ts";
import {
  buildHelpMessage,
  buildHelpMessageBlocks,
  buildStatusSummary,
  buildStatusSummaryBlocks,
  STATUS_SUMMARY_STATUSES,
} from "./views.ts";
import type { SlackClient } from "./client-types.ts";
import { resolveSlackDisplayName } from "./users.ts";

const STATUS_NAMES = new Set(STATUS_SUMMARY_STATUSES.map(normalizeStatus));
const MAX_MENTIONS_LENGTH = 2_000 - "*Mentions*\n".length;

type CommandHandler = (context: MentionCommandContext) => Promise<void>;
const commandHandlers: Record<string, CommandHandler> = {
  assign: handleAssignCommand,
  help: handleHelpCommand,
  status: handleStatusCommand,
};

export async function handleAppMention(
  { event, client, logger }: AppMentionArguments,
  store: WatcherStore,
  configuredMentionTargets: string[] = [],
  botUserId?: string,
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
      configuredMentionTargets,
    });
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: mention.event.channel, threadTs: mention.event.threadTs },
      "Failed to load the current task status.",
      logger,
    );
  }
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
      `Usage: ${event.botMention} \`assign @user\``,
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
  if (!alreadyAssigned && combinedTargets.join(" ").length > MAX_MENTIONS_LENGTH) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Cannot assign ${slackMention}: configured notification mentions reached Slack's text limit.`,
    );
    return;
  }

  if (!alreadyAssigned) store.assignTaskNotificationMention(task.id, slackUserId);
  await addSuccessReaction(client, { channel: event.channel, timestamp: event.ts });
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
    text: buildStatusSummary(tasks, slackLinks),
    blocks: buildStatusSummaryBlocks(tasks, slackLinks),
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

function slackUserIdFromMention(value: string | undefined): string | undefined {
  return value?.match(/^<@([A-Z0-9]+)>$/i)?.[1];
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
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
  configuredMentionTargets: string[];
}
