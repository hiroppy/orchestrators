import type { ChatPostMessageArguments, ChatPostMessageResponse } from "@slack/web-api";
import { WebClient } from "@slack/web-api";

import type { EventType, WatcherEvent } from "../src/domain/types.ts";
import {
  buildTaskCard,
  buildStatusChangedMessage,
  buildThreadMessage,
  buildThreadMessageBlocks,
  type TaskCard,
} from "../src/slack/views.ts";

const PREVIEW_STATUSES = ["Todo", "In Progress", "Rework", "In Review", "Done"];
const DEFAULT_ATTENTION_TARGET = "@attention-target";
export const SLACK_PREVIEW_CATEGORIES = ["post", "thread"] as const;
export const SLACK_PREVIEW_EVENT_TYPES = [
  "start",
  "update",
  "retry",
  "block",
  "end",
  "recover",
] as const;
export const SLACK_PREVIEW_TYPES = [...SLACK_PREVIEW_EVENT_TYPES, "manual", "attention"] as const;

type SlackPreviewCategory = (typeof SLACK_PREVIEW_CATEGORIES)[number];
type SlackPreviewType = (typeof SLACK_PREVIEW_TYPES)[number];
type SlackPreviewEventType = (typeof SLACK_PREVIEW_EVENT_TYPES)[number];
const PREVIEW_EVENT_TYPES: Record<SlackPreviewEventType, EventType> = {
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

export interface SlackPreviewOptions {
  mentionTarget?: string;
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
  if (category === "post" && type === "manual") {
    throw new Error(`Slack preview type manual is only available for thread previews.\n${usage}`);
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
  options?: SlackPreviewOptions,
): TaskCard;
export function buildSlackPreviewMessage(
  previewCase: SlackPreviewCase & { category: "thread" },
  now?: Date,
  options?: SlackPreviewOptions,
): SlackThreadPreviewMessage;
export function buildSlackPreviewMessage(
  previewCase: SlackPreviewCase,
  now?: Date,
  options?: SlackPreviewOptions,
): SlackPreviewMessage;
export function buildSlackPreviewMessage(
  { category, type }: SlackPreviewCase,
  now: Date = new Date(),
  options: SlackPreviewOptions = {},
): SlackPreviewMessage {
  if (type === "manual") {
    if (category !== "thread") {
      throw new Error("Slack preview type manual is only available for thread previews.");
    }
    return {
      text: buildStatusChangedMessage("Hiroppy", "In Review", "Rework"),
    };
  }

  const eventPreviewType = type === "attention" ? "block" : type;
  const mentionTarget =
    type === "attention" ? (options.mentionTarget ?? DEFAULT_ATTENTION_TARGET) : undefined;
  const service = "preview-service";
  const issueIdentifier = "PREVIEW-123";
  const eventType = PREVIEW_EVENT_TYPES[eventPreviewType];
  const recovered = eventType === "recovered";
  const eventIssueIdentifier = recovered ? `watcher:${service}` : issueIdentifier;
  const status = recovered ? "available" : previewStatus(eventType);
  const event = previewEvent(eventType, service, eventIssueIdentifier, status, now);

  if (category === "thread") {
    const context = previewThreadContext(eventType);
    const blocks = buildThreadMessageBlocks(event, mentionTarget, context);
    return {
      text: buildThreadMessage(event, mentionTarget, context),
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
      updatedAt: now.toISOString(),
    },
    PREVIEW_STATUSES,
    event,
    mentionTarget,
    { interactive: false },
  );
}

export function postSlackPreview(
  client: SlackPreviewClient,
  channelId: string,
  previewCase: SlackPreviewCase,
  now?: Date,
  options?: SlackPreviewOptions,
): Promise<ChatPostMessageResponse> {
  return client.chat.postMessage({
    channel: channelId,
    ...buildSlackPreviewMessage(previewCase, now, options),
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
): { fromStatus: string; toStatus: string } | undefined {
  if (eventType === "started") return undefined;

  const [fromStatus, toStatus] = PREVIEW_THREAD_STATUSES[eventType];
  return { fromStatus, toStatus };
}

function previewEvent(
  type: EventType,
  service: string,
  issueIdentifier: string,
  resolvedState: string,
  now: Date,
): WatcherEvent {
  const event: WatcherEvent = { type, service, issueIdentifier };
  const resolvedEvent = { ...event, resolvedState };
  const startedAt = shiftedIso(now, -15);

  switch (type) {
    case "started":
      return {
        ...resolvedEvent,
        startedAt,
        activity: "Inspecting the watcher Slack output",
        turnCount: 1,
        tokens: { total: 1_250 },
        pullRequest: { url: "https://github.com/example/preview/pull/123", number: 123 },
      };
    case "updated":
      return {
        ...resolvedEvent,
        startedAt,
        activity: "Running tests and reviewing the generated Slack blocks",
        turnCount: 12,
        tokens: { total: 12_345 },
      };
    case "retrying":
      return {
        ...resolvedEvent,
        attempt: 2,
        dueAt: shiftedIso(now, 5),
        error: "Temporary orchestrator failure",
      };
    case "blocked":
      return {
        ...resolvedEvent,
        blockedAt: shiftedIso(now, -5),
        error: "Waiting for required credentials",
      };
    case "ended":
      return {
        ...resolvedEvent,
        startedAt,
        activity: "Finalizing the watcher Slack output",
        turnCount: 24,
        tokens: { total: 98_765 },
      };
    case "recovered":
      return { ...event, state: "available", activity: "Watcher connection restored" };
  }
}

function shiftedIso(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
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
