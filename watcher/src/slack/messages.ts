import type { EventType, PullRequest, RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";

export const TASK_STATUS_ACTION_ID = "task_status_select";
const MAX_THREAD_BODY_LENGTH = 2_500;

const EVENT_LABELS: Record<EventType, string> = {
  started: "Started",
  updated: "Updated",
  retrying: "Retrying",
  blocked: "Blocked",
  ended: "Ended",
  recovered: "Recovered",
};

export interface TaskCard {
  text: string;
  blocks: Array<Record<string, unknown>>;
  metadata: {
    event_type: "watcher_task";
    event_payload: { task_id: string };
  };
}

export function buildTaskCard(
  task: Task,
  configuredStatuses: string[],
  event?: WatcherEvent,
  mentionTarget?: string,
): TaskCard {
  const mention = mentionLabel(mentionTarget);
  const watcherErrorTask = isWatcherErrorTask(task);
  const issueUrl = event?.issueUrl ?? task.linkUrl;
  const issueTitle = watcherErrorTask
    ? "Symphony connection"
    : task.title === task.issueIdentifier
      ? undefined
      : task.title;
  const displayTitle = [`[${task.serviceName}]`, issueTitle].filter(isPresent).join(" ");
  const linkedTitle = issueUrl
    ? `<${issueUrl}|${escapeSlack(displayTitle)}>`
    : escapeSlack(displayTitle);
  const selectOptions = configuredStatuses.map((name) => ({
    text: { type: "plain_text", text: name },
    value: name,
  }));
  const selected = selectOptions.find(({ value }) => value === task.status);
  const blockId = taskBlockId(task.id, task.status);
  const eventDetails = event ? compactEventDetails(event) : [];
  const detailLines = [
    [
      watcherErrorTask ? `Status: ${escapeSlack(capitalize(task.status))}` : null,
      event ? `Event: ${escapeSlack(EVENT_LABELS[event.type])}` : null,
      updatedAtLabel(task.updatedAt),
      mention,
    ]
      .filter(isPresent)
      .join(" | "),
    eventDetails.join(" | "),
  ].filter((line) => line.length > 0);
  const showStatusSelect = !watcherErrorTask;

  return {
    text: [displayTitle, mention].filter(isPresent).join(" "),
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
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: detailLines.join("\n"),
          },
        ],
      },
    ],
  };
}

export interface ThreadMessageContext {
  fromStatus?: string;
  toStatus?: string;
  updatedAt?: string;
}

export function buildThreadMessage(
  event: WatcherEvent,
  mentionTarget?: string,
  context: ThreadMessageContext = {},
): string {
  const fromStatus = context.fromStatus;
  const toStatus = context.toStatus;
  if (fromStatus && toStatus && normalizeStatus(fromStatus) !== normalizeStatus(toStatus)) {
    const summary = [
      [
        `Event: ${escapeSlack(EVENT_LABELS[event.type])}`,
        context.updatedAt ? updatedAtLabel(context.updatedAt) : null,
        mentionLabel(mentionTarget),
      ]
        .filter(isPresent)
        .join(" | "),
      compactEventDetails(event, false).join(" | "),
    ].filter((line) => line.length > 0);
    return truncateThreadBody(summary.join("\n"));
  }

  const headline = event.pullRequest
    ? "*PR created*"
    : `*${escapeSlack(EVENT_LABELS[event.type])}*`;
  const details = [
    headline,
    mentionTarget,
    ...[
      event.pullRequest ? formatPullRequest(event.pullRequest) : null,
      event.pullRequest ? null : event.activity,
      event.error ? `Error: ${event.error}` : null,
      event.attempt ? `Attempt: ${event.attempt}` : null,
      event.dueAt ? `Due: ${event.dueAt}` : null,
    ]
      .filter(isPresent)
      .map(escapeExceptLinks),
  ].filter(isPresent);
  const body = details.join(" | ");

  return truncateThreadBody(body);
}

export function buildStatusChangedMessage(
  actorDisplayName: string,
  fromStatus: string,
  toStatus: string,
): string {
  return `*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}* | ${escapeSlack(
    actorDisplayName,
  )}`;
}

export function buildTaskClosedMessage(status: string, parentPermalink: string): string {
  return `Task closed | *${escapeSlack(status)}*\n${parentPermalink}`;
}

export function buildRelatedIssueMessage(issue: RelatedIssue): string {
  const label = [issue.identifier, issue.title].filter(isPresent).join(": ");
  return `Next task | ${issue.url ? `<${issue.url}|${escapeSlack(label)}>` : escapeSlack(label)}`;
}

export function taskIdFromBlockId(blockId?: string): string | undefined {
  if (!blockId?.startsWith("task:")) return undefined;
  try {
    return decodeURIComponent(blockId.slice("task:".length).split(":", 1)[0]);
  } catch {
    return undefined;
  }
}

function taskBlockId(taskId: string, status: string): string {
  return `task:${encodeURIComponent(taskId)}:${encodeURIComponent(status)}`;
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

function formatPullRequest(pullRequest: PullRequest): string {
  const number = pullRequest.number ?? pullRequestNumberFromUrl(pullRequest.url);
  return `<${pullRequest.url}|PR${number ? `#${number}` : ""}>`;
}

function pullRequestNumberFromUrl(url: string): string | undefined {
  return url.match(/\/pull\/(\d+)(?:$|[/?#])/)?.[1];
}

function mentionLabel(mention?: string): string | undefined {
  return mention ? `Attention: ${mention}` : undefined;
}

function isWatcherErrorTask(task: Task): boolean {
  return (
    task.issueIdentifier.startsWith("watcher:") ||
    task.status.trim().toLowerCase() === "unavailable"
  );
}

function updatedAtLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `UpdatedAt: ${escapeSlack(value)}`;

  const timestamp = Math.floor(date.getTime() / 1_000);
  return `UpdatedAt: <!date^${timestamp}^{date_short_pretty} {time}|${date.toISOString()}>`;
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
