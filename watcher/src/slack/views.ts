import type { EventType, PullRequest, RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";
import { TASK_STATUS_ACTION_ID, taskBlockId } from "./interactions.ts";

const MAX_THREAD_BODY_LENGTH = 2_500;
const MAX_ACTIVITY_LENGTH = 180;

const EVENT_LABELS: Record<EventType, string> = {
  started: "Started",
  updated: "Updated",
  retrying: "Retrying",
  blocked: "Blocked",
  ended: "Ended",
  recovered: "Recovered",
};

function parentEventLabel(event: WatcherEvent): string {
  const label = EVENT_LABELS[event.type];
  return event.type === "retrying" && event.attempt ? `${label} (attempt ${event.attempt})` : label;
}

export interface TaskCard {
  text: string;
  blocks: Array<Record<string, unknown>>;
  metadata: {
    event_type: "watcher_task";
    event_payload: { task_id: string };
  };
}

export interface TaskCardOptions {
  interactive?: boolean;
  titlePrefix?: string;
}

export function buildTaskCard(
  task: Task,
  configuredStatuses: string[],
  event?: WatcherEvent,
  mentionTarget?: string,
  options: TaskCardOptions = {},
): TaskCard {
  const watcherErrorTask = isWatcherErrorTask(task);
  const issueUrl = event?.issueUrl ?? task.linkUrl;
  const issueTitle = watcherErrorTask
    ? "Symphony connection"
    : task.title === task.issueIdentifier
      ? undefined
      : task.title;
  const displayTitle = [options.titlePrefix, `[${task.serviceName}]`, issueTitle]
    .filter(isPresent)
    .join(" ");
  const linkedTitle = issueUrl
    ? `<${issueUrl}|${escapeSlack(displayTitle)}>`
    : escapeSlack(displayTitle);
  const selectOptions = configuredStatuses.map((name) => ({
    text: { type: "plain_text", text: name },
    value: name,
  }));
  const selected = selectOptions.find(({ value }) => value === task.status);
  const blockId = taskBlockId(task.id, task.status);
  const showStatusSelect = options.interactive !== false && !watcherErrorTask;
  const activity = event?.activity ?? event?.error;
  const primaryFields = [
    watcherErrorTask ? `*Status*\n${escapeSlack(capitalize(task.status))}` : null,
    event ? `*Event*\n${escapeSlack(parentEventLabel(event))}` : null,
    activity
      ? `*Activity*\n${escapeSlack(truncate(activity, MAX_ACTIVITY_LENGTH))}`
      : null,
  ].filter(isPresent);
  const secondaryFields = [
    mentionTarget ? `*Creator*\n${mentionTarget}` : null,
    event?.pullRequest ? formatParentPullRequestField(event.pullRequest) : null,
  ].filter(isPresent);
  const overviewBlocks = [primaryFields, secondaryFields]
    .filter((fields) => fields.length > 0)
    .map((fields) => ({
      type: "section",
      fields: fields.map((text) => ({ type: "mrkdwn", text })),
    }));
  const fallbackText = mentionTarget ? `${displayTitle}. Created by ${mentionTarget}` : displayTitle;
  return {
    text: fallbackText,
    metadata: {
      event_type: "watcher_task",
      event_payload: { task_id: task.id },
    },
    blocks: [
      {
        type: "section",
        block_id: `task_summary:${encodeURIComponent(task.id)}`,
        text: {
          type: "mrkdwn",
          text: `*${linkedTitle}*`,
        },
      },
      ...(showStatusSelect
        ? [
            {
              type: "actions",
              block_id: blockId,
              elements: [
                {
                  type: "static_select",
                  action_id: TASK_STATUS_ACTION_ID,
                  placeholder: { type: "plain_text", text: "Change status" },
                  options: selectOptions,
                  ...(selected ? { initial_option: selected } : {}),
                },
              ],
            },
          ]
        : []),
      ...overviewBlocks,
    ],
  };
}

export interface ThreadMessageContext {
  fromStatus?: string;
  toStatus?: string;
  mentions?: string[];
}

export function buildThreadMessageBlocks(
  event: WatcherEvent,
  mentionTarget?: string,
  context: ThreadMessageContext = {},
): Array<Record<string, unknown>> {
  const transition = statusTransitionDetails(event, mentionTarget, context);
  const headline = transition?.headline ?? (event.pullRequest ? "*PR created*" : `*${EVENT_LABELS[event.type]}*`);
  const activity = event.activity ?? event.error;
  const totalTokens = event.tokens?.total;
  const primaryFields = [
    `*Event*\n${escapeSlack(parentEventLabel(event))}`,
    activity ? `*Activity*\n${escapeSlack(truncate(activity, MAX_ACTIVITY_LENGTH))}` : null,
  ].filter(isPresent);
  const notificationFields = [
    mentionTarget ? `*Creator*\n${mentionTarget}` : null,
    event.pullRequest ? formatParentPullRequestField(event.pullRequest) : null,
  ].filter(isPresent);
  const detailFields = [
    positiveNumber(event.turnCount) || positiveNumber(totalTokens)
      ? `*Usage*\n${[
          positiveNumber(event.turnCount) ? `${formatNumber(event.turnCount)} turns` : null,
          positiveNumber(totalTokens) ? `${formatCompactNumber(totalTokens)} tokens` : null,
        ]
          .filter(isPresent)
          .join(" | ")}`
      : null,
    context.mentions?.length ? `*Mentions*\n${context.mentions.join(" ")}` : null,
  ].filter(isPresent);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: headline,
      },
    },
    ...[primaryFields, notificationFields, detailFields]
      .filter((fields) => fields.length > 0)
      .map((fields) => ({
        type: "section",
        fields: fields.map((text) => ({ type: "mrkdwn", text })),
      })),
  ];
}

