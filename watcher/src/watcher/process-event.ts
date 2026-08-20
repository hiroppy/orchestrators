import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { Task } from "../domain/task.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { publishWatcherEvent } from "../slack/event-publisher.ts";
import { checkReviewReadyNotificationSafely } from "./review-ready.ts";
import { requeueReviewTask } from "./review-requeue.ts";
import type { ReviewRequeueDecision } from "./review-comments.ts";
import { nonterminalRelatedIssuesForService, serviceConfigFor } from "./runtime-config.ts";
import { createPendingStatusHookEvent, deliverPendingStatusHooksSafely } from "./status-hooks.ts";

export async function processWatcherEvent({
  config,
  store,
  slackClient,
  slackChannelId,
  event,
  reviewDecision,
  updateLinearStatus,
  onStatusTransition,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  slackChannelId: string;
  event: WatcherEvent;
  reviewDecision: ReviewRequeueDecision;
  updateLinearStatus: typeof updateLinearIssueStatus;
  onStatusTransition?: (task: Task) => void | Promise<void>;
}): Promise<void> {
  const service = serviceConfigFor(config, event.service);
  const hooks = service?.statusHooks ?? [];
  const publishEvent = {
    ...event,
    relatedIssues: nonterminalRelatedIssuesForService(config, event.service, event.relatedIssues),
  };
  await publishWatcherEvent(slackClient, store, slackChannelId, publishEvent, {
    defaultAssignees: config.defaultAssignees ?? [],
    createStatusTransitionEvent: (task, fromStatus) =>
      createPendingStatusHookEvent(hooks, task, fromStatus, task.status, event.pullRequest),
    onStatusTransition: async (task) => {
      await onStatusTransition?.(task);
    },
    afterPublish: async (task) => {
      await deliverPendingStatusHooksSafely({
        hooks,
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
