import type { RelatedIssue } from "../../domain/linear.ts";
import { escapeSlack, escapeSlackLinkLabel, formatNumber, isPresent } from "../view-formatting.ts";
import {
  buildFieldSections,
  buildTextSection,
  truncateThreadBody,
  type SectionBlock,
} from "./shared.ts";

const MAX_RELATED_ISSUE_BLOCKS = 48;

export function buildReviewRequeueMessage(
  sourceLabel: string,
  fromStatus: string,
  toStatus: string,
): string {
  return `${sourceLabel} | *${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`;
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