export function buildThreadMessage(
  event: WatcherEvent,
  mentionTarget?: string,
  context: ThreadMessageContext = {},
): string {
  const transition = statusTransitionDetails(event, mentionTarget, context);
  if (transition) {
    return truncateThreadBody([transition.headline, ...transition.details].join("\n"));
  }

  const headline = event.pullRequest
    ? "*PR created*"
    : `*${escapeSlack(EVENT_LABELS[event.type])}*`;
  const details = [
    headline,
    ...notificationLabels(mentionTarget, context.mentions),
    ...[
      event.pullRequest ? formatPullRequest(event.pullRequest) : null,
      event.pullRequest ? null : event.activity,
      event.error ? `Error: ${event.error}` : null,
      event.attempt ? `Attempt: ${event.attempt}` : null,
    ]
      .filter(isPresent)
      .map(escapeExceptLinks),
  ].filter(isPresent);
  const body = details.join(" | ");

  return truncateThreadBody(body);
}

function statusTransitionDetails(
  event: WatcherEvent,
  mentionTarget: string | undefined,
  context: ThreadMessageContext,
): { headline: string; details: string[] } | undefined {
  const { fromStatus, toStatus } = context;
  if (!fromStatus || !toStatus || normalizeStatus(fromStatus) === normalizeStatus(toStatus)) {
    return undefined;
  }

  const details = [
    [
      `Event: ${escapeSlack(EVENT_LABELS[event.type])}`,
      ...notificationLabels(mentionTarget, context.mentions),
    ]
      .filter(isPresent)
      .join(" | "),
    compactEventDetails(event, false).join(" | "),
  ].filter((line) => line.length > 0);

  return {
    headline: `*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`,
    details,
  };
}

export function buildStatusChangedMessage(
  actorDisplayName: string,
  fromStatus: string,
  toStatus: string,
): string {
  return `*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}* by ${escapeSlack(
    actorDisplayName,
  )}`;
}

export function buildStatusChangedMessageBlocks(
  actorDisplayName: string,
  fromStatus: string,
  toStatus: string,
): Array<{
  type: "section";
  text?: { type: "mrkdwn"; text: string };
  fields?: Array<{ type: "mrkdwn"; text: string }>;
}> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Changed by*\n${escapeSlack(actorDisplayName)}`,
        },
      ],
    },
  ];
}

export function buildTaskClosedMessage(status: string, parentPermalink: string): string {
  return `Task closed | *${escapeSlack(status)}*\n${parentPermalink}`;
}

export function buildRelatedIssueMessage(issue: RelatedIssue): string {
  const label = [issue.identifier, issue.title].filter(isPresent).join(": ");
  return `Next task | ${issue.url ? `<${issue.url}|${escapeSlack(label)}>` : escapeSlack(label)}`;
}

function compactEventDetails(event: WatcherEvent, includeAttempt = true): string[] {
  return [
    event.pullRequest ? formatPullRequest(event.pullRequest) : null,
    includeAttempt && event.attempt ? `Attempt: ${event.attempt}` : null,
    event.error ? `Error: ${escapeSlack(truncate(event.error, 180))}` : null,
    positiveNumber(event.turnCount) ? `Turns: ${formatNumber(event.turnCount)}` : null,
    positiveNumber(event.tokens?.total)
      ? `Tokens: ${formatCompactNumber(event.tokens?.total)}`
      : null,
  ].filter(isPresent);
}

function truncateThreadBody(body: string): string {
  return body.length <= MAX_THREAD_BODY_LENGTH
    ? body
    : `${body.slice(0, MAX_THREAD_BODY_LENGTH - 1)}…`;
}

function formatParentPullRequestField(pullRequest: PullRequest): string {
  const title = pullRequest.title?.trim() || "View pull request";
  return `*${pullRequestLabel(pullRequest)}*\n<${pullRequest.url}|${escapeSlack(title)}>`;
}

function formatPullRequest(pullRequest: PullRequest): string {
  return `<${pullRequest.url}|${pullRequestLabel(pullRequest)}>`;
}

function pullRequestLabel(pullRequest: PullRequest): string {
  const number = pullRequest.number ?? pullRequestNumberFromUrl(pullRequest.url);
  return `PR${number ? `#${number}` : ""}`;
}

function pullRequestNumberFromUrl(url: string): string | undefined {
  return url.match(/\/pull\/(\d+)(?:$|[/?#])/)?.[1];
}

function mentionLabel(mention?: string): string | undefined {
  return mention ? `Creator: ${mention}` : undefined;
}

function notificationLabels(creator?: string, mentions: string[] = []): string[] {
  return [
    mentionLabel(creator),
    mentions.length > 0 ? `Mentions: ${mentions.join(" ")}` : undefined,
  ].filter(isPresent);
}

function isWatcherErrorTask(task: Task): boolean {
  return (
    task.issueIdentifier.startsWith("watcher:") ||
    task.status.trim().toLowerCase() === "unavailable"
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function positiveNumber(value: unknown): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function formatNumber(value: unknown): string {
  return Math.trunc(Number(value)).toLocaleString("en-US");
}

function formatCompactNumber(value: unknown): string {
  const number = Number(value);
  if (number < 1_000) return formatNumber(number);
  if (number < 1_000_000) return `${stripTrailingZero((number / 1_000).toFixed(1))}k`;
  return `${stripTrailingZero((number / 1_000_000).toFixed(1))}m`;
}

function stripTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function escapeExceptLinks(value: string): string {
  return /^<(?:https?:\/\/|@[^>]+>|![^>]+>)/.test(value) ? value : escapeSlack(value);
}

function escapeSlack(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isPresent<T>(value: T | null | undefined | false): value is T {
  return value !== null && value !== undefined && value !== false;
}
