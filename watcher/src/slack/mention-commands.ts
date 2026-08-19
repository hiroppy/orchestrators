import type { WebClient } from "@slack/web-api";
import type { SlackCommandConfig } from "orchestrator-config";

import type { WatcherStore } from "../persistence/store.ts";
import { postSlackOperationError } from "./errors.ts";
import type { StatusSummaryContext } from "./views.ts";
import { handleTakePrMention, type TakePrOptions } from "./take-pr.ts";
import { handleAssignCommand, handleUnassignCommand } from "./commands/assignment.ts";
import { handleHelpCommand } from "./commands/help.ts";
import { handleStatusCommand } from "./commands/status.ts";
import { handleSlackCommand } from "./commands/slack-command.ts";

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
  slackCommandsForService?: (serviceName: string) => SlackCommandConfig[],
): Promise<void> {
  const mention = parseMentionCommand(event, botUserId);
  if (!mention) return;
  let handler = commandHandlers[mention.command];
  let isSlackCommand = false;
  if (!handler && mention.event.threadTs) {
    const task = store.getTaskBySlackThread(mention.event.channel, mention.event.threadTs);
    const slackCommand = task
      ? slackCommandsForService?.(task.serviceName).find(
          ({ command }) => command === mention.command,
        )
      : undefined;
    if (task && slackCommand) {
      handler = (context) => handleSlackCommand(slackCommand, task, context);
      isSlackCommand = true;
    }
  }
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
      isSlackCommand
        ? `Slack command \`${mention.command}\` failed.`
        : commandFailureMessage(mention.command),
      logger,
    );
  }
}

function commandFailureMessage(command: string): string {
  if (command === "assign") {
    return "Failed to assign the user to the task. No assignment was changed.";
  }
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
  client: WebClient;
  logger: { error(error: unknown): void };
}

export interface MentionCommandContext {
  event: AppMentionEvent;
  client: WebClient;
  logger: { error(error: unknown): void };
  store: WatcherStore;
  args: string[];
  takePrOptions?: TakePrOptions;
  statusSummaryContext?: StatusSummaryContext;
}
