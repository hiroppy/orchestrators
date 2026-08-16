import { findPullRequestByUrl } from "../../integrations/github/index.ts";
import type { PullRequest } from "../../domain/github.ts";
import type { WatcherStore } from "../../persistence/store.ts";
import type { SlackClient } from "../client-types.ts";
import { escapeSlack } from "../view-formatting.ts";
import { parseGitHubPullRequestUrl } from "../take-pr-parsing.ts";
import { buildTakePrServiceSelectionBlocks } from "./view.ts";
import { hasCompletePullRequestMetadata, singleLine } from "./validation.ts";
import { MAX_STATIC_SELECT_OPTIONS, type TakePrMentionEvent, type TakePrOptions } from "./types.ts";
import { postTakePrError, stableSlackClientMessageId, stableTakePrRequestId } from "./utils.ts";

export async function handleTakePrMention(
  event: TakePrMentionEvent,
  args: string[],
  client: Pick<SlackClient, "chat">,
  logger: { error(error: unknown): void },
  store: WatcherStore,
  options: TakePrOptions,
): Promise<void> {
  const threadTs = event.threadTs ?? event.ts;
  if (event.channel !== options.authorizedChannelId) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      "The take-pr command is only allowed in the configured watcher channel.",
    );
    return;
  }
  const pullRequestUrl = args.length === 1 ? parseGitHubPullRequestUrl(args[0]) : undefined;
  if (!pullRequestUrl) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      "Usage: `@Orchestrators take-pr <GitHub PR URL>`",
    );
    return;
  }
  if (options.services.length === 0) {
    await postTakePrError(client, event.channel, threadTs, "No enabled services are configured.");
    return;
  }
  if (options.services.length > MAX_STATIC_SELECT_OPTIONS) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      `Cannot show more than ${MAX_STATIC_SELECT_OPTIONS} enabled services.`,
    );
    return;
  }

  let pullRequest: PullRequest | null;
  try {
    pullRequest = await (options.findPullRequest ?? findPullRequestByUrl)(pullRequestUrl);
  } catch (error) {
    logger.error(error);
    pullRequest = null;
  }
  if (!hasCompletePullRequestMetadata(pullRequest)) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      "Could not load the GitHub pull request. Check that the URL points to an accessible PR.",
    );
    return;
  }
  if (pullRequest.state.toUpperCase() !== "OPEN") {
    await postTakePrError(client, event.channel, threadTs, "The GitHub pull request must be open.");
    return;
  }
  const requestId = (options.createRequestId ?? stableTakePrRequestId)(event);
  store.createPendingTakePrRequest({
    id: requestId,
    pullRequestUrl,
    repository: pullRequest.repository,
    pullRequestTitle: pullRequest.title,
    pullRequestBody: pullRequest.body ?? "",
    headBranch: pullRequest.headRefName,
    baseBranch: pullRequest.baseRefName,
    channelId: event.channel,
    threadTs,
    requesterSlackUserId: event.user,
  });

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: `Choose a service for ${escapeSlack(pullRequest.repository)}#${pullRequest.number ?? "?"}: ${escapeSlack(singleLine(pullRequest.title))}`,
    blocks: buildTakePrServiceSelectionBlocks(requestId, pullRequest, options.services),
    client_msg_id: stableSlackClientMessageId("selection", requestId),
    unfurl_links: false,
    unfurl_media: false,
  });
}
