import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebClient } from "@slack/web-api";

import {
  resolveWatcherConfig,
  type ResolvedWatcherRuntimeConfig,
  type WatcherRuntimeConfig,
  validateStatuses,
} from "../config/runtime.ts";
import { createDatabase } from "../persistence/database.ts";
import { diffSnapshots, normalizeSnapshot } from "./diff.ts";
import {
  createLinearWorkpadReply,
  fetchLinearIssueState,
  fetchLinearWorkflowStates,
  TransientLinearError,
  updateLinearIssueStatus,
} from "../integrations/linear.ts";
import { downloadSlackFile } from "../integrations/slack.ts";
import {
  findPullRequest as findPullRequestDefault,
  findPullRequestByUrl as findPullRequestByUrlDefault,
  requireGitHubCli,
} from "../integrations/github.ts";
import {
  createSlackApp,
  notificationIsEligible,
  notificationTargetsForWatcherEvent,
  publishWatcherStarted,
  publishWatcherEvent,
} from "../slack/app.ts";
import { buildTaskCard, buildThreadMessage } from "../slack/views.ts";
import { DEFAULT_DATABASE_PATH, taskIdFor, WatcherStore } from "../persistence/store.ts";
import type {
  OrchestratorConfig,
  PullRequest,
  ResolvedLinearTeamConfig,
  ServiceDefinition,
  Snapshot,
  SnapshotsByService,
  WatcherEvent,
} from "../domain/types.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const creatorMentionCache = new Map<string, string | null>();
const REVIEW_REQUEUE_EVENT = "review_requeued";
const REVIEW_REQUEUE_LIMIT_PENDING_EVENT = "review_requeue_limit_pending";
const REVIEW_REQUEUE_LIMIT_NOTIFIED_EVENT = "review_requeue_limit_notified";
const REVIEW_REQUEUE_LIMIT_EVENT = "review_requeue_limit_reached";
const REVIEW_REQUEUE_RECONCILE_PENDING_EVENT = "review_requeue_reconcile_pending";
const REVIEW_REQUEUE_RECONCILED_EVENT = "review_requeue_reconciled";
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

class RetryablePollError extends Error {}

export async function startWatcher(config: OrchestratorConfig, args: string[] = []): Promise<void> {
  const options = parseArgs(args);
  const unresolvedConfig = resolveWatcherConfig(config, {
    requireSlack: !options.dryRun,
  });
  const runtimeConfig = await resolveLinearWorkflowStatuses(unresolvedConfig);
  await requireGitHubCli();
  const databasePath = resolve(rootDirectory, DEFAULT_DATABASE_PATH);

  const database = createDatabase(databasePath);
  const store = new WatcherStore(database.db);
  store.syncDefinitions(runtimeConfig.services, runtimeConfig.linearTeams);

  const slackConfig = runtimeConfig.slack;
  const client = slackConfig ? new WebClient(slackConfig.botToken) : undefined;
  const app =
    slackConfig && !options.dryRun
      ? createSlackApp({
          botToken: slackConfig.botToken,
          appToken: slackConfig.appToken,
          updateLinearStatus: async (task, status) => {
            await updateLinearIssueStatus(task.issueIdentifier, status, {
              apiKey: linearTeamForService(runtimeConfig, task.serviceName)?.apiKey,
            });
          },
          createLinearWorkpadReply: async (task, reply, idempotencyKey) =>
            createLinearWorkpadReply(task.issueIdentifier, reply.text, {
              apiKey: linearTeamForService(runtimeConfig, task.serviceName)?.apiKey,
              idempotencyKey,
              author: reply.author,
              images: reply.images.map((image) => ({
                filename: image.filename,
                contentType: image.contentType,
                loadData: () =>
                  downloadSlackFile(image.downloadUrl, slackConfig.botToken, {
                    expectedSize: image.size,
                  }),
              })),
            }),
          store,
        })
      : undefined;

  try {
    if (app) {
      await app.start();
      try {
        await publishWatcherStarted(
          client!,
          slackConfig!.channelId,
          runtimeConfig.services.map(({ name }) => name),
        );
      } catch (error) {
        console.error("Failed to post watcher startup notification:", error);
      }
    }

    while (true) {
      await runPoll({
        config: runtimeConfig,
        store,
        slackClient: client,
        slackChannelId: slackConfig?.channelId,
        dryRun: options.dryRun,
      });

      if (options.dryRun) break;
      await sleep(runtimeConfig.pollIntervalMs);
    }
  } finally {
    if (app) await app.stop();
    database.close();
  }
}

