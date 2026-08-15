import { slackAssigneeIdFromMention } from "../domain/slack-assignee.ts";
import type { SlackClient } from "./client-types.ts";

const USERS_PAGE_SIZE = 200;

export async function resolveSlackAssigneeId(
  client: Pick<SlackClient, "users">,
  value: string,
  currentUserId?: string,
): Promise<string | undefined> {
  const mentionedAssigneeId = slackAssigneeIdFromMention(value);
  if (mentionedAssigneeId) return mentionedAssigneeId;
  if (value.toLowerCase() === "me") return currentUserId;
  if (!client.users?.list) return undefined;

  const normalizedValue = value.toLowerCase();
  const matchingUserIds = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await client.users.list({
      limit: USERS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const member of response.members ?? []) {
      if (!member.id) continue;
      const names = [
        member.name,
        member.real_name,
        member.profile?.display_name,
        member.profile?.real_name,
      ];
      if (names.some((name) => name?.toLowerCase() === normalizedValue)) {
        matchingUserIds.add(member.id);
      }
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  if (matchingUserIds.size !== 1) return undefined;
  return matchingUserIds.values().next().value;
}

export async function resolveSlackDisplayName(
  client: Pick<SlackClient, "users">,
  user?: { id?: string },
  logger?: { error(error: unknown): void },
): Promise<string> {
  const fallback = user?.id ?? "Unknown user";
  if (!user?.id || !client.users) return fallback;

  try {
    const response = await client.users.info({ user: user.id });
    return (
      response.user?.profile?.display_name ||
      response.user?.real_name ||
      response.user?.name ||
      fallback
    );
  } catch (error) {
    logger?.error(
      new Error(
        `Failed to resolve Slack display name for ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return fallback;
  }
}

export async function resolveSlackAssigneeLabels(
  client: Pick<SlackClient, "users">,
  assignees: string[],
  logger?: { error(error: unknown): void },
): Promise<string[]> {
  return Promise.all(
    assignees.map(async (assignee) => {
      const userGroup = assignee.match(/^<!subteam\^([A-Z0-9]+)(?:\|([^>]+))?>$/i);
      if (userGroup) return `@${userGroup[2] ?? userGroup[1]}`;
      const slackUserId = assignee.match(/^<@([A-Z0-9]+)>$/i)?.[1];
      if (!slackUserId) return assignee;

      const displayName = await resolveSlackDisplayName(client, { id: slackUserId }, logger);
      return `@${displayName}`;
    }),
  );
}
