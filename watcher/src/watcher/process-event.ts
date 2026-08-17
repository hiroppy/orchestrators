import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { publishWatcherEvent } from "../slack/event-publisher.ts";
import { checkReviewReadyNotificationSafely } from "./review-ready.ts";
import { requeueReviewTask } from "./review-requeue.ts";
import type { ReviewRequeueDecision } from "./review-comments.ts";
import { nonterminalRelatedIssuesForService } from "./runtime-config.ts";
import { createPendingStatusHookEvent, deliverPendingStatusHooksSafely } from "./status-hooks.ts";

export async function processWatcherEvent({
  config,
  store,
  slackClient,
  slackChannelId,
  event,
  reviewDecision,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  slackChannelId: string;
  event: WatcherEvent;
  reviewDecision: ReviewRequeueDecision;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const publishEvent = {
    ...event,
    relatedIssues: nonterminalRelatedIssuesForService(config, event.service, event.relatedIssues),
  };
  await publishWatcherEvent(slackClient, store, slackChannelId, publishEvent, {
    defaultAssignees: config.defaultAssignees ?? [],
    createStatusTransitionEvent: (task, fromStatus) =>
      createPendingStatusHookEvent(
        config.statusHooks ?? [],
        task,
        fromStatus,
        task.status,
        event.pullRequest,
      ),
    afterPublish: async (task) => {
      await deliverPendingStatusHooksSafely({
        hooks: config.statusHooks ?? [],
        store,
        slackClient,
        watcherChannelId: slackChannelId,
        taskId: task.id,
      });
    },
  });
  await requeueReviewTask({
    config,
    store,
    slackClient,
    watcherChannelId: slackChannelId,
    event,
    decision: reviewDecision,
    updateLinearStatus,
  });
  const task = store.getTask(taskIdFor(event.service, event.issueIdentifier));
  if (task && config.reviewComment) {
    await checkReviewReadyNotificationSafely({
      store,
      slackClient,
      task,
      inReviewStatus: config.reviewComment.inReviewStatus,
      delayMs: config.reviewComment.reviewReadyDelayMs,
      pullRequest: event.pullRequest,
    });
  }
}