export async function runPoll(options: RunOnceOptions): Promise<void> {
  try {
    await runOnce(options);
  } catch (error) {
    if (!(error instanceof RetryablePollError)) throw error;
    console.warn(error.message);
  }
}

interface RunOnceOptions {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient?: WebClient;
  slackChannelId?: string;
  dryRun?: boolean;
  findPullRequest?: typeof findPullRequestDefault;
  findPullRequestByUrl?: typeof findPullRequestByUrlDefault;
  updateLinearStatus?: typeof updateLinearIssueStatus;
}

export async function runOnce({
  config,
  store,
  slackClient,
  slackChannelId,
  dryRun = false,
  findPullRequest = findPullRequestDefault,
  findPullRequestByUrl = findPullRequestByUrlDefault,
  updateLinearStatus = updateLinearIssueStatus,
}: RunOnceOptions) {
  let reviewReconciliationTaskIds = new Set<string>();
  if (!dryRun) {
    if (!slackClient) throw new Error("Slack client is required.");
    await deliverPendingReviewLimitNotifications(store, slackClient);
    reviewReconciliationTaskIds = new Set(
      store.getTaskIdsWithIncompleteEvent(
        REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
        REVIEW_REQUEUE_RECONCILED_EVENT,
      ),
    );
  }

  const previous = store.getSnapshots();
  const current = await collectSnapshots(config.services, previous);
  const events = diffSnapshots(previous, current, config);
  const processedTaskIds = new Set<string>();
  const preparedEvents = [];

  for (const event of events) {
    const enrichment = await enrichEvent(event, config, {
      findPullRequest,
      findPullRequestByUrl,
    });
    processedTaskIds.add(taskIdFor(event.service, event.issueIdentifier));
    const reviewDecision = decideReviewReaction(
      config,
      store,
      enrichment.event,
      enrichment.isAuthoritative,
    );
    const enrichedEvent = await enrichCreatorForNotification(
      enrichment.event,
      config,
      store.getTask(taskIdFor(event.service, event.issueIdentifier))?.status,
      reviewDecision,
      dryRun ? undefined : slackClient,
    );
    preparedEvents.push({ source: event, enrichment, event: enrichedEvent, reviewDecision });
  }

  for (const prepared of preparedEvents) {
    const { source, enrichment, event: enrichedEvent, reviewDecision } = prepared;
    if (dryRun) {
      const status = enrichedEvent.resolvedState ?? enrichedEvent.state ?? "Unknown";
      const taskId = taskIdFor(enrichedEvent.service, enrichedEvent.issueIdentifier);
      const notificationTargets = shouldSuppressReviewMention(reviewDecision)
        ? undefined
        : notificationTargetsForWatcherEvent(
            config.mention,
            store.getTask(taskId)?.status,
            status,
            enrichedEvent.type,
            enrichedEvent.creatorMention ?? undefined,
            reviewDecision.deliverDeferredMention,
          );
      const task = {
        id: taskId,
        serviceName: enrichedEvent.service,
        issueIdentifier: enrichedEvent.issueIdentifier,
        title: enrichedEvent.issueTitle ?? enrichedEvent.issueIdentifier,
        status,
        updatedAt: new Date().toISOString(),
      };
      console.log(
        JSON.stringify(
          {
            event: withoutCreatorEmail(enrichedEvent),
            slack: {
              parent: buildTaskCard(
                task,
                linearTeamForService(config, task.serviceName)?.statuses ?? [],
                enrichedEvent,
                notificationTargets?.creator,
                { mentions: notificationTargets?.mentions },
              ),
              thread: buildThreadMessage(enrichedEvent, notificationTargets?.creator, {
                mentions: notificationTargets?.mentions,
              }),
            },
          },
          null,
          2,
        ),
      );
    } else {
      if (!slackClient || !slackChannelId) throw new Error("Slack client is required.");
      await processWatcherEvent({
        config,
        store,
        slackClient,
        slackChannelId,
        event: enrichedEvent,
        reviewDecision,
        updateLinearStatus,
      });
      if (enrichment.isAuthoritative) {
        markReviewRequeueReconciled(store, taskIdFor(source.service, source.issueIdentifier));
      }
    }
  }

  if (!dryRun) {
    if (!slackClient || !slackChannelId) throw new Error("Slack client is required.");
    store.replaceSnapshots(current);
    await reconcileLinearStatuses({
      config,
      store,
      slackClient,
      slackChannelId,
      skipTaskIds: new Set([
        ...processedTaskIds,
        ...taskIdsInSnapshots(current).filter((taskId) => !reviewReconciliationTaskIds.has(taskId)),
      ]),
      findPullRequestByUrl,
      updateLinearStatus,
      reviewReconciliationTaskIds,
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
  reviewReconciliationTaskIds,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  slackChannelId: string;
  skipTaskIds: Set<string>;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  updateLinearStatus: typeof updateLinearIssueStatus;
  reviewReconciliationTaskIds: ReadonlySet<string>;
}): Promise<void> {
  for (const task of store.getTasksForLinearSync(reviewReconciliationTaskIds)) {
    if (
      skipTaskIds.has(task.id) ||
      task.issueIdentifier.startsWith("watcher:") ||
      !task.parentChannelId ||
      !task.parentMessageTs
    )
      continue;

    const linearIssue = await fetchLinearIssueState(task.issueIdentifier, {
      apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
      includeCreator: false,
      maxAttempts: 1,
    });
    if (!linearIssue?.state) continue;
    const sameStatus = normalizeStatus(linearIssue.state) === normalizeStatus(task.status);
    const enteredTerminalState = enteredTerminalLinearState(
      task.linearStateType,
      linearIssue.stateType,
    );
    const hasPendingReconciliation = reviewReconciliationTaskIds.has(task.id);
    let pullRequest =
      linearIssue.pullRequest ??
      (hasPendingReconciliation ? pendingReviewPullRequest(store, task.id) : undefined);
    const reaction = reviewReactionForStatus(config, linearIssue.state);
    if (reaction && hasPendingReconciliation && !pullRequest?.url) continue;
    if (reaction && pullRequest?.url) {
      const enrichedPullRequest = await findPullRequestByUrl(pullRequest.url, { reaction });
      if (!enrichedPullRequest && hasPendingReconciliation) continue;
      pullRequest = enrichedPullRequest ?? pullRequest;
    }

    const event: WatcherEvent = {
      type: "updated",
      service: task.serviceName,
      issueIdentifier: task.issueIdentifier,
      issueTitle: linearIssue.title,
      issueUrl: linearIssue.url ?? task.linkUrl,
      state: task.status,
      resolvedState: linearIssue.state,
      resolvedStateType: linearIssue.stateType ? normalizeStatus(linearIssue.stateType) : undefined,
      pullRequest,
      relatedIssues: linearIssue.relatedIssues,
    };
    const reviewDecision = decideReviewReaction(config, store, event, true);
    if (
      sameStatus &&
      !reviewDecision.shouldRequeue &&
      !enteredTerminalState &&
      !hasPendingReconciliation
    ) {
      if (linearIssue.stateType) {
        store.setTaskLinearStateType(task.id, normalizeStatus(linearIssue.stateType));
      }
      markReviewRequeueReconciled(store, task.id);
      continue;
    }

    const enrichedEvent = await enrichCreatorForNotification(
      event,
      config,
      task.status,
      reviewDecision,
      slackClient,
    );

    await processWatcherEvent({
      config,
      store,
      slackClient,
      slackChannelId,
      event: enrichedEvent,
      reviewDecision,
      updateLinearStatus,
    });
    markReviewRequeueReconciled(store, task.id);
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
  reviewDecision: ReviewReactionDecision;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  await publishWatcherEvent(
    slackClient,
    store,
    slackChannelId,
    event,
    shouldSuppressReviewMention(reviewDecision) ? undefined : config.mention,
    { forceMention: reviewDecision.deliverDeferredMention },
  );
  const review = config.reviewReaction;
  if (!reviewDecision.shouldRequeue || !review) return;

  const task = store.getTask(taskId)!;
  if (!reviewDecision.reachesLimit) {
    await slackClient.chat.postMessage({
      channel: task.parentChannelId!,
      thread_ts: task.parentMessageTs!,
      text: reviewRequeueMessage(review.reaction, task.status, review.inProgressStatus),
    });
  }

  await updateLinearStatus(task.issueIdentifier, review.inProgressStatus, {
    apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
  });
  const { task: requeuedTask, fromStatus } = store.updateTaskStatus(
    task.id,
    review.inProgressStatus,
  );
  const auditBody = reviewRequeueMessage(review.reaction, fromStatus, requeuedTask.status);
  const requeueEvent = {
    taskId: task.id,
    type: REVIEW_REQUEUE_EVENT,
    actor: "watcher",
    fromStatus,
    toStatus: requeuedTask.status,
    body: auditBody,
  };

  if (reviewDecision.reachesLimit) {
    const limitMessage = reviewRequeueLimitMessage(
      review.reaction,
      review.maxRequeues,
      fromStatus,
      requeuedTask.status,
    );
    store.addEvents([
      requeueEvent,
      {
        taskId: task.id,
        type: REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
        actor: "watcher",
        fromStatus,
        toStatus: requeuedTask.status,
        body: JSON.stringify({ message: limitMessage, event: withoutCreatorDetails(event) }),
      },
    ]);
    await deliverPendingReviewLimitNotifications(store, slackClient, task.id);
    return;
  }

  store.addEvent(requeueEvent);
  const card = buildTaskCard(requeuedTask, store.getSelectableStatuses(requeuedTask.serviceName), {
    ...event,
    state: fromStatus,
    resolvedState: requeuedTask.status,
  });
  await slackClient.chat.update({
    channel: requeuedTask.parentChannelId!,
    ts: requeuedTask.parentMessageTs!,
    ...card,
  });
  store.setRenderedSummary(requeuedTask.id, JSON.stringify(card));
}

async function deliverPendingReviewLimitNotifications(
  store: WatcherStore,
  slackClient: WebClient,
  onlyTaskId?: string,
): Promise<Set<string>> {
  const taskIds = onlyTaskId
    ? [onlyTaskId]
    : store.getTaskIdsWithIncompleteEvent(
        REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
        REVIEW_REQUEUE_LIMIT_EVENT,
      );
  const completedTaskIds = new Set<string>();

  for (const taskId of taskIds) {
    try {
      if (await deliverPendingReviewLimitNotification(store, slackClient, taskId)) {
        completedTaskIds.add(taskId);
      }
    } catch (error) {
      console.error(`Failed to deliver pending review limit notification for ${taskId}:`, error);
    }
  }

  return completedTaskIds;
}

async function deliverPendingReviewLimitNotification(
  store: WatcherStore,
  slackClient: WebClient,
  taskId: string,
): Promise<boolean> {
  const task = store.getTask(taskId);
  const pending = store.getLatestEvent(taskId, REVIEW_REQUEUE_LIMIT_PENDING_EVENT);
  const completed = store.getLatestEvent(taskId, REVIEW_REQUEUE_LIMIT_EVENT);
  if (
    !task?.parentChannelId ||
    !task.parentMessageTs ||
    !pending ||
    (completed && completed.id > pending.id)
  )
    return false;

  if (!pending.body || !pending.fromStatus || !pending.toStatus) {
    throw new Error(`Invalid pending review requeue limit event for ${task.id}`);
  }
  const payload = parseReviewRequeuePendingPayload(pending.body);

  const notified = store.getLatestEvent(task.id, REVIEW_REQUEUE_LIMIT_NOTIFIED_EVENT);
  if (!notified || notified.id < pending.id) {
    const message = {
      channel: task.parentChannelId,
      thread_ts: task.parentMessageTs,
      text: payload.message,
      client_msg_id: slackClientMessageId(pending.id),
    };
    await slackClient.chat.postMessage(message);
    store.addEvent({
      taskId: task.id,
      type: REVIEW_REQUEUE_LIMIT_NOTIFIED_EVENT,
      actor: "watcher",
      fromStatus: pending.fromStatus,
      toStatus: pending.toStatus,
      body: payload.message,
    });
  }

  const updatedTask = store.getTask(task.id)!;
  const card = buildTaskCard(updatedTask, store.getSelectableStatuses(task.serviceName), {
    ...payload.event,
    state: pending.fromStatus,
    resolvedState: updatedTask.status,
  });
  await slackClient.chat.update({
    channel: task.parentChannelId,
    ts: task.parentMessageTs,
    ...card,
  });
  store.setRenderedSummary(task.id, JSON.stringify(card));
  store.addEvents([
    {
      taskId: task.id,
      type: REVIEW_REQUEUE_LIMIT_EVENT,
      actor: "watcher",
      fromStatus: pending.fromStatus,
      toStatus: pending.toStatus,
      body: payload.message,
    },
    {
      taskId: task.id,
      type: REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
      actor: "watcher",
      fromStatus: pending.fromStatus,
      toStatus: pending.toStatus,
      body: payload.message,
    },
  ]);
  store.setTaskLinearStateType(task.id, undefined);
  return true;
}

function slackClientMessageId(eventId: number): string {
  const suffix = eventId.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}

function parseReviewRequeuePendingPayload(body: string): {
  message: string;
  event: WatcherEvent;
} {
  const payload = JSON.parse(body) as { message?: unknown; event?: unknown };
  if (typeof payload.message !== "string" || typeof payload.event !== "object") {
    throw new Error("Invalid review requeue pending payload");
  }
  return payload as { message: string; event: WatcherEvent };
}

function markReviewRequeueReconciled(store: WatcherStore, taskId: string): void {
  if (
    !hasPendingEvent(
      store,
      taskId,
      REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
      REVIEW_REQUEUE_RECONCILED_EVENT,
    )
  )
    return;

  store.addEvent({ taskId, type: REVIEW_REQUEUE_RECONCILED_EVENT, actor: "watcher" });
}

interface ReviewReactionDecision {
  shouldRequeue: boolean;
  reachesLimit: boolean;
  hasPendingLimitNotification?: boolean;
  hasPendingReviewReconciliation?: boolean;
  deliverDeferredMention?: boolean;
}

function shouldSuppressReviewMention(decision: ReviewReactionDecision): boolean {
  return Boolean(
    decision.shouldRequeue ||
    decision.hasPendingLimitNotification ||
    decision.hasPendingReviewReconciliation,
  );
}

function decideReviewReaction(
  config: ResolvedWatcherRuntimeConfig,
  store: WatcherStore,
  event: WatcherEvent,
  reconciliationIsAuthoritative = false,
): ReviewReactionDecision {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  const hasPendingReviewReconciliation = hasPendingEvent(
    store,
    taskId,
    REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
    REVIEW_REQUEUE_RECONCILED_EVENT,
  );
  const review = config.reviewReaction;
  const currentStatus = event.resolvedState ?? event.state ?? "";
  const isInReview = Boolean(
    review && normalizeStatus(currentStatus) === normalizeStatus(review.inReviewStatus),
  );
  if (
    isInReview &&
    hasPendingEvent(store, taskId, REVIEW_REQUEUE_LIMIT_PENDING_EVENT, REVIEW_REQUEUE_LIMIT_EVENT)
  ) {
    return {
      shouldRequeue: false,
      reachesLimit: false,
      hasPendingLimitNotification: true,
    };
  }

  if (!review || !isInReview || event.pullRequest?.hasConfiguredReaction !== true) {
    return {
      shouldRequeue: false,
      reachesLimit: false,
      hasPendingReviewReconciliation:
        hasPendingReviewReconciliation && !reconciliationIsAuthoritative && isInReview,
      deliverDeferredMention:
        hasPendingReviewReconciliation &&
        reconciliationIsAuthoritative &&
        isInReview &&
        event.pullRequest?.hasConfiguredReaction === false &&
        notificationIsEligible(config.mention, undefined, currentStatus, event.type),
    };
  }

  let requeueCount = store.countEventsAfterLatest(
    taskId,
    REVIEW_REQUEUE_EVENT,
    REVIEW_REQUEUE_LIMIT_EVENT,
  );
  // Legacy or reconfigured cycles can contain counts beyond the current limit.
  if (review.maxRequeues > 0) {
    requeueCount %= review.maxRequeues;
  }
  // Non-positive limits disable automatic requeueing.
  if (requeueCount >= review.maxRequeues) {
    return { shouldRequeue: false, reachesLimit: false };
  }

  return {
    shouldRequeue: true,
    reachesLimit: requeueCount + 1 === review.maxRequeues,
  };
}

function reviewReactionForStatus(
  config: ResolvedWatcherRuntimeConfig,
  status?: string | null,
): string | undefined {
  const review = config.reviewReaction;
  return review && status && normalizeStatus(status) === normalizeStatus(review.inReviewStatus)
    ? review.reaction
    : undefined;
}

function hasPendingEvent(
  store: WatcherStore,
  taskId: string,
  pendingType: string,
  completedType: string,
): boolean {
  return store.countEventsAfterLatest(taskId, pendingType, completedType) > 0;
}

function pendingReviewPullRequest(store: WatcherStore, taskId: string): PullRequest | undefined {
  const body = store.getLatestEvent(taskId, REVIEW_REQUEUE_LIMIT_PENDING_EVENT)?.body;
  if (!body) return undefined;

  try {
    return parseReviewRequeuePendingPayload(body).event.pullRequest;
  } catch {
    return undefined;
  }
}

function reviewRequeueMessage(reaction: string, fromStatus: string, toStatus: string): string {
  return `${reaction} review reaction detected | *${fromStatus}* → *${toStatus}*`;
}

function reviewRequeueLimitMessage(
  reaction: string,
  maxRequeues: number,
  fromStatus: string,
  toStatus: string,
): string {
  return `${reaction} review requeue limit reached (${maxRequeues}/${maxRequeues}) | *${fromStatus}* → *${toStatus}*`;
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

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

async function enrichEvent(
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
    if (reaction) {
      const enrichedPullRequest = await github.findPullRequestByUrl(linearIssue.pullRequest.url, {
        reaction,
      });
      reactionLookupSucceeded = enrichedPullRequest?.hasConfiguredReaction !== undefined;
      pullRequest = enrichedPullRequest ?? linearIssue.pullRequest;
    } else {
      pullRequest = linearIssue.pullRequest;
    }
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

async function enrichCreatorForNotification(
  event: WatcherEvent,
  config: ResolvedWatcherRuntimeConfig,
  previousStatus: string | undefined,
  reviewDecision: ReviewReactionDecision,
  slackClient?: WebClient,
): Promise<WatcherEvent> {
  const currentStatus = event.resolvedState ?? event.state ?? "Unknown";
  if (
    shouldSuppressReviewMention(reviewDecision) ||
    !notificationIsEligible(
      config.mention,
      previousStatus,
      currentStatus,
      event.type,
      reviewDecision.deliverDeferredMention,
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
      throwOnTransientFailure: Boolean(slackClient),
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
      creatorName: linearIssue?.creatorName,
      creatorEmail: linearIssue?.creatorEmail,
    }),
    slackClient,
  );
}

async function enrichCreatorMention(
  event: WatcherEvent,
  slackClient?: WebClient,
): Promise<WatcherEvent> {
  const email = event.creatorEmail?.trim().toLowerCase();
  if (!email || !slackClient) {
    return withCreatorName(event);
  }

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

function withoutCreatorEmail(event: WatcherEvent): WatcherEvent {
  const { creatorEmail: _, ...safeEvent } = event;
  return safeEvent;
}

function withoutCreatorDetails(event: WatcherEvent): WatcherEvent {
  const { creatorName: _name, creatorEmail: _email, ...safeEvent } = event;
  return safeEvent;
}

function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

interface CollectSnapshotsOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export async function collectSnapshots(
  services: ServiceDefinition[],
  previous: SnapshotsByService = {},
  options: CollectSnapshotsOptions = {},
): Promise<SnapshotsByService> {
  const fetchService = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const entries = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await fetchService(service.url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = await response.json();
        if (!isSnapshot(snapshot)) {
          throw new Error("Invalid observability snapshot");
        }
        return [service.name, snapshot] as const;
      } catch (error) {
        return [
          service.name,
          serviceUnavailableSnapshot(service, previous[service.name], error),
        ] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<Snapshot>;
  return (
    Array.isArray(snapshot.running) &&
    Array.isArray(snapshot.retrying) &&
    Array.isArray(snapshot.blocked)
  );
}

function serviceUnavailableSnapshot(
  service: ServiceDefinition,
  previous: Snapshot | undefined,
  error: unknown,
): Snapshot {
  const message = error instanceof Error ? error.message : String(error);
  const snapshot = normalizeSnapshot(previous);
  const watcherIdentifier = `watcher:${service.name}`;

  return {
    running: snapshot.running,
    retrying: [
      ...snapshot.retrying.filter(
        (row) => (row.issue_identifier ?? row.issueIdentifier) !== watcherIdentifier,
      ),
      {
        issue_identifier: watcherIdentifier,
        state: "unavailable",
        error: `${service.url} ${message}`,
      },
    ],
    blocked: snapshot.blocked,
  };
}

interface CliOptions {
  dryRun: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { dryRun: false };

  for (const arg of args) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function linearTeamForService(
  config: ResolvedWatcherRuntimeConfig,
  serviceName: string,
): ResolvedLinearTeamConfig | undefined {
  const service = config.services.find(({ name }) => name === serviceName);
  return service && config.linearTeams[service.linearTeam];
}

export async function resolveLinearWorkflowStatuses(
  config: WatcherRuntimeConfig,
  fetchStates: typeof fetchLinearWorkflowStates = fetchLinearWorkflowStates,
): Promise<ResolvedWatcherRuntimeConfig> {
  const entries = await Promise.all(
    Object.entries(config.linearTeams).map(async ([name, team]) => {
      const statuses = await fetchStates(team.teamId, { apiKey: team.apiKey });
      validateStatuses(`Linear workflow states for ${name}`, statuses);
      return [name, { ...team, statuses }] as const;
    }),
  );
  const resolved = {
    ...config,
    linearTeams: Object.fromEntries(entries),
  } satisfies ResolvedWatcherRuntimeConfig;

  validateStatusRules(resolved);
  return resolved;
}

function validateStatusRules(config: ResolvedWatcherRuntimeConfig): void {
  const rules: Array<[label: string, status: string]> = [];
  if (config.reviewReaction) {
    rules.push(
      ["watcher.reviewReaction.inReviewStatus", config.reviewReaction.inReviewStatus],
      ["watcher.reviewReaction.inProgressStatus", config.reviewReaction.inProgressStatus],
    );
  }
  for (const status of config.mention?.statuses ?? []) {
    rules.push(["slack.mentions.statuses", status]);
  }

  for (const [label, expected] of rules) {
    const normalizedExpected = normalizeStatus(expected);
    for (const [teamName, team] of Object.entries(config.linearTeams)) {
      if (team.statuses.some((status) => normalizeStatus(status) === normalizedExpected)) {
        continue;
      }
      throw new Error(`${label} references unknown Linear status "${expected}" for ${teamName}.`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function compactObject<T extends object>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  ) as T;
}
