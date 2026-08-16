import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebClient } from "@slack/web-api";

import { resolveWatcherConfig, type ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { createDatabase } from "../persistence/database.ts";
import { diffSnapshots, normalizeSnapshot } from "./diff.ts";
import {
  createLinearWorkpadReply,
  fetchLinearIssueState,
  fetchLinearIssueStateSummaries,
  updateLinearIssueStatus,
} from "../integrations/linear.ts";
import { downloadSlackFile } from "../integrations/slack.ts";
import { isLinearRateLimitError } from "../integrations/linear-client.ts";
import {
  findPullRequest as findPullRequestDefault,
  findPullRequestByUrl as findPullRequestByUrlDefault,
  requireGitHubCli,
} from "../integrations/github.ts";
import { createSlackApp, publishWatcherEvent, type SlackClient } from "../slack/app.ts";
import { deliverPendingStatusTimelines } from "../slack/status-timeline.ts";
import { DEFAULT_DATABASE_PATH, taskIdFor, WatcherStore } from "../persistence/store.ts";
import type {
  OrchestratorConfig,
  SnapshotsByService,
  Task,
  WatcherEvent,
} from "../domain/types.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import { createPendingStatusHookEvent, deliverPendingStatusHooksSafely } from "./status-hooks.ts";
import { collectSnapshots } from "./snapshots.ts";
import { publishTaskActivities } from "./task-activity.ts";
import { linearTeamForService, resolveLinearWorkflowStatuses } from "./runtime-config.ts";
import { enrichCreatorAssignee, enrichEvent } from "./event-enrichment.ts";
import {
  decideReviewRequeue,
  shouldFetchReviewComments,
  type ReviewRequeueDecision,
} from "./review-comments.ts";
import { deliverPendingReviewRequeueNotifications } from "./review-requeue-delivery.ts";
import { requeueReviewTask } from "./review-requeue.ts";
import { checkReviewReadyNotificationSafely } from "./review-ready.ts";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PERIODIC_MAINTENANCE_INTERVAL_MS = 30_000;
const POLL_FAILURE_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES = 3;

export async function requireSlackBotUserId(client: Pick<WebClient, "auth">): Promise<string> {
  const response = await client.auth.test();
  if (!response.user_id) throw new Error("Slack auth.test did not return a bot user ID.");
  return response.user_id;
}

export async function startWatcher(config: OrchestratorConfig): Promise<void> {
  const startedAt = new Date();
  const unresolvedConfig = resolveWatcherConfig(config, { requireSlack: true });
  const runtimeConfig = await resolveLinearWorkflowStatuses(unresolvedConfig);
  await requireGitHubCli();
  const slackConfig = runtimeConfig.slack!;
  const client = new WebClient(slackConfig.botToken);
  const botUserId = await requireSlackBotUserId(client);
  const databasePath = resolve(rootDirectory, DEFAULT_DATABASE_PATH);

  const database = createDatabase(databasePath);
  const store = new WatcherStore(database.db);
  store.syncDefinitions(runtimeConfig.services, runtimeConfig.linearTeams);

  const app = createSlackApp({
    botToken: slackConfig.botToken,
    appToken: slackConfig.appToken,
    updateLinearStatus: async (task, status) => {
      const team = linearTeamForService(runtimeConfig, task.serviceName);
      await updateLinearIssueStatus(task.issueIdentifier, status, {
        apiKey: team?.apiKey,
        teamId: team?.teamId,
      });
    },
    createLinearWorkpadReply: async (task, reply, idempotencyKey) =>
      createLinearWorkpadReply(task.issueIdentifier, reply.text, {
        apiKey: linearTeamForService(runtimeConfig, task.serviceName)?.apiKey,
        idempotencyKey,
        authorName: reply.authorName,
        files: reply.files.map((file) => ({
          filename: file.filename,
          contentType: file.contentType,
          loadData: () =>
            downloadSlackFile(file.downloadUrl, slackConfig.botToken, {
              expectedSize: file.size,
            }),
        })),
      }),
    store,
    botUserId,
    takePr: {
      authorizedChannelId: slackConfig.channelId,
      services: runtimeConfig.services,
      linearTeams: runtimeConfig.linearTeams,
      symphoniesDirectory: resolve(rootDirectory, "symphonies"),
      defaultAssignees: runtimeConfig.defaultAssignees,
    },
    statusSummary: {
      serviceNames: runtimeConfig.services.map(({ name }) => name),
      startedAt,
    },
    createStatusTransitionEvent: (task, fromStatus, toStatus) =>
      createPendingStatusHookEvent(runtimeConfig.statusHooks, task, fromStatus, toStatus),
    onStatusTransition: async (task, _fromStatus, _toStatus, slackClient) => {
      await reconcileSlackStatusTransition({
        config: runtimeConfig,
        store,
        slackClient,
        slackChannelId: slackConfig.channelId,
        task,
      });
      await deliverPendingStatusHooksSafely({
        hooks: runtimeConfig.statusHooks,
        store,
        slackClient,
        watcherChannelId: slackConfig.channelId,
        taskId: task.id,
      });
    },
  });

  let nextPeriodicMaintenanceAt = 0;
  try {
    await app.start();
    await runWatcherPollingLoop(
      async () => {
        const runPeriodicMaintenance = performance.now() >= nextPeriodicMaintenanceAt;
        await runOnce({
          config: runtimeConfig,
          store,
          slackClient: client,
          slackChannelId: slackConfig.channelId,
          runPeriodicMaintenance,
        });
        if (runPeriodicMaintenance) {
          nextPeriodicMaintenanceAt = performance.now() + PERIODIC_MAINTENANCE_INTERVAL_MS;
        }
      },
      runtimeConfig.pollIntervalMs,
      { failureRetryIntervalMs: POLL_FAILURE_RETRY_INTERVAL_MS },
    );
  } finally {
    await app.stop();
    database.close();
  }
}

export async function runWatcherPollingLoop(
  poll: () => Promise<unknown>,
  pollIntervalMs: number,
  options: {
    maxConsecutiveFailures?: number;
    failureRetryIntervalMs?: number;
    shouldContinue?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const maxConsecutiveFailures =
    options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES;
  const failureRetryIntervalMs = options.failureRetryIntervalMs ?? pollIntervalMs;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const sleepBetweenPolls = options.sleep ?? sleep;
  const reportError =
    options.reportError ?? ((error) => console.error("Watcher poll failed; retrying:", error));
  let consecutiveFailures = 0;

  while (shouldContinue()) {
    let nextPollDelayMs = pollIntervalMs;
    try {
      await poll();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      reportError(error);
      if (consecutiveFailures >= maxConsecutiveFailures) throw error;
      nextPollDelayMs = failureRetryIntervalMs;
    }
    if (shouldContinue()) await sleepBetweenPolls(nextPollDelayMs);
  }
}

export async function reconcileSlackStatusTransition({
  config,
  store,
  slackClient,
  slackChannelId,
  task,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: SlackClient;
  slackChannelId: string;
  task: Task;
}): Promise<void> {
  const reviewComment = config.reviewComment;
  const isInReview =
    reviewComment && normalizeStatus(task.status) === normalizeStatus(reviewComment.inReviewStatus);
  if (reviewComment && !isInReview) {
    await checkReviewReadyNotificationSafely({
      store,
      slackClient,
      task,
      inReviewStatus: reviewComment.inReviewStatus,
    });
  }

  const linearIssue = await fetchLinearIssueState(task.issueIdentifier, {
    apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
    includeCreator: false,
    maxAttempts: 1,
  });
  if (!linearIssue?.state || !linearIssue.stateType) return;

  if (reviewComment && isInReview) {
    await checkReviewReadyNotificationSafely({
      store,
      slackClient,
      task,
      inReviewStatus: reviewComment.inReviewStatus,
      pullRequest: linearIssue.pullRequest,
    });
  }

  await publishWatcherEvent(slackClient, store, slackChannelId, {
    type: "updated",
    service: task.serviceName,
    issueIdentifier: task.issueIdentifier,
    issueTitle: linearIssue.title,
    issueUrl: linearIssue.url ?? task.linkUrl,
    resolvedState: linearIssue.state,
    resolvedStateType: normalizeStatus(linearIssue.stateType),
    pullRequest: linearIssue.pullRequest,
    relatedIssues: linearIssue.relatedIssues,
  });
}

interface RunOnceOptions {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  slackChannelId: string;
  findPullRequest?: typeof findPullRequestDefault;
  findPullRequestByUrl?: typeof findPullRequestByUrlDefault;
  updateLinearStatus?: typeof updateLinearIssueStatus;
  runPeriodicMaintenance?: boolean;
}

export async function runOnce({
  config,
  store,
  slackClient,
  slackChannelId,
  findPullRequest = findPullRequestDefault,
  findPullRequestByUrl = findPullRequestByUrlDefault,
  updateLinearStatus = updateLinearIssueStatus,
  runPeriodicMaintenance = true,
}: RunOnceOptions) {
  if (runPeriodicMaintenance) {
    await deliverPendingStatusTimelines(slackClient, store);
    await deliverPendingStatusHooksSafely({
      hooks: config.statusHooks ?? [],
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
    processedTaskIds.add(taskIdFor(event.service, event.issueIdentifier));
    const reviewDecision = decideReviewRequeue(config, store, enrichedEvent);
    preparedEvents.push({
      event: await enrichCreatorAssignee(enrichedEvent, slackClient),
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
  }

  store.replaceSnapshots(current);
  await publishTaskActivities(slackClient, store, current);
  if (runPeriodicMaintenance) {
    await reconcileLinearStatuses({
      config,
      store,
      slackClient,
      slackChannelId,
      skipTaskIds: new Set([...processedTaskIds, ...taskIdsInSnapshots(current)]),
      findPullRequestByUrl,
      updateLinearStatus,
    });
  }
  return { events, current };
}

async function reconcileLinearStatuses({
  config,
  store,
  slackClient,
  slackChannelId,
  skipTaskIds,
  findPullRequestByUrl,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  slackChannelId: string;
  skipTaskIds: Set<string>;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const tasks = store.getTasksForLinearSync().filter((task) => {
    const hasCurrentLinearState =
      skipTaskIds.has(task.id) &&
      Boolean(task.linearStateType) &&
      !shouldFetchReviewComments(config, task.status);
    return !(
      hasCurrentLinearState ||
      task.issueIdentifier.startsWith("watcher:") ||
      !task.parentChannelId ||
      !task.parentMessageTs
    );
  });
  const summaries = new Map<string, Awaited<ReturnType<typeof fetchLinearIssueStateSummaries>>>();
  const rateLimitedTeams = new Set<string>();
  for (const task of tasks) {
    const teamName = config.services.find(({ name }) => name === task.serviceName)?.linearTeam;
    if (!teamName || summaries.has(teamName) || rateLimitedTeams.has(teamName)) continue;
    const teamTasks = tasks.filter(
      (candidate) =>
        config.services.find(({ name }) => name === candidate.serviceName)?.linearTeam === teamName,
    );
    try {
      summaries.set(
        teamName,
        await fetchLinearIssueStateSummaries(
          teamTasks.map(({ issueIdentifier }) => issueIdentifier),
          { apiKey: config.linearTeams[teamName]?.apiKey },
        ),
      );
    } catch (error) {
      if (!isLinearRateLimitError(error)) throw error;
      rateLimitedTeams.add(teamName);
    }
  }

  for (const task of tasks) {
    const teamName = config.services.find(({ name }) => name === task.serviceName)?.linearTeam;
    if (teamName && rateLimitedTeams.has(teamName)) continue;
    const summary = teamName ? summaries.get(teamName)?.get(task.issueIdentifier) : undefined;
    if (summary?.state) {
      const fetchReviewComments = shouldFetchReviewComments(config, summary.state);
      const sameStatus = normalizeStatus(summary.state) === normalizeStatus(task.status);
      const enteredTerminalState = enteredTerminalLinearState(
        task.linearStateType,
        summary.stateType,
      );
      if (sameStatus && !enteredTerminalState && !fetchReviewComments) {
        if (summary.stateType) {
          store.setTaskLinearStateType(task.id, normalizeStatus(summary.stateType));
        }
        continue;
      }
    }

    const linearIssue = await fetchLinearIssueState(task.issueIdentifier, {
      apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
      includeCreator: true,
      maxAttempts: 1,
    });
    if (!linearIssue?.state) continue;
    const detailedSameStatus = normalizeStatus(linearIssue.state) === normalizeStatus(task.status);
    const detailedEnteredTerminalState = enteredTerminalLinearState(
      task.linearStateType,
      linearIssue.stateType,
    );
    const fetchDetailedReviewComments = shouldFetchReviewComments(config, linearIssue.state);
    if (detailedSameStatus && !detailedEnteredTerminalState && !fetchDetailedReviewComments) {
      if (linearIssue.stateType) {
        store.setTaskLinearStateType(task.id, normalizeStatus(linearIssue.stateType));
      }
      continue;
    }
    let pullRequest = linearIssue.pullRequest;
    if (pullRequest?.url) {
      const enrichedPullRequest = await findPullRequestByUrl(pullRequest.url, {
        includeLatestReviewComment: fetchDetailedReviewComments,
        symphonyGitHubLogins: config.reviewComment?.symphonyGitHubLogins,
      }).catch(() => null);
      pullRequest = enrichedPullRequest ?? pullRequest;
    }

    const event: WatcherEvent = {
      type: "updated",
      service: task.serviceName,
      linearIssueId: linearIssue.id,
      issueIdentifier: task.issueIdentifier,
      issueTitle: linearIssue.title,
      creatorName: linearIssue.creatorName,
      creatorEmail: linearIssue.creatorEmail,
      issueUrl: linearIssue.url ?? task.linkUrl,
      state: task.status,
      resolvedState: linearIssue.state,
      resolvedStateType: linearIssue.stateType ? normalizeStatus(linearIssue.stateType) : undefined,
      pullRequest,
      relatedIssues: linearIssue.relatedIssues,
    };
    const reviewDecision = decideReviewRequeue(config, store, event);
    if (!reviewDecision.shouldRequeue && config.reviewComment) {
      await checkReviewReadyNotificationSafely({
        store,
        slackClient,
        task: { ...task, status: linearIssue.state },
        inReviewStatus: config.reviewComment.inReviewStatus,
        pullRequest,
      });
    }
    if (detailedSameStatus && !reviewDecision.shouldRequeue && !detailedEnteredTerminalState) {
      if (linearIssue.stateType) {
        store.setTaskLinearStateType(task.id, normalizeStatus(linearIssue.stateType));
      }
      continue;
    }

    const enrichedEvent = await enrichCreatorAssignee(event, slackClient);

    await processWatcherEvent({
      config,
      store,
      slackClient,
      slackChannelId,
      event: enrichedEvent,
      reviewDecision,
      updateLinearStatus,
    });
  }
}

async function processWatcherEvent({
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
  await publishWatcherEvent(slackClient, store, slackChannelId, event, {
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
      pullRequest: event.pullRequest,
    });
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
