import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";
import {
  findPullRequest as findPullRequestDefault,
  findPullRequestByUrl as findPullRequestByUrlDefault,
} from "../integrations/github.ts";
import { fetchLinearIssueState, TransientLinearError } from "../integrations/linear.ts";
import { notificationIsEligible } from "../slack/notifications.ts";
import { linearTeamForService } from "./runtime-config.ts";
import { reviewReactionForStatus } from "./review-reactions.ts";

const creatorMentionCache = new Map<string, string | null>();

export class RetryablePollError extends Error {}

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
    includeCreator: false,
    maxAttempts: isEnded ? config.endedTaskRetry.maxAttempts : 1,
    retryDelayMs: isEnded ? config.endedTaskRetry.delayMs : 0,
  });
  const resolvedState = linearIssue?.state ?? event.state;
  const reaction = reviewReactionForStatus(config, resolvedState);
  let pullRequest = (await github.findPullRequest(event, { reaction })) ?? undefined;
  let reactionLookupSucceeded = !reaction || pullRequest?.hasConfiguredReaction !== undefined;
  if (!pullRequest && linearIssue?.pullRequest) {
    const enrichedPullRequest = await github
      .findPullRequestByUrl(linearIssue.pullRequest.url, { reaction })
      .catch(() => null);
    if (reaction)
      reactionLookupSucceeded = enrichedPullRequest?.hasConfiguredReaction !== undefined;
    pullRequest = enrichedPullRequest ?? linearIssue.pullRequest;
  }
  return {
    event: compactObject({
      ...event,
      issueTitle: linearIssue?.title,
      issueUrl: linearIssue?.url ?? event.issueUrl,
      resolvedState: linearIssue?.state,
      resolvedStateType: linearIssue?.stateType
        ? normalizeStatus(linearIssue.stateType)
        : undefined,
      pullRequest,
      relatedIssues: linearIssue?.relatedIssues,
    }),
    isAuthoritative: Boolean(linearIssue?.state) && reactionLookupSucceeded,
  };
}

export async function enrichCreatorForNotification(
  event: WatcherEvent,
  config: ResolvedWatcherRuntimeConfig,
  previousStatus: string | undefined,
  options: {
    suppress: boolean;
    forceMention?: boolean;
    slackClient?: WebClient;
  },
): Promise<WatcherEvent> {
  const currentStatus = event.resolvedState ?? event.state ?? "Unknown";
  if (
    options.suppress ||
    !notificationIsEligible(
      config.mention,
      previousStatus,
      currentStatus,
      event.type,
      options.forceMention,
    )
  ) {
    return event;
  }
  if (event.issueIdentifier === `watcher:${event.service}`) return event;

  let linearIssue;
  try {
    linearIssue = await fetchLinearIssueState(event.issueIdentifier, {
      apiKey: linearTeamForService(config, event.service)?.apiKey,
      includeCreator: true,
      maxAttempts: 1,
      throwOnTransientFailure: Boolean(options.slackClient),
    });
  } catch (error) {
    if (!(error instanceof TransientLinearError)) throw error;
    throw new RetryablePollError(
      `Could not fetch Linear creator for notification: ${event.issueIdentifier}`,
    );
  }
  if (!linearIssue) return event;
  return enrichCreatorMention(
    compactObject({
      ...event,
      creatorName: linearIssue.creatorName,
      creatorEmail: linearIssue.creatorEmail,
    }),
    options.slackClient,
  );
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

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function compactObject<T extends object>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  ) as T;
}
