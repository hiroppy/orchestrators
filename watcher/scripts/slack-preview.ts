import type { ChatPostMessageArguments, ChatPostMessageResponse } from "@slack/web-api";
import { WebClient } from "@slack/web-api";
import { desc, isNotNull } from "drizzle-orm";
import type { SlackConfig } from "orchestrator-config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventType, Task, WatcherEvent } from "../src/domain/types.ts";
import { createDatabase } from "../src/persistence/database.ts";
import { tasks } from "../src/persistence/schema.ts";
import { DEFAULT_DATABASE_PATH, WatcherStore } from "../src/persistence/store.ts";
import {
  buildRelatedIssuesMessage,
  buildRelatedIssuesMessageBlocks,
  buildReviewRequeueMessage,
  buildReviewRequeueMessageBlocks,
  buildTaskCard,
  buildStatusChangedMessage,
  buildStatusChangedMessageBlocks,
  buildStatusSummary,
  buildStatusSummaryBlocks,
  buildTaskClosedMessage,
  buildTaskClosedMessageBlocks,
  buildThreadMessage,
  buildThreadMessageBlocks,
  type TaskCard,
} from "../src/slack/views.ts";

const PREVIEW_STATUSES = ["Todo", "In Progress", "Rework", "In Review", "Done"];
const DEFAULT_ATTENTION_TARGET = "@attention-target";
const DEFAULT_ASSIGNEES = ["@reviewer-one", "@reviewer-two"];
export const SLACK_PREVIEW_CATEGORIES = ["post", "thread", "assignees"] as const;
export const SLACK_PREVIEW_EVENT_TYPES = [
  "start",
  "update",
  "retry",
  "block",
  "end",
  "recover",
] as const;
export const SLACK_PREVIEW_TYPES = [
  ...SLACK_PREVIEW_EVENT_TYPES,
  "manual",
  "attention",
  "review-comment",
  "closed",
  "next",
  "status",
] as const;

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
  assignee?: string;
  assignees?: string[];
  task?: Task;
  configuredStatuses?: string[];
  interactive?: boolean;
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
  const usage = "Usage: pnpm slack:preview <post|thread|assignees> <type>";
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
  const threadOnly = ["manual", "review-comment", "next"];
  if (category === "post" && threadOnly.includes(type)) {
    throw new Error(`Slack preview type ${type} is only available for thread previews.\n${usage}`);
  }
  if (category === "thread" && type === "closed") {
    throw new Error(`Slack preview type closed is only available for post previews.\n${usage}`);
  }
  if (extraValue !== undefined) {
    throw new Error(`Unexpected Slack preview argument: ${extraValue}.\n${usage}`);
  }

  return { category, type };
}

export function resolveSlackPreviewConfig(
  environment: NodeJS.ProcessEnv = process.env,
  slack?: SlackConfig,
): SlackPreviewConfig {
  const botToken = environment.SLACK_BOT_TOKEN?.trim() || slack?.botToken?.trim();
  const channelId = environment.SLACK_CHANNEL_ID?.trim() || slack?.channelId?.trim();
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
      blocks: buildStatusChangedMessageBlocks("Hiroppy", "In Review", "Rework"),
    };
  }
  if (type === "review-comment") {
    return {
      text: buildReviewRequeueMessage("In Review", "In Progress"),
      blocks: buildReviewRequeueMessageBlocks("In Review", "In Progress"),
    };
  }
  if (type === "closed") {
    const permalink = "https://example.slack.com/archives/C123/p123456789";
    const title = "Finish the Slack notification preview";
    return {
      text: buildTaskClosedMessage("Done", permalink, title),
      blocks: buildTaskClosedMessageBlocks("Done", permalink, title),
    };
  }
  if (type === "next") {
    const issues = [
      {
        identifier: "PREVIEW-124",
        title: "Verify the watcher Slack output",
        url: "https://linear.app/example/issue/PREVIEW-124/verify-the-watcher-slack-output",
      },
      {
        identifier: "PREVIEW-125",
        title: "Deploy the watcher notification update",
        url: "https://linear.app/example/issue/PREVIEW-125/deploy-the-watcher-notification-update",
      },
      {
        identifier: "PREVIEW-126",
        title: "Document the new Slack layout",
        url: "https://linear.app/example/issue/PREVIEW-126/document-the-new-slack-layout",
      },
    ];
    return {
      text: buildRelatedIssuesMessage(issues),
      blocks: buildRelatedIssuesMessageBlocks(issues),
    };
  }
  if (type === "status") {
    const tasks = previewStatusTasks(now);
    const slackLinks = new Map(
      tasks.map((task) => [
        task.id,
        `https://example.slack.com/archives/C123/p${task.issueIdentifier.replace(/\D/g, "")}`,
      ]),
    );
    const statusSummary = {
      serviceNames: ["service-a", "service-b"],
      startedAt: new Date(2026, 7, 12, 11, 0),
    };
    return {
      text: buildStatusSummary(tasks, slackLinks, statusSummary),
      blocks: buildStatusSummaryBlocks(tasks, slackLinks, statusSummary),
    };
  }

  const eventPreviewType = type === "attention" ? "start" : type;
  const assignee =
    options.assignee ?? (type === "attention" ? DEFAULT_ATTENTION_TARGET : undefined);
  const assignees = options.assignees ?? (type === "attention" ? DEFAULT_ASSIGNEES : []);
  const service = options.task?.serviceName ?? "preview-service";
  const issueIdentifier = options.task?.issueIdentifier ?? "PREVIEW-123";
  const eventType = PREVIEW_EVENT_TYPES[eventPreviewType];
  const recovered = eventType === "recovered";
  const eventIssueIdentifier = recovered ? `watcher:${service}` : issueIdentifier;
  const status = recovered ? "available" : previewStatus(eventType);
  const event = previewEvent(eventType, service, eventIssueIdentifier, status, now);

  if (category === "thread") {
    const context = {
      ...previewThreadContext(eventType),
      assignees: [assignee, ...assignees].filter((value): value is string => Boolean(value)),
    };
    const blocks = buildThreadMessageBlocks(event, context);
    return {
      text: buildThreadMessage(event, context),
      ...(blocks ? { blocks } : {}),
    };
  }

  const task = options.task
    ? {
        ...options.task,
        id: `preview:${service}:${eventIssueIdentifier}`,
        issueIdentifier: eventIssueIdentifier,
        title: recovered ? eventIssueIdentifier : options.task.title,
        status,
        updatedAt: now.toISOString(),
      }
    : ({
        id: `${service}:${eventIssueIdentifier}`,
        serviceName: service,
        issueIdentifier: eventIssueIdentifier,
        title: recovered ? eventIssueIdentifier : "Confirm the watcher Slack output",
        status,
        updatedAt: now.toISOString(),
      } satisfies Task);
  return buildTaskCard(
    task,
    options.configuredStatuses ?? PREVIEW_STATUSES,
    event,
    [...new Set([assignee, ...assignees].filter((value): value is string => Boolean(value)))],
    {
      interactive: options.interactive ?? false,
      titlePrefix: "🔥 Preview",
    },
  );
}

