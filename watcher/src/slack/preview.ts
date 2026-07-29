import type { ChatPostMessageArguments, ChatPostMessageResponse } from "@slack/web-api";

import type { EventType, WatcherEvent } from "../domain/types.ts";
import { buildTaskCard, type TaskCard } from "./messages.ts";

const PREVIEW_STATUSES = ["Todo", "In Progress", "Rework", "In Review", "Done"];
export const SLACK_PREVIEW_CASES = [
  "started",
  "updated",
  "retrying",
  "blocked",
  "ended",
  "recovered",
] as const satisfies readonly EventType[];

export type SlackPreviewCase = (typeof SLACK_PREVIEW_CASES)[number];

export interface SlackPreviewConfig {
  botToken: string;
  channelId: string;
}

export interface SlackPreviewClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<ChatPostMessageResponse>;
  };
}

export function resolveSlackPreviewCase(value?: string): SlackPreviewCase {
  if (SLACK_PREVIEW_CASES.some((previewCase) => previewCase === value)) {
    return value as SlackPreviewCase;
  }

  const detail = value ? `Unknown Slack preview case: ${value}.` : "Missing Slack preview case.";
  throw new Error(
    `${detail} Available cases: ${SLACK_PREVIEW_CASES.join(", ")}.\n` +
      "Usage: pnpm slack:preview <case>",
  );
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

export function buildSlackPreviewMessage(
  previewCase: SlackPreviewCase,
  now: Date = new Date(),
): TaskCard {
  const updatedAt = now.toISOString();
  const issueIdentifier = "PREVIEW-123";
  const service = "preview-service";
  const status = previewStatus(previewCase);

  return buildTaskCard(
    {
      id: `${service}:${issueIdentifier}`,
      serviceName: service,
      issueIdentifier,
      title: "Confirm the watcher Slack output",
      status,
      updatedAt,
    },
    PREVIEW_STATUSES,
    previewEvent(previewCase, service, issueIdentifier, status),
  );
}

export function postSlackPreview(
  client: SlackPreviewClient,
  channelId: string,
  previewCase: SlackPreviewCase,
  now?: Date,
): Promise<ChatPostMessageResponse> {
  return client.chat.postMessage({
    channel: channelId,
    ...buildSlackPreviewMessage(previewCase, now),
  });
}

function previewStatus(previewCase: SlackPreviewCase): string {
  if (previewCase === "blocked") return "Rework";
  if (previewCase === "ended") return "Done";
  if (previewCase === "updated") return "In Review";
  return "In Progress";
}

function previewEvent(
  type: SlackPreviewCase,
  service: string,
  issueIdentifier: string,
  resolvedState: string,
): WatcherEvent {
  const event: WatcherEvent = { type, service, issueIdentifier, resolvedState };

  switch (type) {
    case "started":
      return {
        ...event,
        turnCount: 1,
        tokens: { total: 1_250 },
        pullRequest: { url: "https://github.com/example/preview/pull/123", number: 123 },
      };
    case "updated":
      return { ...event, turnCount: 12, tokens: { total: 12_345 } };
    case "retrying":
      return {
        ...event,
        attempt: 2,
        dueAt: "2026-07-29T00:05:00.000Z",
        error: "Temporary orchestrator failure",
      };
    case "blocked":
      return { ...event, error: "Waiting for required credentials" };
    case "ended":
      return { ...event, turnCount: 24, tokens: { total: 98_765 } };
    case "recovered":
      return { ...event, activity: "Watcher connection restored" };
  }
}
