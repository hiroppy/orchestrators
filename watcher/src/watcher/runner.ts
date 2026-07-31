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
  mentionTargetForWatcherEvent,
  publishWatcherStarted,
  publishWatcherEvent,
} from "../slack/app.ts";
import { buildTaskCard, buildThreadMessage } from "../slack/views.ts";
import { DEFAULT_DATABASE_PATH, taskIdFor, WatcherStore } from "../persistence/store.ts";
import type {
  OrchestratorConfig,
  ResolvedLinearTeamConfig,
  ServiceDefinition,
  Snapshot,
  SnapshotsByService,
  WatcherEvent,
} from "../domain/types.ts";
import { enteredTerminalLinearState } from "../domain/linear.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const REVIEW_REQUEUE_EVENT = "review_requeued";
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
          mention: runtimeConfig.mention,
          updateLinearStatus: async (task, status) => {
            await updateLinearIssueStatus(task.issueIdentifier, status, {
              apiKey: linearTeamForService(runtimeConfig, task.serviceName)?.apiKey,
            });
          },
          createLinearWorkpadReply: async (task, reply, idempotencyKey) =>
            createLinearWorkpadReply(task.issueIdentifier, reply.text, {
              apiKey: linearTeamForService(runtimeConfig, task.serviceName)?.apiKey,
              idempotencyKey,
              images: reply.images.map((image) => ({
                filename: image.filename,
                contentType: image.contentType,
                loadData: () => downloadSlackFile(image.downloadUrl, slackConfig.botToken),
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
      await runOnce({
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
  const previous = store.getSnapshots();
  const current = await collectSnapshots(config.services, previous);
  const events = diffSnapshots(previous, current, config);
  const processedTaskIds = new Set<string>();

  for (const event of events) {
    const enrichedEvent = await enrichEvent(event, config, {
      findPullRequest,
      findPullRequestByUrl,
    });
    processedTaskIds.add(taskIdFor(event.service, event.issueIdentifier));
    const reviewDecision = decideReviewReaction(config, store, enrichedEvent);

    if (dryRun) {
      const status = enrichedEvent.resolvedState ?? enrichedEvent.state ?? "Unknown";
      const taskId = taskIdFor(enrichedEvent.service, enrichedEvent.issueIdentifier);
      const mentionTarget = reviewDecision.shouldRequeue
        ? undefined
        : mentionTargetForWatcherEvent(
            config.mention,
            store.getTask(taskId)?.status,
            status,
            enrichedEvent.type,
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
            event: enrichedEvent,
            slack: {
              parent: buildTaskCard(
                task,
                linearTeamForService(config, task.serviceName)?.statuses ?? [],
                enrichedEvent,
                mentionTarget,
              ),
              thread: buildThreadMessage(enrichedEvent, mentionTarget),
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
    }
  }

  if (!dryRun) {
    if (!slackClient || !slackChannelId) throw new Error("Slack client is required.");
    await reconcileLinearStatuses({
      config,
      store,
      slackClient,
      slackChannelId,
      skipTaskIds: new Set([...processedTaskIds, ...taskIdsInSnapshots(current)]),
      findPullRequestByUrl,
      updateLinearStatus,
    });
    store.replaceSnapshots(current);
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
  for (const task of store.getTasksForLinearSync()) {
    if (
      skipTaskIds.has(task.id) ||
      task.issueIdentifier.startsWith("watcher:") ||
      !task.parentChannelId ||
      !task.parentMessageTs
    )
      continue;

    const linearIssue = await fetchLinearIssueState(task.issueIdentifier, {
      apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
      maxAttempts: 1,
    });
    if (!linearIssue?.state) continue;
    const sameStatus = normalizeStatus(linearIssue.state) === normalizeStatus(task.status);
    const enteredTerminalState = enteredTerminalLinearState(
      task.linearStateType,
      linearIssue.stateType,
    );
    let pullRequest = linearIssue.pullRequest;
    const reaction = reviewReactionForStatus(config, linearIssue.state);
    if (reaction && pullRequest?.url) {
      pullRequest =
        (await findPullRequestByUrl(pullRequest.url, {
          reaction,
        })) ?? pullRequest;
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
    const reviewDecision = decideReviewReaction(config, store, event);

    if (sameStatus && !reviewDecision.shouldRequeue && !enteredTerminalState) {
      if (linearIssue.stateType) {
        store.setTaskLinearStateType(task.id, normalizeStatus(linearIssue.stateType));
      }
      continue;
    }

    await processWatcherEvent({
      config,
      store,
      slackClient,
      slackChannelId,
      event,
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
  reviewDecision: ReviewReactionDecision;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const taskId = taskIdFor(event.service, event.issueIdentifier);
  await publishWatcherEvent(
    slackClient,
    store,
    slackChannelId,
    event,
    reviewDecision.shouldRequeue ? undefined : config.mention,
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
  store.addEvent({
    taskId: task.id,
    type: REVIEW_REQUEUE_EVENT,
    actor: "watcher",
    fromStatus,
    toStatus: requeuedTask.status,
    body: auditBody,
  });

  if (reviewDecision.reachesLimit) {
    await slackClient.chat.postMessage({
      channel: requeuedTask.parentChannelId!,
      thread_ts: requeuedTask.parentMessageTs!,
      text: reviewRequeueLimitMessage(
        review.reaction,
        review.maxRequeues,
        fromStatus,
        requeuedTask.status,
      ),
    });
  }

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

interface ReviewReactionDecision {
  shouldRequeue: boolean;
  reachesLimit: boolean;
}

function decideReviewReaction(
  config: ResolvedWatcherRuntimeConfig,
  store: WatcherStore,
  event: WatcherEvent,
): ReviewReactionDecision {
  const review = config.reviewReaction;
  if (
    !review ||
    normalizeStatus(event.resolvedState ?? event.state ?? "") !==
      normalizeStatus(review.inReviewStatus) ||
    event.pullRequest?.hasConfiguredReaction !== true
  ) {
    return { shouldRequeue: false, reachesLimit: false };
  }

  const requeueCount = store.countEvents(
    taskIdFor(event.service, event.issueIdentifier),
    REVIEW_REQUEUE_EVENT,
  );
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
): Promise<WatcherEvent> {
  if (event.issueIdentifier === `watcher:${event.service}`) return event;

  const isEnded = event.type === "ended";
  const linearIssue = await fetchLinearIssueState(event.issueIdentifier, {
    apiKey: linearTeamForService(config, event.service)?.apiKey,
    maxAttempts: isEnded ? config.endedTaskRetry.maxAttempts : 1,
    retryDelayMs: isEnded ? config.endedTaskRetry.delayMs : 0,
  });
  const resolvedState = linearIssue?.state ?? event.state;
  const reaction = reviewReactionForStatus(config, resolvedState);
  let pullRequest = (await github.findPullRequest(event, { reaction })) ?? undefined;
  if (!pullRequest && linearIssue?.pullRequest) {
    pullRequest = reaction
      ? ((await github.findPullRequestByUrl(linearIssue.pullRequest.url, {
          reaction,
        })) ?? linearIssue.pullRequest)
      : linearIssue.pullRequest;
  }
  return compactObject({
    ...event,
    issueTitle: linearIssue?.title,
    issueUrl: linearIssue?.url ?? event.issueUrl,
    resolvedState: linearIssue?.state,
    resolvedStateType: linearIssue?.stateType ? normalizeStatus(linearIssue.stateType) : undefined,
    pullRequest,
    relatedIssues: linearIssue?.relatedIssues,
  });
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
    rules.push(["slack.mention.statuses", status]);
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
