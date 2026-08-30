import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { Task } from "../domain/task.ts";
import { normalizeStatus } from "../domain/status.ts";
import { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "../slack/client-types.ts";
import { publishWatcherEvent } from "../slack/event-publisher.ts";
import { checkReviewReadyNotificationSafely } from "./review-ready.ts";
import {
  effectiveLinearStateTypeForService,
  linearTeamForService,
  nonterminalRelatedIssuesForService,
} from "./runtime-config.ts";

export async function reconcileSlackStatusTransition({
  config,
  store,
  slackClient,
  slackChannelId,
  task,
  createStatusTransitionEvent,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: SlackClient;
  slackChannelId: string;
  task: Task;
  createStatusTransitionEvent?: (task: Task, fromStatus: string) => TaskEventInput | undefined;
}): Promise<boolean> {
  const reviewComment = config.reviewComment;
  const isInReview =
    reviewComment && normalizeStatus(task.status) === normalizeStatus(reviewComment.inReviewStatus);
  if (reviewComment && !isInReview) {
    await checkReviewReadyNotificationSafely({
      store,
      slackClient,
      task,
      inReviewStatus: reviewComment.inReviewStatus,
      delayMs: reviewComment.reviewReadyDelayMs,
    });
  }

  const linearIssue = await fetchLinearIssueState(task.issueIdentifier, {
    apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
    includeCreator: false,
    maxAttempts: 1,
  });
  if (!linearIssue?.state || !linearIssue.stateType) return false;

  if (reviewComment && isInReview) {
    await checkReviewReadyNotificationSafely({
      store,
      slackClient,
      task,
      inReviewStatus: reviewComment.inReviewStatus,
      delayMs: reviewComment.reviewReadyDelayMs,
      pullRequest: linearIssue.pullRequest,
    });
  }

  await publishWatcherEvent(
    slackClient,
    store,
    slackChannelId,
    {
      type: "updated",
      service: task.serviceName,
      issueIdentifier: task.issueIdentifier,
      issueTitle: linearIssue.title,
      issueUrl: linearIssue.url ?? task.linkUrl,
      resolvedState: linearIssue.state,
      resolvedStateType: effectiveLinearStateTypeForService(
        config,
        task.serviceName,
        linearIssue.state,
        linearIssue.stateType,
      ),
      pullRequest: linearIssue.pullRequest,
      relatedIssues: nonterminalRelatedIssuesForService(
        config,
        task.serviceName,
        linearIssue.relatedIssues,
      ),
    },
    { createStatusTransitionEvent },
  );
  return true;
}
