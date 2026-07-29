import type { ChatPostMessageArguments, ChatPostMessageResponse } from "@slack/web-api";

import { buildTaskCard, type TaskCard } from "./messages.ts";

const PREVIEW_STATUSES = ["Todo", "In Progress", "In Review", "Done"];

export interface SlackPreviewConfig {
  botToken: string;
  channelId: string;
}

export interface SlackPreviewClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<ChatPostMessageResponse>;
  };
}

export function resolveSlackPreviewConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SlackPreviewConfig {
  const botToken = environment.SLACK_BOT_TOKEN?.trim();
  const channelId = environment.SLACK_CHANNEL_ID?.trim();
  const missing = [
    botToken ? undefined : "SLACK_BOT_TOKEN",
    channelId ? undefined : "SLACK_CHANNEL_ID",
  ].filter((name): name is string => name !== undefined);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return { botToken: botToken!, channelId: channelId! };
}

export function buildSlackPreviewMessage(now: Date = new Date()): TaskCard {
  const updatedAt = now.toISOString();
  const issueIdentifier = "PREVIEW-123";
  const service = "preview-service";

  return buildTaskCard(
    {
      id: `${service}:${issueIdentifier}`,
      serviceName: service,
      issueIdentifier,
      title: "Confirm the watcher Slack output",
      status: "In Review",
      updatedAt,
    },
    PREVIEW_STATUSES,
    {
      type: "updated",
      service,
      issueIdentifier,
      resolvedState: "In Review",
      attempt: 2,
      turnCount: 12,
      tokens: { total: 12_345 },
    },
  );
}

export function postSlackPreview(
  client: SlackPreviewClient,
  channelId: string,
  now?: Date,
): Promise<ChatPostMessageResponse> {
  return client.chat.postMessage({
    channel: channelId,
    ...buildSlackPreviewMessage(now),
  });
}
