import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";
import { normalizeStatus } from "../domain/status.ts";
import {
  findPullRequest as findPullRequestDefault,
  findPullRequestByUrl as findPullRequestByUrlDefault,
} from "../integrations/github.ts";
import { fetchLinearIssueState } from "../integrations/linear.ts";
import { linearTeamForService } from "./runtime-config.ts";
import { shouldFetchReviewComments } from "./review-comments.ts";

const creatorMentionCache = new Map<string, string | null>();

export async function enrichEvent(
  event: WatcherEvent,
  config: ResolvedWatcherRuntimeConfig,
  github: {
    findPullRequest: typeof findPullRequestDefault;
    findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  },
): Promise<{ event: WatcherEvent; isAuthoritative: boolean }> {
  if (event.issueIdentifier === `watcher:${event.service}`) {
    return { event, isAuthoritative: true };
  }

  const isEnded = event.type === "ended";
  const linearIssue = await fetchLinearIssueState(event.issueIdentifier, {
    apiKey: linearTeamForService(config, event.service)?.apiKey,
    includeCreator: true,
    maxAttempts: isEnded ? config.endedTaskRetry.maxAttempts : 1,
    retryDelayMs: isEnded ? config.endedTaskRetry.delayMs : 0,
  });
  const resolvedState = linearIssue?.state ?? event.state;
  const includeLatestReviewComment = shouldFetchReviewComments(config, resolvedState);
  let pullRequest =
    (await github.findPullRequest(event, { includeLatestReviewComment })) ?? undefined;
  let commentLookupSucceeded =
    !includeLatestReviewComment || pullRequest?.latestReviewCommentAt !== undefined;
  if (!pullRequest && linearIssue?.pullRequest) {
    const enrichedPullRequest = await github
      .findPullRequestByUrl(linearIssue.pullRequest.url, { includeLatestReviewComment })
      .catch(() => null);
    if (includeLatestReviewComment)
      commentLookupSucceeded = enrichedPullRequest?.latestReviewCommentAt !== undefined;
    pullRequest = enrichedPullRequest ?? linearIssue.pullRequest;
  }
  return {
    event: compactObject({
      ...event,
      linearIssueId: linearIssue?.id,
      issueTitle: linearIssue?.title,
      creatorName: linearIssue?.creatorName,
      creatorEmail: linearIssue?.creatorEmail,
      issueUrl: linearIssue?.url ?? event.issueUrl,
      resolvedState: linearIssue?.state,
      resolvedStateType: linearIssue?.stateType
        ? normalizeStatus(linearIssue.stateType)
        : undefined,
      pullRequest,
      relatedIssues: linearIssue?.relatedIssues,
    }),
    isAuthoritative: Boolean(linearIssue?.state) && commentLookupSucceeded,
  };
}

export async function enrichCreatorAssignee(
  event: WatcherEvent,
  slackClient?: WebClient,
): Promise<WatcherEvent> {
  if (event.issueIdentifier === `watcher:${event.service}`) return event;
  return enrichCreatorMention(event, slackClient);
}

async function enrichCreatorMention(
  event: WatcherEvent,
  slackClient?: WebClient,
): Promise<WatcherEvent> {
  const email = event.creatorEmail?.trim().toLowerCase();
  if (!email || !slackClient) return withCreatorName(event);

  if (creatorMentionCache.has(email)) {
    const cached = creatorMentionCache.get(email);
    return cached ? { ...event, creatorMention: cached } : withCreatorName(event);
  }

  try {
    const response = await slackClient.users.lookupByEmail({ email });
    const userId = response.user?.id;
    if (userId) {
      const mention = `<@${userId}>`;
      creatorMentionCache.set(email, mention);
      return { ...event, creatorMention: mention };
    }
  } catch (error) {
    if (isSlackUserNotFound(error)) {
      creatorMentionCache.set(email, null);
      return withCreatorName(event);
    }
    console.warn(`Could not resolve Linear creator in Slack for ${event.issueIdentifier}:`, error);
  }

  return withCreatorName(event);
}

function isSlackUserNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "error" in error.data &&
    error.data.error === "users_not_found"
  );
}

function withCreatorName(event: WatcherEvent): WatcherEvent {
  return event.creatorName
    ? { ...event, creatorMention: escapeSlackText(event.creatorName) }
    : event;
}

function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function compactObject<T extends object>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  ) as T;
}
