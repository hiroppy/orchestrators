export function buildHelpMessage(botName: string): string {
  const commandPrefix = `@${botName.replaceAll("`", "'").replace(/\s+/g, " ")}`;
  return [
    "*Available commands*",
    `• \`${commandPrefix} status\`\n  Show tracked Todo, In Progress, and In Review tasks.`,
    `• \`${commandPrefix} assign @user-or-group|username|me\`\n  Add a user or user group to notifications for a tracked task. Run this in the task thread.`,
    `• \`${commandPrefix} unassign @user-or-group|username|me\`\n  Remove a user or user group from notifications for a tracked task. Run this in the task thread.`,
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

export const EVENT_LABELS: Record<EventType, string> = {
  started: "Started",
  updated: "Updated",
  retrying: "Retrying",
  blocked: "Blocked",
  ended: "Ended",
  recovered: "Recovered",
};

import type { EventType } from "orchestrator-config";
