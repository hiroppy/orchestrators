import type { GitHubReaction, PullRequest, Task } from "../domain/types.ts";

const slackReactionByGitHubReaction: Record<GitHubReaction, string> = {
  THUMBS_UP: "+1",
  THUMBS_DOWN: "-1",
  LAUGH: "laughing",
  HOORAY: "tada",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

interface PullRequestReactionSlackClient {
  reactions: {
    add(args: { channel: string; name: string; timestamp: string }): Promise<unknown>;
    get(args: { channel: string; timestamp: string }): Promise<{
      message?: { reactions?: Array<{ name?: string }> };
    }>;
    remove(args: { channel: string; name: string; timestamp: string }): Promise<unknown>;
  };
}

export async function syncPullRequestReactions(
  client: PullRequestReactionSlackClient,
  task: Task | undefined,
  pullRequest: PullRequest | undefined,
): Promise<void> {
  if (!task?.parentChannelId || !task.parentMessageTs || !pullRequest?.reactions) return;

  const desiredReactions = new Set(
    pullRequest.reactions.map((reaction) => slackReactionByGitHubReaction[reaction]),
  );
  for (const name of desiredReactions) {
    try {
      await client.reactions.add({
        channel: task.parentChannelId,
        name,
        timestamp: task.parentMessageTs,
      });
    } catch (error) {
      if (!hasSlackError(error, "already_reacted")) throw error;
    }
  }

  const response = await client.reactions.get({
    channel: task.parentChannelId,
    timestamp: task.parentMessageTs,
  });
  const currentReactions = new Set(
    response.message?.reactions?.flatMap(({ name }) => (name ? [name] : [])) ?? [],
  );

  for (const name of currentReactions) {
    if (desiredReactions.has(name) || !isMirroredReaction(name)) continue;
    try {
      await client.reactions.remove({
        channel: task.parentChannelId,
        name,
        timestamp: task.parentMessageTs,
      });
    } catch (error) {
      if (!hasSlackError(error, "no_reaction")) throw error;
    }
  }
}

export async function syncPullRequestReactionsSafely(
  ...args: Parameters<typeof syncPullRequestReactions>
): Promise<void> {
  try {
    await syncPullRequestReactions(...args);
  } catch (error) {
    console.error("Pull request reaction sync failed; it will be retried:", error);
  }
}

function isMirroredReaction(value: string): boolean {
  return Object.values(slackReactionByGitHubReaction).includes(value);
}

function hasSlackError(error: unknown, expected: string): boolean {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  if (!data || typeof data !== "object" || !("error" in data)) return false;
  return data.error === expected;
}
