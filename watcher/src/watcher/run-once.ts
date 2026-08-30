import type { WebClient } from "@slack/web-api";
import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { SnapshotsByService } from "../domain/snapshot.ts";
import {
  findPullRequest as findPullRequestDefault,
  findPullRequestByUrl as findPullRequestByUrlDefault,
} from "../integrations/github/pull-requests.ts";
import { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import { deliverPendingStatusTimelines } from "../slack/status-timeline.ts";
import { diffSnapshots, normalizeSnapshot } from "./diff.ts";
import { enrichCreatorAssignee, enrichEvent } from "./event-enrichment.ts";
import { processWatcherEvent } from "./process-event.ts";
import { reconcileLinearStatuses } from "./reconcile-linear-statuses.ts";
import { decideReviewRequeue } from "./review-comments.ts";
import { deliverPendingReviewRequeueNotifications } from "./review-requeue-delivery.ts";
import {
  clearInactivePullRequestMonitorState,
  runPullRequestMonitors,
  type PullRequestMonitorState,
} from "./pull-request-monitors.ts";
import { syncPullRequestReactionsSafely } from "./pull-request-reactions.ts";
import { syncPullRequestStatuses } from "./pull-request-status-sync.ts";
import { effectiveLinearStateTypeForService, serviceConfigFor } from "./runtime-config.ts";
import { collectSnapshots } from "./snapshots.ts";
import { deliverPendingStatusHooksSafely } from "./status-hooks.ts";
import { publishTaskActivities } from "./task-activity.ts";

interface RunOnceOptions {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  slackChannelId: string;
  findPullRequest?: typeof findPullRequestDefault;
  findPullRequestByUrl?: typeof findPullRequestByUrlDefault;
  fetchLinearIssue?: typeof fetchLinearIssueState;
  updateLinearStatus?: typeof updateLinearIssueStatus;
  runPeriodicMaintenance?: boolean;
  persistedTerminalTaskIds?: ReadonlySet<string>;
  pullRequestMonitorState?: PullRequestMonitorState;
}

export async function runOnce({
  config,
  store,
  slackClient,
  slackChannelId,
  findPullRequest = findPullRequestDefault,
  findPullRequestByUrl = findPullRequestByUrlDefault,
  fetchLinearIssue = fetchLinearIssueState,
  updateLinearStatus = updateLinearIssueStatus,
  runPeriodicMaintenance = true,
  persistedTerminalTaskIds = new Set(),
  pullRequestMonitorState = new Map(),
}: RunOnceOptions) {
  let pendingPersistedTerminalTaskIds = new Set(persistedTerminalTaskIds);
  if (runPeriodicMaintenance) {
    await deliverPendingStatusTimelines(slackClient, store);
    await deliverPendingStatusHooksSafely({
      hooks: [],
      hooksForService: (serviceName) => serviceConfigFor(config, serviceName)?.statusHooks ?? [],
      store,
      slackClient,
      watcherChannelId: slackChannelId,
    });
    await deliverPendingReviewRequeueNotifications(store, slackClient);
  }
  const previous = store.getSnapshots();
  const current = await collectSnapshots(config.services, previous);
  const events = diffSnapshots(previous, current, config);
  const processedTaskIds = new Set<string>();
  const preparedEvents = [];

  for (const event of events) {
    const enrichedEvent = await enrichEvent(event, config, {
      findPullRequest,
      findPullRequestByUrl,
    });
    const effectiveEvent = {
      ...enrichedEvent,
      resolvedStateType: effectiveLinearStateTypeForService(
        config,
        enrichedEvent.service,
        enrichedEvent.resolvedState,
        enrichedEvent.resolvedStateType,
      ),
    };
    processedTaskIds.add(taskIdFor(event.service, event.issueIdentifier));
    const reviewDecision = decideReviewRequeue(config, store, effectiveEvent);
    preparedEvents.push({
      event: await enrichCreatorAssignee(effectiveEvent, slackClient),
      reviewDecision,
    });
  }

  for (const prepared of preparedEvents) {
    const { event: enrichedEvent, reviewDecision } = prepared;
    await processWatcherEvent({
      config,
      store,
      slackClient,
      slackChannelId,
      event: enrichedEvent,
      reviewDecision,
      updateLinearStatus,
    });
    await syncPullRequestReactionsSafely(
      slackClient,
      store.getTask(taskIdFor(enrichedEvent.service, enrichedEvent.issueIdentifier)),
      enrichedEvent.pullRequest,
    );
  }

  store.replaceSnapshots(current);
  await publishTaskActivities(slackClient, store, current);
  clearInactivePullRequestMonitorState({
    config,
    store,
    inReviewStatus: config.reviewComment?.inReviewStatus,
    state: pullRequestMonitorState,
  });
  if (runPeriodicMaintenance) {
    const findPeriodicPullRequestByUrl = cachePullRequestLookups(findPullRequestByUrl);
    await syncPullRequestStatuses({
      config,
      store,
      fetchLinearIssue,
      findPullRequestByUrl: findPeriodicPullRequestByUrl,
      updateLinearStatus,
    });
    pendingPersistedTerminalTaskIds = await reconcileLinearStatuses({
      config,
      store,
      slackClient,
      slackChannelId,
      skipTaskIds: new Set([...processedTaskIds, ...taskIdsInSnapshots(current)]),
      findPullRequestByUrl: findPeriodicPullRequestByUrl,
      updateLinearStatus,
      persistedTerminalTaskIds,
    });
    await runPullRequestMonitors({
      config,
      store,
      slackClient,
      watcherChannelId: slackChannelId,
      inReviewStatus: config.reviewComment?.inReviewStatus,
      state: pullRequestMonitorState,
      findPullRequestByUrl: findPeriodicPullRequestByUrl,
    });
  }
  return {
    events,
    current,
    pendingPersistedTerminalTaskIds,
    persistedTerminalReconciliationComplete: pendingPersistedTerminalTaskIds.size === 0,
  };
}

export function cachePullRequestLookups(
  findPullRequestByUrl: typeof findPullRequestByUrlDefault,
): typeof findPullRequestByUrlDefault {
  type Observation = ReturnType<typeof findPullRequestByUrlDefault>;
  const observations = new Map<string, { basic?: Observation; enriched?: Observation }>();
  return (url, options) => {
    const entry = observations.get(url) ?? {};
    const needsEnrichment = options?.includeLatestReviewComment === true;
    const existing = needsEnrichment ? entry.enriched : (entry.enriched ?? entry.basic);
    if (existing) return existing;
    const observation = findPullRequestByUrl(url, options);
    if (needsEnrichment) entry.enriched = observation;
    else entry.basic = observation;
    observations.set(url, entry);
    return observation;
  };
}

function taskIdsInSnapshots(snapshots: SnapshotsByService): string[] {
  const ids: string[] = [];
  for (const [service, snapshot] of Object.entries(snapshots)) {
    const normalized = normalizeSnapshot(snapshot);
    for (const row of [...normalized.running, ...normalized.retrying, ...normalized.blocked]) {
      const identifier = row.issue_identifier ?? row.issueIdentifier;
      if (identifier) ids.push(taskIdFor(service, identifier));
    }
  }
  return ids;
}
