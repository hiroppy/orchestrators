import { isSlackAssigneeMention } from "./assignee.ts";

export function initialTaskAssignees(
  defaultAssignees: string[],
  creatorMention?: string | null,
): string[] {
  return [...new Set([creatorMention, ...defaultAssignees].filter(isSlackAssigneeMention))];
}
