import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebClient } from "@slack/web-api";

import { resolveWatcherConfig, type ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { createDatabase } from "../persistence/database.ts";
import { diffSnapshots, normalizeSnapshot } from "./diff.ts";
import {
  createLinearWorkpadReply,
  fetchLinearIssueState,
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
  notificationTargetsForWatcherEvent,
  publishWatcherStarted,
  publishWatcherEvent,
} from "../slack/app.ts";
import {
  buildReviewRequeueLimitMessage,
  buildReviewRequeueMessage,
  buildReviewRequeueMessageBlocks,
  buildTaskCard,
  buildThreadMessage,
} from "../slack/views.ts";
import { DEFAULT_DATABASE_PATH, taskIdFor, WatcherStore } from "../persistence/store.ts";
import type { OrchestratorConfig, SnapshotsByService, WatcherEvent } from "../domain/types.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";
import { createPendingStatusHookEvent, deliverPendingStatusHooks } from "./status-hooks.ts";
import { collectSnapshots } from "./snapshots.ts";
import { linearTeamForService, resolveLinearWorkflowStatuses } from "./runtime-config.ts";
import { enrichCreatorAssignee, enrichEvent } from "./event-enrichment.ts";
import {
  decideReviewReaction,
  pendingReviewPullRequest,
  REVIEW_REQUEUE_EVENT,
  REVIEW_REQUEUE_LIMIT_PENDING_EVENT,
  REVIEW_REQUEUE_RECONCILED_EVENT,
  REVIEW_REQUEUE_RECONCILE_PENDING_EVENT,
  reviewReactionForStatus,
  shouldSuppressReviewMention,
  type ReviewReactionDecision,
} from "./review-reactions.ts";
import {
  deliverPendingReviewLimitNotifications,
  markReviewRequeueReconciled,
} from "./review-limit-delivery.ts";

export { collectSnapshots } from "./snapshots.ts";
export { resolveLinearWorkflowStatuses } from "./runtime-config.ts";

async function deliverPendingStatusHooksSafely(
  options: Parameters<typeof deliverPendingStatusHooks>[0],
): Promise<void> {
  try {
    await deliverPendingStatusHooks(options);
  } catch (error) {
    console.error("Status hook delivery failed; it will be retried:", error);
  }
}
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function requireSlackBotUserId(client: Pick<WebClient, "auth">): Promise<string> {
  const response = await client.auth.test();
  if (!response.user_id) throw new Error("Slack auth.test did not return a bot user ID.");
  return response.user_id;
}

export async function startWatcher(config: OrchestratorConfig, args: string[] = []): Promise<void> {
  const options = parseArgs(args);
  const unresolvedConfig = resolveWatcherConfig(config, {
    requireSlack: !options.dryRun,
  });
  const runtimeConfig = await resolveLinearWorkflowStatuses(unresolvedConfig);
  await requireGitHubCli();
  const slackConfig = runtimeConfig.slack;
  const client = slackConfig ? new WebClient(slackConfig.botToken) : undefined;
  const botUserId = client && !options.dryRun ? await requireSlackBotUserId(client) : undefined;
  const databasePath = resolve(rootDirectory, DEFAULT_DATABASE_PATH);

  const database = createDatabase(databasePath);
  const store = new WatcherStore(database.db);
  store.syncDefinitions(runtimeConfig.services, runtimeConfig.linearTeams);

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
          botUserId: botUserId!,
          takePr: {
            authorizedChannelId: slackConfig.channelId,
            services: runtimeConfig.services,
            linearTeams: runtimeConfig.linearTeams,
            symphoniesDirectory: resolve(rootDirectory, "symphonies"),
            defaultAssignees: runtimeConfig.defaultAssignees,
          },
          createStatusTransitionEvent: (task, fromStatus, toStatus) =>
            createPendingStatusHookEvent(runtimeConfig.statusHooks, task, fromStatus, toStatus),
          onStatusTransition: async (task, _fromStatus, _toStatus, slackClient) => {
            await deliverPendingStatusHooksSafely({
              hooks: runtimeConfig.statusHooks,
              store,
              slackClient,
              watcherChannelId: slackConfig.channelId,
              taskId: task.id,
            });
          },
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
  await runOnce(options);
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
    if (!slackClient || !slackChannelId) throw new Error("Slack client is required.");
    await deliverPendingStatusHooksSafely({
      hooks: config.statusHooks ?? [],
      store,
      slackClient,
      watcherChannelId: slackChannelId,
    });
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
    const enrichedEvent = await enrichCreatorAssignee(
      enrichment.event,
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
            config.notifications,
            store.getTask(taskId)?.status,
            status,
            enrichedEvent.type,
            [
              ...(config.defaultAssignees ?? []),
              ...(enrichedEvent.creatorMention ? [enrichedEvent.creatorMention] : []),
              ...store.getTaskAssignees(taskId),
            ],
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
                notificationTargets ?? [],
              ),
              thread: buildThreadMessage(enrichedEvent, {
                assignees: notificationTargets,
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
      includeCreator: true,
      maxAttempts: 1,
    });
    if (!linearIssue?.state) continue;
    const sameStatus = normalizeStatus(linearIssue.state) === normalizeStatus(task.status);
    const enteredTerminalState = enteredTerminalLinearState(
      task.linearStateType,
      linearIssue.stateType,
    );
    const hasPendingReconciliation = reviewReconciliationTaskIds.has(task.id);
    const reaction = reviewReactionForStatus(config, linearIssue.state);
    if (sameStatus && !enteredTerminalState && !hasPendingReconciliation && !reaction) {
      if (linearIssue.stateType) {
        store.setTaskLinearStateType(task.id, normalizeStatus(linearIssue.stateType));
      }
      markReviewRequeueReconciled(store, task.id);
      continue;
    }
    let pullRequest =
      linearIssue.pullRequest ??
      (hasPendingReconciliation ? pendingReviewPullRequest(store, task.id) : undefined);
    if (reaction && hasPendingReconciliation && !pullRequest?.url) continue;
    if (pullRequest?.url) {
      const enrichedPullRequest = await findPullRequestByUrl(pullRequest.url, { reaction }).catch(
        () => null,
      );
      if (
        reaction &&
        hasPendingReconciliation &&
        enrichedPullRequest?.hasConfiguredReaction === undefined
      )
        continue;
      pullRequest = enrichedPullRequest ?? pullRequest;
    }

    const event: WatcherEvent = {
      type: "updated",
      service: task.serviceName,
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
    shouldSuppressReviewMention(reviewDecision) ? undefined : config.notifications,
    {
      defaultAssignees: config.defaultAssignees ?? [],
      forceMention: reviewDecision.deliverDeferredMention,
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
    },
  );
  const review = config.reviewReaction;
  if (!reviewDecision.shouldRequeue || !review) return;

  const task = store.getTask(taskId)!;
  if (!reviewDecision.reachesLimit) {
    await slackClient.chat.postMessage({
      channel: task.parentChannelId!,
      thread_ts: task.parentMessageTs!,
      text: buildReviewRequeueMessage(review.reaction, task.status, review.inProgressStatus),
      blocks: buildReviewRequeueMessageBlocks(
        review.reaction,
        task.status,
        review.inProgressStatus,
      ),
    });
  }

  await updateLinearStatus(task.issueIdentifier, review.inProgressStatus, {
    apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
  });
  const { task: requeuedTask, fromStatus } = store.updateTaskStatusAtomically(
    task.id,
    review.inProgressStatus,
    (updatedTask, previousStatus) =>
      createPendingStatusHookEvent(
        config.statusHooks ?? [],
        updatedTask,
        previousStatus,
        updatedTask.status,
        event.pullRequest,
      ),
  );
  await deliverPendingStatusHooksSafely({
    hooks: config.statusHooks ?? [],
    store,
    slackClient,
    watcherChannelId: slackChannelId,
    taskId: requeuedTask.id,
  });
  const auditBody = buildReviewRequeueMessage(review.reaction, fromStatus, requeuedTask.status);
  const requeueEvent = {
    taskId: task.id,
    type: REVIEW_REQUEUE_EVENT,
    actor: "watcher",
    fromStatus,
    toStatus: requeuedTask.status,
    body: auditBody,
  };

  if (reviewDecision.reachesLimit) {
    const limitMessage = buildReviewRequeueLimitMessage(
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
        body: JSON.stringify({
          message: limitMessage,
          event: withoutCreatorDetails(event),
          reaction: review.reaction,
          maxRequeues: review.maxRequeues,
        }),
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

function withoutCreatorEmail(event: WatcherEvent): WatcherEvent {
  const { creatorEmail: _, ...safeEvent } = event;
  return safeEvent;
}

function withoutCreatorDetails(event: WatcherEvent): WatcherEvent {
  const { creatorName: _name, creatorEmail: _email, ...safeEvent } = event;
  return safeEvent;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
