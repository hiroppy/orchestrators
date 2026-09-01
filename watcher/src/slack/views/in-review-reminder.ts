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
  const entriesByAssignee = new Map<string, InReviewReminderEntry[]>();
  for (const entry of entries) {
    const assignees = entry.assignees.length > 0 ? entry.assignees : ["Unassigned"];
    for (const assignee of assignees) {
      const assignedEntries = entriesByAssignee.get(assignee) ?? [];
      assignedEntries.push(entry);
      entriesByAssignee.set(assignee, assignedEntries);
    }
  }
  const lines = [...entriesByAssignee].flatMap(([assignee, assignedEntries]) => [
    `• ${assignee}`,
    ...assignedEntries.map((entry) => `  ◦ ${taskLink(entry)}`),
  ]);
  return [`*Tasks in ${escapeSlack(status)} for ${afterDays}+ days*`, ...lines].join("\n");
}

function taskLink({ issueIdentifier, title, threadLink }: InReviewReminderEntry): string {
  const label = `${issueIdentifier}: ${title}`;
  return threadLink ? `<${threadLink}|${escapeSlackLinkLabel(label)}>` : escapeSlack(label);
}
