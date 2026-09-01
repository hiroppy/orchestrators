import { escapeSlack, escapeSlackLinkLabel } from "../view-formatting.ts";

export interface InReviewReminderEntry {
  issueIdentifier: string;
  title: string;
  assignees: string[];
  threadLink?: string;
}

export function buildInReviewReminder(
  entries: InReviewReminderEntry[],
  status: string,
  afterDays: number,
): string {
  const lines = entries.map(({ issueIdentifier, title, assignees, threadLink }) => {
    const mentions = assignees.length > 0 ? assignees.join(" ") : "Unassigned";
    const label = `${issueIdentifier}: ${title}`;
    const taskLink = threadLink
      ? `<${threadLink}|${escapeSlackLinkLabel(label)}>`
      : escapeSlack(label);
    return `• ${taskLink} — ${mentions}`;
  });
  return [`*Tasks in ${escapeSlack(status)} for ${afterDays}+ days*`, ...lines].join("\n");
}
