import type { ChatPostMessageArguments, ChatPostMessageResponse } from "@slack/web-api";
import { WebClient } from "@slack/web-api";

import type { EventType, WatcherEvent } from "../src/domain/types.ts";
import {
  buildTaskCard,
  buildThreadMessage,
  buildThreadMessageBlocks,
  type TaskCard,
} from "../src/slack/views.ts";

const PREVIEW_STATUSES = ["Todo", "In Progress", "Rework", "In Review", "Done"];
export const SLACK_PREVIEW_CATEGORIES = ["post", "thread"] as const;
export const SLACK_PREVIEW_TYPES = ["start", "update", "retry", "block", "end", "recover"] as const;

type SlackPreviewCategory = (typeof SLACK_PREVIEW_CATEGORIES)[number];
type SlackPreviewType = (typeof SLACK_PREVIEW_TYPES)[number];
const PREVIEW_EVENT_TYPES: Record<SlackPreviewType, EventType> = {
  start: "started",
  update: "updated",
  retry: "retrying",
  block: "blocked",
  end: "ended",
  recover: "recovered",
};
const PREVIEW_THREAD_STATUSES: Record<
  Exclude<EventType, "started">,
  [fromStatus: string, toStatus: string]
> = {
  updated: ["In Progress", "In Review"],
  retrying: ["In Progress", "Rework"],
  blocked: ["In Progress", "Rework"],
  ended: ["In Review", "Done"],
  recovered: ["unavailable", "available"],
};
export interface SlackPreviewCase {
  category: SlackPreviewCategory;
  type: SlackPreviewType;
}
export interface SlackThreadPreviewMessage {
  text: string;
  blocks?: Array<Record<string, unknown>>;
}
export type SlackPreviewMessage = TaskCard | SlackThreadPreviewMessage;

export interface SlackPreviewConfig {
  botToken: string;
  channelId: string;
}

export interface SlackPreviewClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<ChatPostMessageResponse>;
  };
}

export function resolveSlackPreviewCase(
  categoryValue?: string,
  typeValue?: string,
  extraValue?: string,
): SlackPreviewCase {
  const usage = "Usage: pnpm slack:preview <post|thread> <type>";
  const category = SLACK_PREVIEW_CATEGORIES.find((candidate) => candidate === categoryValue);

  if (!category) {
    const detail = categoryValue
      ? `Unknown Slack preview category: ${categoryValue}.`
      : "Missing Slack preview category.";
    throw new Error(
      `${detail} Available categories: ${SLACK_PREVIEW_CATEGORIES.join(", ")}.\n${usage}`,
    );
  }
  const type = SLACK_PREVIEW_TYPES.find((candidate) => candidate === typeValue);
  if (!type) {
    const detail = typeValue
      ? `Unknown Slack preview type: ${typeValue}.`
      : "Missing Slack preview type.";
    throw new Error(`${detail} Available types: ${SLACK_PREVIEW_TYPES.join(", ")}.\n${usage}`);
  }
  if (extraValue !== undefined) {
    throw new Error(`Unexpected Slack preview argument: ${extraValue}.\n${usage}`);
  }

  return { category, type };
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
  previewCase: SlackPreviewCase & { category: "post" },
  now?: Date,
): TaskCard;
export function buildSlackPreviewMessage(
  previewCase: SlackPreviewCase & { category: "thread" },
  now?: Date,
): SlackThreadPreviewMessage;
export function buildSlackPreviewMessage(
  previewCase: SlackPreviewCase,
  now?: Date,
): SlackPreviewMessage;
export function buildSlackPreviewMessage(
  { category, type }: SlackPreviewCase,
  now: Date = new Date(),
): SlackPreviewMessage {
  const updatedAt = now.toISOString();
  const service = "preview-service";
  const issueIdentifier = "PREVIEW-123";
  const eventType = PREVIEW_EVENT_TYPES[type];
  const recovered = eventType === "recovered";
  const eventIssueIdentifier = recovered ? `watcher:${service}` : issueIdentifier;
  const status = recovered ? "available" : previewStatus(eventType);
  const event = previewEvent(eventType, service, eventIssueIdentifier, status);

  if (category === "thread") {
    const context = previewThreadContext(eventType, updatedAt);
    const blocks = buildThreadMessageBlocks(event, undefined, context);
    return {
      text: buildThreadMessage(event, undefined, context),
      ...(blocks ? { blocks } : {}),
    };
  }

  return buildTaskCard(
    {
      id: `${service}:${eventIssueIdentifier}`,
      serviceName: service,
      issueIdentifier: eventIssueIdentifier,
      title: recovered ? eventIssueIdentifier : "Confirm the watcher Slack output",
      status,
      updatedAt,
    },
    PREVIEW_STATUSES,
    event,
    undefined,
    { interactive: false },
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

function previewStatus(previewCase: EventType): string {
  if (previewCase === "blocked") return "Rework";
  if (previewCase === "ended") return "Done";
  if (previewCase === "updated") return "In Review";
  return "In Progress";
}

function previewThreadContext(
  eventType: EventType,
  updatedAt: string,
): { fromStatus: string; toStatus: string; updatedAt: string } | undefined {
  if (eventType === "started") return undefined;

  const [fromStatus, toStatus] = PREVIEW_THREAD_STATUSES[eventType];
  return { fromStatus, toStatus, updatedAt };
}

function previewEvent(
  type: EventType,
  service: string,
  issueIdentifier: string,
  resolvedState: string,
): WatcherEvent {
  const event: WatcherEvent = { type, service, issueIdentifier };
  const resolvedEvent = { ...event, resolvedState };

  switch (type) {
    case "started":
      return {
        ...resolvedEvent,
        turnCount: 1,
        tokens: { total: 1_250 },
        pullRequest: { url: "https://github.com/example/preview/pull/123", number: 123 },
      };
    case "updated":
      return { ...resolvedEvent, turnCount: 12, tokens: { total: 12_345 } };
    case "retrying":
      return {
        ...resolvedEvent,
        attempt: 2,
        dueAt: "2026-07-29T00:05:00.000Z",
        error: "Temporary orchestrator failure",
      };
    case "blocked":
      return { ...resolvedEvent, error: "Waiting for required credentials" };
    case "ended":
      return { ...resolvedEvent, turnCount: 24, tokens: { total: 98_765 } };
    case "recovered":
      return { ...event, state: "available", activity: "Watcher connection restored" };
  }
}

if (import.meta.main) {
  try {
    const [category, type, extra] = process.argv.slice(2).filter((value) => value !== "--");
    const previewCase = resolveSlackPreviewCase(category, type, extra);
    const { botToken, channelId } = resolveSlackPreviewConfig();
    const response = await postSlackPreview(new WebClient(botToken), channelId, previewCase);
    console.log(`Slack preview posted to ${response.channel ?? channelId} (ts: ${response.ts}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
