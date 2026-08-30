import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import type { OrchestratorConfig } from "orchestrator-config";
import { resolveWatcherConfig } from "../config/runtime.ts";
import { createDatabase } from "../persistence/database.ts";
import { DEFAULT_DATABASE_PATH, WatcherStore } from "../persistence/store.ts";
import { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import { createLinearWorkpadReply } from "../integrations/linear/workpad.ts";
import { downloadSlackFile } from "../integrations/slack/files.ts";
import { requireGitHubCli } from "../integrations/github/pull-requests.ts";
import { createSlackApp } from "../slack/app.ts";
import { isTerminalLinearStateType } from "../domain/linear.ts";
import { createPendingStatusHookEvent, deliverPendingStatusHooksSafely } from "./status-hooks.ts";
import {
  linearTeamForService,
  serviceConfigFor,
  resolveLinearWorkflowStatuses,
  resolveSymphonyWorkflowSettings,
} from "./runtime-config.ts";
import { reconcileSlackStatusTransition } from "./reconcile-slack-status.ts";
import { createReviewTransitionBaselineEvent } from "./review-comments.ts";
import { runWatcherPollingLoop } from "./polling-loop.ts";
import type { PullRequestMonitorState } from "./pull-request-monitors.ts";
import { runOnce } from "./run-once.ts";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PERIODIC_MAINTENANCE_INTERVAL_MS = 30_000;
const POLL_FAILURE_RETRY_INTERVAL_MS = 30_000;

export async function requireSlackBotUserId(client: Pick<WebClient, "auth">): Promise<string> {
  const response = await client.auth.test();
  if (!response.user_id) throw new Error("Slack auth.test did not return a bot user ID.");
  return response.user_id;
}

export async function startWatcher(config: OrchestratorConfig): Promise<void> {
  const startedAt = new Date();
  const unresolvedConfig = resolveWatcherConfig(config, { requireSlack: true });
  const symphoniesDirectory = resolve(rootDirectory, "symphonies");
  const workflowConfig = await resolveSymphonyWorkflowSettings(
    unresolvedConfig,
    symphoniesDirectory,
  );
  const runtimeConfig = await resolveLinearWorkflowStatuses(workflowConfig);
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
      symphoniesDirectory,
      defaultAssignees: runtimeConfig.defaultAssignees,
    },
    statusSummary: {
      serviceNames: runtimeConfig.services.map(({ name }) => name),
      startedAt,
    },
    slackCommandsForService: (serviceName) =>
      serviceConfigFor(runtimeConfig, serviceName)?.slackCommands ?? [],
    createStatusTransitionEvent: (task, fromStatus, toStatus) =>
      createPendingStatusHookEvent(
        serviceConfigFor(runtimeConfig, task.serviceName)?.statusHooks ?? [],
        task,
        fromStatus,
        toStatus,
      ),
    onStatusTransition: async (task, fromStatus, toStatus, slackClient) => {
      const baselineEvent = createReviewTransitionBaselineEvent(
        runtimeConfig,
        task,
        fromStatus,
        toStatus,
      );
      if (baselineEvent) store.addEvent(baselineEvent);
      await reconcileSlackStatusTransition({
        config: runtimeConfig,
        store,
        slackClient,
        slackChannelId: slackConfig.channelId,
        task,
      });
      await deliverPendingStatusHooksSafely({
        hooks: serviceConfigFor(runtimeConfig, task.serviceName)?.statusHooks ?? [],
        store,
        slackClient,
        watcherChannelId: slackConfig.channelId,
        taskId: task.id,
      });
    },
  });

  let nextPeriodicMaintenanceAt = 0;
  const pullRequestMonitorState: PullRequestMonitorState = new Map();
  let pendingPersistedTerminalTaskIds = new Set(
    store
      .getTasksForLinearSync(new Set(), new Map(), true)
      .filter(
        (task) =>
          isTerminalLinearStateType(task.linearStateType) &&
          !task.issueIdentifier.startsWith("watcher:"),
      )
      .map(({ id }) => id),
  );
  try {
    await app.start();
    await runWatcherPollingLoop(
      async () => {
        const runPeriodicMaintenance = performance.now() >= nextPeriodicMaintenanceAt;
        const result = await runOnce({
          config: runtimeConfig,
          store,
          slackClient: client,
          slackChannelId: slackConfig.channelId,
          runPeriodicMaintenance,
          persistedTerminalTaskIds: pendingPersistedTerminalTaskIds,
          pullRequestMonitorState,
        });
        if (runPeriodicMaintenance) {
          nextPeriodicMaintenanceAt = performance.now() + PERIODIC_MAINTENANCE_INTERVAL_MS;
          pendingPersistedTerminalTaskIds = result.pendingPersistedTerminalTaskIds;
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
