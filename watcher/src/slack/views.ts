import type { EventType, PullRequest, RelatedIssue, Task, WatcherEvent } from "../domain/types.ts";
import { normalizeStatus } from "../domain/status.ts";
import { TASK_STATUS_ACTION_ID, taskBlockId } from "./interactions.ts";
import {
  capitalize,
  escapeExceptLinks,
  escapeSlack,
  escapeSlackLinkLabel,
  formatNumber,
  isPresent,
  truncate,
} from "./view-formatting.ts";

const MAX_THREAD_BODY_LENGTH = 2_500;
const MAX_ERROR_LENGTH = 180;
const MAX_FIELD_LENGTH = 2_000;
const MAX_SECTION_TEXT_LENGTH = 3_000;
const MAX_MESSAGE_TEXT_LENGTH = 40_000;
const MAX_MESSAGE_BLOCKS = 50;
const MAX_RELATED_ISSUE_BLOCKS = 48;
export const STATUS_SUMMARY_STATUSES = ["Todo", "In Progress", "In Review"] as const;
const MAX_SERVICE_STATUS_BLOCKS = MAX_MESSAGE_BLOCKS - STATUS_SUMMARY_STATUSES.length;
type MrkdwnText = { type: "mrkdwn"; text: string };
interface SectionBlock extends Record<string, unknown> {
  type: "section";
  text?: MrkdwnText;
  fields?: MrkdwnText[];
}

export function buildHelpMessage(botName: string): string {
  const commandPrefix = `@${botName.replaceAll("`", "'").replace(/\s+/g, " ")}`;
  return [
    "*Available commands*",
    `• \`${commandPrefix} status\`\n  Show tracked Todo, In Progress, and In Review tasks.`,
    `• \`${commandPrefix} assign @user-or-group\`\n  Add a user or user group to notifications for a tracked task. Run this in the task thread.`,
    `• \`${commandPrefix} unassign @user-or-group\`\n  Remove a user or user group from notifications for a tracked task. Run this in the task thread.`,
    `• \`${commandPrefix} take-pr <GitHub PR URL>\`\n  Create a Linear issue for an existing open pull request.`,
    `• \`${commandPrefix} help\`\n  Show this help message.`,
  ].join("\n");
}

export function buildHelpMessageBlocks(botName: string) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: buildHelpMessage(botName),
      },
    },
  ];
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
  assignees: string[] = [],
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
  const displayedAssignees = assignees.map(formatNonNotifyingAssignee);
  const primaryFields = [
    watcherErrorTask ? `*Status*\n${escapeSlack(capitalize(task.status))}` : null,
    event ? `*Event*\n${escapeSlack(parentEventLabel(event))}` : null,
    displayedAssignees.length > 0 ? formatAssignees(displayedAssignees) : null,
  ].filter(isPresent);
  const errorFields = [event?.error ? `*Error*\n${formatError(event.error)}` : null].filter(
    isPresent,
  );
  const pullRequestFields = [
    event?.pullRequest ? formatParentPullRequestField(event.pullRequest) : null,
  ].filter(isPresent);
  const overviewBlocks = buildFieldSections(primaryFields, errorFields, pullRequestFields);
  const fallbackText =
    displayedAssignees.length > 0
      ? `${displayTitle}. Assigned to ${displayedAssignees.join(" ")}`
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
                  placeholder: { type: "plain_text", text: "Status" },
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

export function replaceTaskCardAssignees(card: TaskCard, assignees: string[]): TaskCard {
  const field =
    assignees.length > 0 ? formatAssignees(assignees.map(formatNonNotifyingAssignee)) : undefined;
  let replaced = false;
  const blocks = card.blocks.flatMap((block) => {
    if (block.type !== "section") return [block];

    if (Array.isArray(block.fields)) {
      const fields = (block.fields as Array<Record<string, unknown>>).flatMap((item) => {
        if (typeof item.text !== "string" || !item.text.startsWith("*Assignees*\n")) {
          return [item];
        }
        replaced = true;
        return field ? [{ ...item, text: field }] : [];
      });
      return fields.length > 0 ? [{ ...block, fields }] : [];
    }

    const text = block.text as Record<string, unknown> | undefined;
    if (typeof text?.text !== "string" || !text.text.startsWith("*Assignees*\n")) {
      return [block];
    }
    replaced = true;
    return field ? [{ ...block, text: { ...text, text: field } }] : [];
  });

  if (field && !replaced) {
    const insertAt = blocks.findLastIndex((block) => block.type === "actions") + 1;
    blocks.splice(insertAt, 0, buildTextSection(field));
  }

  return { ...card, blocks };
}

export interface ThreadMessageContext {
  fromStatus?: string;
  toStatus?: string;
  assignees?: string[];
}

