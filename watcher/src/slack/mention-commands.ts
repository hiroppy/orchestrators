import type { WatcherStore } from "../persistence/store.ts";
import { addSuccessReaction, type ReactionClient } from "./reactions.ts";
import { postSlackOperationError } from "./errors.ts";
import { buildStatusSummary, buildStatusSummaryBlocks, STATUS_SUMMARY_STATUSES } from "./views.ts";
import type { SlackClient } from "./client-types.ts";
import { handleTakePrMention, type TakePrOptions } from "./take-pr.ts";

const STATUS_NAMES = new Set(STATUS_SUMMARY_STATUSES.map(normalizeStatus));
const MAX_MENTIONS_LENGTH = 2_000 - "*Mentions*\n".length;

type CommandHandler = (context: MentionCommandContext) => Promise<void>;
const commandHandlers: Record<string, CommandHandler> = {
  assign: handleAssignCommand,
  status: handleStatusCommand,
  "take-pr": handleTakePrCommand,
};

export async function handleAppMention(
  { event, client, logger }: AppMentionArguments,
  store: WatcherStore,
  configuredMentionTargets: string[] = [],
  takePrOptions?: TakePrOptions,
): Promise<void> {
  const mention = parseMentionCommand(event);
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
      takePrOptions,
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
      mention.command === "take-pr"
        ? "Failed to start take-pr. No Linear issue was created."
        : "Failed to load the current task status.",
      logger,
    );
  }
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
  takePrOptions?: TakePrOptions;
}