function previewStatusTasks(now: Date): Task[] {
  return [
    {
      id: "preview-service:PREVIEW-120",
      serviceName: "preview-service",
      issueIdentifier: "PREVIEW-120",
      title: "Plan the Slack status command",
      status: "Todo",
      linkUrl: "https://linear.app/example/issue/PREVIEW-120/plan-the-slack-status-command",
      updatedAt: now.toISOString(),
    },
    {
      id: "preview-service:PREVIEW-123",
      serviceName: "preview-service",
      issueIdentifier: "PREVIEW-123",
      title: "Define the status response accessibility requirements",
      status: "Todo",
      linkUrl:
        "https://linear.app/example/issue/PREVIEW-123/define-the-status-response-accessibility-requirements",
      updatedAt: now.toISOString(),
    },
    {
      id: "preview-service:PREVIEW-121",
      serviceName: "preview-service",
      issueIdentifier: "PREVIEW-121",
      title: "Implement the Slack status command",
      status: "In Progress",
      linkUrl: "https://linear.app/example/issue/PREVIEW-121/implement-the-slack-status-command",
      pullRequest: {
        url: "https://github.com/example/preview/pull/121",
        number: 121,
      },
      updatedAt: now.toISOString(),
    },
    {
      id: "preview-service:PREVIEW-124",
      serviceName: "preview-service",
      issueIdentifier: "PREVIEW-124",
      title: "Add destination links to every active task",
      status: "In Progress",
      linkUrl:
        "https://linear.app/example/issue/PREVIEW-124/add-destination-links-to-every-active-task",
      updatedAt: now.toISOString(),
    },
    {
      id: "preview-service:PREVIEW-122",
      serviceName: "preview-service",
      issueIdentifier: "PREVIEW-122",
      title: "Review the Slack status command",
      status: "In Review",
      linkUrl: "https://linear.app/example/issue/PREVIEW-122/review-the-slack-status-command",
      pullRequest: {
        url: "https://github.com/example/preview/pull/122",
        number: 122,
      },
      updatedAt: now.toISOString(),
    },
    {
      id: "preview-service:PREVIEW-125",
      serviceName: "preview-service",
      issueIdentifier: "PREVIEW-125",
      title: "Verify the compact layout with several pull requests",
      status: "In Review",
      linkUrl:
        "https://linear.app/example/issue/PREVIEW-125/verify-the-compact-layout-with-several-pull-requests",
      pullRequest: {
        url: "https://github.com/example/preview/pull/125",
        number: 125,
      },
      updatedAt: now.toISOString(),
    },
  ];
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
    ...(previewCase.category === "assignees" && previewCase.type === "status"
      ? { unfurl_links: false, unfurl_media: false }
      : {}),
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
        pullRequest: {
          url: "https://github.com/example/preview/pull/123",
          number: 123,
          title:
            "Improve the watcher Slack preview layout for long pull request titles across desktop and mobile clients",
        },
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
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const [category, type, extra] = process.argv.slice(2).filter((value) => value !== "--");
    const previewCase = resolveSlackPreviewCase(category, type, extra);
    const { default: config } = await import("orchestrator-config/runtime");
    const { botToken, channelId } = resolveSlackPreviewConfig(process.env, config.slack);
    let options: SlackPreviewOptions | undefined;
    if (previewCase.category === "post") {
      const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
      database = createDatabase(resolve(repositoryRoot, DEFAULT_DATABASE_PATH));
      const store = new WatcherStore(database.db);
      const latest = database.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(isNotNull(tasks.parentMessageTs))
        .orderBy(desc(tasks.updatedAt))
        .get();
      const task = latest ? store.getTask(latest.id) : undefined;
      if (task) {
        options = {
          task,
          configuredStatuses: store.getSelectableStatuses(task.serviceName),
          interactive: true,
        };
      }
    }
    const response = await postSlackPreview(
      new WebClient(botToken),
      channelId,
      previewCase,
      undefined,
      options,
    );
    console.log(`Slack preview posted to ${response.channel ?? channelId} (ts: ${response.ts}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}
