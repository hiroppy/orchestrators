import type { Task } from "../../domain/task.ts";
import type { PullRequest } from "../../domain/github.ts";
import { normalizeStatus } from "../../domain/status.ts";
import { escapeSlack, truncate } from "../view-formatting.ts";

const MAX_SECTION_TEXT_LENGTH = 3_000;
const MAX_MESSAGE_BLOCKS = 50;
const MAX_MESSAGE_TEXT_LENGTH = 40_000;
export const STATUS_SUMMARY_STATUSES = ["Todo", "In Progress", "In Review"] as const;
const MAX_SERVICE_STATUS_BLOCKS = MAX_MESSAGE_BLOCKS - STATUS_SUMMARY_STATUSES.length;
type MrkdwnText = { type: "mrkdwn"; text: string };
interface SectionBlock extends Record<string, unknown> {
  type: "section";
  text?: MrkdwnText;
  fields?: MrkdwnText[];
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

function buildTextSection(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function pullRequestLabel(pullRequest: PullRequest): string {
  const number = pullRequest.number ?? pullRequest.url.match(/\/pull\/(\d+)(?:$|[/?#])/)?.[1];
  return `PR${number ? `#${number}` : ""}`;
}
