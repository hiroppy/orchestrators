import type { SlackClient } from "./client-types.ts";

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
      const slackUserId = assignee.match(/^<@([A-Z0-9]+)>$/i)?.[1];
      if (!slackUserId) return assignee;

      const displayName = await resolveSlackDisplayName(client, { id: slackUserId }, logger);
      return `@${displayName}`;
    }),
  );
}
