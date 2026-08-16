import type { PullRequest } from "../../domain/github.ts";
import type { Task } from "../../domain/task.ts";
import type { WatcherEvent } from "../../domain/watcher-event.ts";
import { EVENT_LABELS } from "./help.ts";
import { escapeSlack, isPresent, truncate } from "../view-formatting.ts";

const MAX_THREAD_BODY_LENGTH = 2_500;
const MAX_ERROR_LENGTH = 180;
const MAX_FIELD_LENGTH = 2_000;
type MrkdwnText = { type: "mrkdwn"; text: string };
export interface SectionBlock extends Record<string, unknown> {
  type: "section";
  text?: MrkdwnText;
  fields?: MrkdwnText[];
}

export function parentEventLabel(event: WatcherEvent): string {
  const label = EVENT_LABELS[event.type];
  return event.type === "retrying" && event.attempt ? `${label} (attempt ${event.attempt})` : label;
}

export function buildTextSection(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function buildFieldSections(...groups: string[][]): SectionBlock[] {
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

export function formatError(error: string): string {
  return escapeSlack(truncate(error, MAX_ERROR_LENGTH));
}

export function formatAssignees(assignees: readonly string[]): string {
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

export function formatNonNotifyingAssignee(mention: string): string {
  return mention
    .replace(/^<@([A-Z0-9]+)>$/i, "@$1")
    .replace(/^<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>$/i, "@$1");
}

export function compactEventDetails(event: WatcherEvent, includeAttempt = true): string[] {
  return [
    includeAttempt && event.attempt ? `Attempt: ${event.attempt}` : null,
    event.error ? `Error: ${escapeSlack(truncate(event.error, MAX_ERROR_LENGTH))}` : null,
  ].filter(isPresent);
}

export function truncateThreadBody(body: string): string {
  return body.length <= MAX_THREAD_BODY_LENGTH
    ? body
    : `${body.slice(0, MAX_THREAD_BODY_LENGTH - 1)}…`;
}

export function formatParentPullRequestField(pullRequest: PullRequest): string {
  const title = pullRequest.title?.trim() || "View pull request";
  return `*${pullRequestLabel(pullRequest)}*\n<${pullRequest.url}|${escapeSlack(title)}>`;
}

function pullRequestLabel(pullRequest: PullRequest): string {
  const number = pullRequest.number ?? pullRequestNumberFromUrl(pullRequest.url);
  return `PR${number ? `#${number}` : ""}`;
}

function pullRequestNumberFromUrl(url: string): string | undefined {
  return url.match(/\/pull\/(\d+)(?:$|[/?#])/)?.[1];
}

export function notificationLabels(assignees: string[] = []): string[] {
  return [assignees.length > 0 ? `Assignees: ${assignees.join(" ")}` : undefined].filter(isPresent);
}

export function isWatcherErrorTask(task: Task): boolean {
  return (
    task.issueIdentifier.startsWith("watcher:") ||
    task.status.trim().toLowerCase() === "unavailable"
  );
}