export function buildThreadMessageBlocks(
  event: WatcherEvent,
  context: ThreadMessageContext = {},
): Array<Record<string, unknown>> {
  const transition = statusTransitionDetails(event, context);
  const headline = transition?.headline ?? threadHeadline(event);
  const primaryFields = [
    `*Event*\n${escapeSlack(parentEventLabel(event))}`,
    context.assignees?.length ? formatAssignees(context.assignees) : null,
  ].filter(isPresent);
  const errorFields = [event.error ? `*Error*\n${formatError(event.error)}` : null].filter(
    isPresent,
  );
  const notificationFields = [
    event.pullRequest ? formatParentPullRequestField(event.pullRequest) : null,
  ].filter(isPresent);

  return [
    buildTextSection(headline),
    ...buildFieldSections(primaryFields, errorFields, notificationFields),
  ];
}

export function buildThreadMessage(
  event: WatcherEvent,
  context: ThreadMessageContext = {},
): string {
  const transition = statusTransitionDetails(event, context);
  if (transition) {
    return truncateThreadBody([transition.headline, ...transition.details].join("\n"));
  }

  const headline = event.pullRequest
    ? "*PR created*"
    : `*${escapeSlack(EVENT_LABELS[event.type])}*`;
  const details = [
    headline,
    ...notificationLabels(context.assignees),
    ...[
      event.pullRequest ? formatPullRequest(event.pullRequest) : null,
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
  context: ThreadMessageContext,
): { headline: string; details: string[] } | undefined {
  const { fromStatus, toStatus } = context;
  if (!fromStatus || !toStatus || normalizeStatus(fromStatus) === normalizeStatus(toStatus)) {
    return undefined;
  }

  const details = [
    [`Event: ${escapeSlack(EVENT_LABELS[event.type])}`, ...notificationLabels(context.assignees)]
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

export function buildTaskClosedMessage(
  status: string,
  taskThreadPermalink: string,
  taskTitle: string,
): string {
  return `Task closed | *${escapeSlack(status)}*\n<${taskThreadPermalink}|${escapeSlackLinkLabel(taskTitle)}>`;
}

export function buildTaskClosedMessageBlocks(
  status: string,
  taskThreadPermalink: string,
  taskTitle: string,
): SectionBlock[] {
  return buildNotificationBlocks("*Task closed*", [
    `*Status*\n${escapeSlack(status)}`,
    `*Task*\n<${taskThreadPermalink}|${escapeSlackLinkLabel(taskTitle)}>`,
  ]);
}

export interface StatusSummaryContext {
  serviceNames: string[];
  startedAt: Date;
}

export function buildStatusSummary(
  tasks: Task[],
  slackLinks: ReadonlyMap<string, string>,
  context?: StatusSummaryContext,
): string {
  const statusSections = STATUS_SUMMARY_STATUSES.map((status) =>
    statusSectionText(tasks, status, slackLinks, MAX_SECTION_TEXT_LENGTH),
  );
  if (!context) return statusSections.join("\n\n");

  const statusText = statusSections.join("\n\n");
  const serviceTextLimit = Math.max(0, MAX_MESSAGE_TEXT_LENGTH - statusText.length - 2);
  return [serviceStatusText(context, serviceTextLimit), statusText].join("\n\n");
}

export function buildStatusSummaryBlocks(
  tasks: Task[],
  slackLinks: ReadonlyMap<string, string>,
  context?: StatusSummaryContext,
): SectionBlock[] {
  const statusBlocks = STATUS_SUMMARY_STATUSES.map((status) =>
    buildTextSection(statusSectionText(tasks, status, slackLinks, MAX_SECTION_TEXT_LENGTH)),
  );
  const serviceBlocks = context
    ? serviceStatusSections(context).map((text) => buildTextSection(text))
    : [];
  return [...serviceBlocks, ...statusBlocks];
}

function serviceStatusText(
  { serviceNames, startedAt }: StatusSummaryContext,
  maxLength: number,
): string {
  const heading = serviceStatusHeading(startedAt);
  const serviceLines = serviceNames.map(
    (name) => `• ${truncate(escapeSlack(name), MAX_SECTION_TEXT_LENGTH - 2)}`,
  );
  const visibleServiceLines: string[] = [];
  const render = () => {
    const omittedServiceCount = serviceLines.length - visibleServiceLines.length;
    return [
      heading,
      ...(serviceLines.length === 0 ? ["• None"] : visibleServiceLines),
      ...(omittedServiceCount > 0 ? [`• … ${omittedServiceCount} more`] : []),
    ].join("\n");
  };

  for (const line of serviceLines) {
    visibleServiceLines.push(line);
    if (render().length <= maxLength) continue;
    visibleServiceLines.pop();
    break;
  }
  return render();
}

function serviceStatusSections({ serviceNames, startedAt }: StatusSummaryContext): string[] {
  const services = serviceNames.map(
    (name) => `• ${truncate(escapeSlack(name), MAX_SECTION_TEXT_LENGTH - 2)}`,
  );
  const hasServices = services.length > 0;
  const serviceLines = hasServices ? services : ["• None"];
  const sections: string[] = [];
  let section = serviceStatusHeading(startedAt);
  let visibleServiceCount = 0;

  for (const line of serviceLines) {
    const next = `${section}\n${line}`;
    if (next.length <= MAX_SECTION_TEXT_LENGTH) {
      section = next;
      if (hasServices) visibleServiceCount += 1;
      continue;
    }
    if (sections.length >= MAX_SERVICE_STATUS_BLOCKS - 2) break;
    sections.push(section);
    section = line;
    if (hasServices) visibleServiceCount += 1;
  }

  const omittedServiceCount = serviceNames.length - visibleServiceCount;
  if (omittedServiceCount > 0) {
    const omissionLine = `• … ${omittedServiceCount} more`;
    if (`${section}\n${omissionLine}`.length <= MAX_SECTION_TEXT_LENGTH) {
      section = `${section}\n${omissionLine}`;
    } else {
      sections.push(section);
      section = omissionLine;
    }
  }
  sections.push(section);
  return sections;
}

function serviceStatusHeading(startedAt: Date): string {
  const month = String(startedAt.getMonth() + 1).padStart(2, "0");
  const day = String(startedAt.getDate()).padStart(2, "0");
  const hours = String(startedAt.getHours()).padStart(2, "0");
  const minutes = String(startedAt.getMinutes()).padStart(2, "0");
  return `*Running services (Started at ${month}/${day} ${hours}:${minutes})*`;
}

function statusSectionText(
  tasks: Task[],
  status: string,
  slackLinks: ReadonlyMap<string, string>,
  maxLength: number,
): string {
  const matching = tasks
    .filter((task) => normalizeStatus(task.status) === normalizeStatus(status))
    .sort(
      (left, right) =>
        left.serviceName.localeCompare(right.serviceName) ||
        left.issueIdentifier.localeCompare(right.issueIdentifier),
    );
  const taskLines = matching.map((task) => statusTaskText(task, slackLinks.get(task.id)));
  if (taskLines.length === 0) return `*${status} (0)*\n• None`;

  const heading = `*${status} (${matching.length})*`;
  const visibleTaskLines: string[] = [];
  const render = () => {
    const omittedTaskCount = taskLines.length - visibleTaskLines.length;
    return [
      heading,
      ...visibleTaskLines,
      ...(omittedTaskCount > 0 ? [`• … ${omittedTaskCount} more`] : []),
    ].join("\n");
  };

  for (const line of taskLines) {
    visibleTaskLines.push(line);
    if (render().length <= maxLength) continue;
    visibleTaskLines.pop();
    break;
  }
  return render();
}

function statusTaskText(task: Task, slackUrl?: string): string {
  const label = escapeSlack(`[${task.serviceName}] ${task.issueIdentifier}: ${task.title}`);
  const links = [
    formatStatusLink(slackUrl, "Slack"),
    formatStatusLink(task.linkUrl, "Linear"),
    task.pullRequest
      ? formatStatusLink(task.pullRequest.url, pullRequestLabel(task.pullRequest))
      : undefined,
  ].filter((link): link is string => link !== undefined);
  const linkLine = links.length > 0 ? `\n  ${links.join(" | ")}` : "";
  return `• ${label}${linkLine}`;
}

function formatStatusLink(url: string | undefined, label: string): string | undefined {
  return url ? `<${url}|${escapeSlack(label)}>` : undefined;
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
    .map((fields) =>
      fields.length === 1
        ? buildTextSection(fields[0])
        : {
            type: "section",
            fields: fields.map((text) => ({ type: "mrkdwn", text })),
          },
    );
}

function threadHeadline(event: WatcherEvent): string {
  if (event.pullRequest) return "*PR created*";
  return `*${EVENT_LABELS[event.type]}*`;
}

function formatError(error: string): string {
  return escapeSlack(truncate(error, MAX_ERROR_LENGTH));
}

function formatAssignees(assignees: string[]): string {
  const label = "*Assignees*\n";
  const availableLength = MAX_FIELD_LENGTH - label.length;
  const targets: string[] = [];
  let length = 0;

  for (const mention of assignees) {
    const addedLength = mention.length + (targets.length > 0 ? 1 : 0);
    if (length + addedLength > availableLength) break;
    targets.push(mention);
    length += addedLength;
  }

  return `${label}${targets.join(" ")}`;
}

function formatNonNotifyingAssignee(mention: string): string {
  return mention
    .replace(/^<@([A-Z0-9]+)>$/i, "@$1")
    .replace(/^<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>$/i, "@$1");
}

function compactEventDetails(event: WatcherEvent, includeAttempt = true): string[] {
  return [
    event.pullRequest ? formatPullRequest(event.pullRequest) : null,
    includeAttempt && event.attempt ? `Attempt: ${event.attempt}` : null,
    event.error ? `Error: ${escapeSlack(truncate(event.error, MAX_ERROR_LENGTH))}` : null,
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

function notificationLabels(assignees: string[] = []): string[] {
  return [assignees.length > 0 ? `Assignees: ${assignees.join(" ")}` : undefined].filter(isPresent);
}

function isWatcherErrorTask(task: Task): boolean {
  return (
    task.issueIdentifier.startsWith("watcher:") ||
    task.status.trim().toLowerCase() === "unavailable"
  );
}
