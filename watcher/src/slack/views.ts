import type { EventType, PullRequest, RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";
import { TASK_STATUS_ACTION_ID, taskBlockId } from "./interactions.ts";

const MAX_THREAD_BODY_LENGTH = 2_500;
const MAX_ACTIVITY_LENGTH = 180;
const MAX_FIELD_LENGTH = 2_000;
const MAX_RELATED_ISSUE_BLOCKS = 48;
type MrkdwnText = { type: "mrkdwn"; text: string };
interface SectionBlock extends Record<string, unknown> {
  type: "section";
  text?: MrkdwnText;
  fields?: MrkdwnText[];
}

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
  const activity = event ? formatActivity(event) : undefined;
  const primaryFields = [
    watcherErrorTask ? `*Status*\n${escapeSlack(capitalize(task.status))}` : null,
    event ? `*Event*\n${escapeSlack(parentEventLabel(event))}` : null,
    activity ? `*Activity*\n${activity}` : null,
  ].filter(isPresent);
  const secondaryFields = [
    mentionTarget ? `*Creator*\n${mentionTarget}` : null,
    event?.pullRequest ? formatParentPullRequestField(event.pullRequest) : null,
  ].filter(isPresent);
  const overviewBlocks = buildFieldSections(primaryFields, secondaryFields);
  const fallbackText = mentionTarget
    ? `${displayTitle}. Created by ${mentionTarget}`
    : displayTitle;
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
  const headline = transition?.headline ?? threadHeadline(event);
  const activity = formatActivity(event);
  const primaryFields = [
    `*Event*\n${escapeSlack(parentEventLabel(event))}`,
    activity ? `*Activity*\n${activity}` : null,
  ].filter(isPresent);
  const notificationFields = [
    mentionTarget ? `*Creator*\n${mentionTarget}` : null,
    event.pullRequest ? formatParentPullRequestField(event.pullRequest) : null,
  ].filter(isPresent);
  const detailFields = [
    formatUsage(event.turnCount, event.tokens?.total),
    context.mentions?.length ? formatMentions(context.mentions) : null,
  ].filter(isPresent);

  return [
    buildTextSection(headline),
    ...buildFieldSections(primaryFields, notificationFields, detailFields),
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
): SectionBlock[] {
  return [
    buildTextSection(`*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`),
    ...buildFieldSections([`*Changed by*\n${escapeSlack(actorDisplayName)}`]),
  ];
}

export function buildReviewRequeueMessage(
  reaction: string,
  fromStatus: string,
  toStatus: string,
): string {
  return `${reaction} review reaction detected | *${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`;
}

export function buildReviewRequeueMessageBlocks(
  reaction: string,
  fromStatus: string,
  toStatus: string,
): SectionBlock[] {
  return buildNotificationBlocks(`*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`, [
    `*Event*\n${escapeSlack(reaction)} Review reaction detected`,
  ]);
}

export function buildReviewRequeueLimitMessage(
  reaction: string,
  maxRequeues: number,
  fromStatus: string,
  toStatus: string,
): string {
  return `${reaction} review requeue limit reached (${maxRequeues}/${maxRequeues}) | *${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`;
}

export function buildReviewRequeueLimitMessageBlocks(
  reaction: string,
  maxRequeues: number,
  fromStatus: string,
  toStatus: string,
): SectionBlock[] {
  return buildNotificationBlocks(`*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`, [
    `*Event*\n${escapeSlack(reaction)} Review requeue limit reached`,
    `*Requeues*\n${formatNumber(maxRequeues)}/${formatNumber(maxRequeues)}`,
  ]);
}

export function buildTaskClosedMessage(status: string, parentPermalink: string): string {
  return `Task closed | *${escapeSlack(status)}*\n${parentPermalink}`;
}

export function buildTaskClosedMessageBlocks(
  status: string,
  parentPermalink: string,
): SectionBlock[] {
  return buildNotificationBlocks("*Task closed*", [
    `*Status*\n${escapeSlack(status)}`,
    `*Task*\n<${parentPermalink}|View task thread>`,
  ]);
}

export function buildRelatedIssuesMessage(issues: RelatedIssue[]): string {
  return truncateThreadBody(
    ["Next task", ...issues.map((issue) => formatRelatedIssue(issue))].join(" | "),
  );
}

export function buildRelatedIssuesMessageBlocks(issues: RelatedIssue[]): SectionBlock[] {
  const visibleIssues = issues.slice(0, MAX_RELATED_ISSUE_BLOCKS);
  const remainingCount = issues.length - visibleIssues.length;
  const overflowBlocks =
    remainingCount > 0 ? [buildTextSection(`_and ${formatNumber(remainingCount)} more…_`)] : [];
  return [
    buildTextSection("*Next task*"),
    ...visibleIssues.map((issue) => buildTextSection(formatRelatedIssue(issue))),
    ...overflowBlocks,
  ];
}

function formatRelatedIssue(issue: RelatedIssue): string {
  const label = [issue.identifier, issue.title].filter(isPresent).join(": ");
  return issue.url ? `<${issue.url}|${escapeSlack(label)}>` : escapeSlack(label);
}

function buildNotificationBlocks(headline: string, fields: string[]): SectionBlock[] {
  return [buildTextSection(headline), ...buildFieldSections(fields)];
}

function buildTextSection(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function buildFieldSections(...groups: string[][]): SectionBlock[] {
  return groups
    .filter((fields) => fields.length > 0)
    .map((fields) => ({
      type: "section",
      fields: fields.map((text) => ({ type: "mrkdwn", text })),
    }));
}

function threadHeadline(event: WatcherEvent): string {
  if (event.pullRequest) return "*PR created*";
  return `*${EVENT_LABELS[event.type]}*`;
}

function formatUsage(turnCount?: number, totalTokens?: number): string | undefined {
  const values = [
    positiveNumber(turnCount) ? `${formatNumber(turnCount)} turns` : null,
    positiveNumber(totalTokens) ? `${formatCompactNumber(totalTokens)} tokens` : null,
  ].filter(isPresent);
  return values.length > 0 ? `*Usage*\n${values.join(" | ")}` : undefined;
}

function formatActivity(event: WatcherEvent): string | undefined {
  const activity = event.activity ? escapeSlack(event.activity) : undefined;
  const error = event.error ? escapeSlack(event.error) : undefined;
  if (!activity || !error) {
    const text = activity ?? error;
    return text ? truncate(text, MAX_ACTIVITY_LENGTH) : undefined;
  }

  const separator = "\n⚠️ ";
  const availableLength = MAX_ACTIVITY_LENGTH - separator.length;
  const errorLength = Math.min(error.length, Math.ceil(availableLength / 2));
  const activityText = truncate(activity, availableLength - errorLength);
  const errorText = truncate(error, availableLength - activityText.length);
  return `${activityText}${separator}${errorText}`;
}

function formatMentions(mentions: string[]): string {
  const label = "*Mentions*\n";
  const availableLength = MAX_FIELD_LENGTH - label.length;
  const targets: string[] = [];
  let length = 0;

  for (const mention of mentions) {
    const addedLength = mention.length + (targets.length > 0 ? 1 : 0);
    if (length + addedLength > availableLength) break;
    targets.push(mention);
    length += addedLength;
  }

  return `${label}${targets.join(" ")}`;
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
