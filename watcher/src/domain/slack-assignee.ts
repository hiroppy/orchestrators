const SLACK_USER_MENTION = /^<@([A-Z0-9]+)>$/i;
const SLACK_USER_GROUP_MENTION = /^<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>$/i;

export function slackAssigneeIdFromMention(mention: string): string | undefined {
  const userId = mention.match(SLACK_USER_MENTION)?.[1];
  if (userId) return userId;

  const userGroupId = mention.match(SLACK_USER_GROUP_MENTION)?.[1];
  return userGroupId ? `!subteam^${userGroupId}` : undefined;
}

export function isSlackAssigneeMention(value: unknown): value is string {
  return typeof value === "string" && slackAssigneeIdFromMention(value) !== undefined;
}
