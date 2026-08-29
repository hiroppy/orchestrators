import type { WebClient } from "@slack/web-api";
import type { MonitorContext, MonitorHelpers } from "orchestrator-config";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { PullRequest } from "../domain/github.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { Task } from "../domain/task.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { serviceConfigFor } from "./runtime-config.ts";

export type PullRequestMonitorState = Map<string, PullRequest>;

interface RunPullRequestMonitorsOptions {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  watcherChannelId: string;
  inReviewStatus?: string;
  state: PullRequestMonitorState;
  findPullRequestByUrl?: typeof findPullRequestByUrlDefault;
}

type ClearPullRequestMonitorStateOptions = Pick<
  RunPullRequestMonitorsOptions,
  "config" | "store" | "inReviewStatus" | "state"
>;

export function clearInactivePullRequestMonitorState({
  config,
  store,
  inReviewStatus,
  state,
}: ClearPullRequestMonitorStateOptions): void {
  clearUnmonitoredState(state, monitoredTasks(config, store, inReviewStatus));
}

export async function runPullRequestMonitors({
  config,
  store,
  slackClient,
  watcherChannelId,
  inReviewStatus,
  state,
  findPullRequestByUrl = findPullRequestByUrlDefault,
}: RunPullRequestMonitorsOptions): Promise<void> {
  const tasks = monitoredTasks(config, store, inReviewStatus);

  for (const task of tasks) {
    const monitors = serviceConfigFor(config, task.serviceName)?.monitors ?? [];

    const observedPullRequest = await findPullRequestByUrl(task.pullRequest!.url);
    if (!observedPullRequest) continue;

    const previousPullRequest = state.get(task.id);
    const samePullRequest = observedPullRequest.url === previousPullRequest?.url;
    const pullRequest =
      samePullRequest && observedPullRequest.checks === undefined && previousPullRequest.checks
        ? { ...observedPullRequest, checks: previousPullRequest.checks }
        : observedPullRequest;
    state.set(task.id, pullRequest);
    if (
      !previousPullRequest ||
      !samePullRequest ||
      !task.parentChannelId ||
      !task.parentMessageTs
    ) {
      continue;
    }

    const context = createMonitorContext(task, pullRequest, previousPullRequest);
    const helpers = createMonitorHelpers(task, slackClient, watcherChannelId);
    for (const monitor of monitors) {
      try {
        const output = await monitor.run(context, helpers);
        if (typeof output === "string" && output.trim()) {
          await helpers.slack.postThreadMessage({ text: output.trim() });
        }
      } catch (error) {
        console.error(`Monitor ${monitor.id} failed for ${task.issueIdentifier}:`, error);
      }
    }
  }

  clearUnmonitoredState(state, tasks);
}

function monitoredTasks(
  config: ResolvedWatcherRuntimeConfig,
  store: WatcherStore,
  inReviewStatus?: string,
): Task[] {
  const normalizedInReviewStatus = normalizeStatus(inReviewStatus);
  if (!normalizedInReviewStatus) return [];
  return store.getTasksForLinearSync().filter((task) => {
    const monitors = serviceConfigFor(config, task.serviceName)?.monitors ?? [];
    return (
      normalizeStatus(task.status) === normalizedInReviewStatus &&
      monitors.length > 0 &&
      Boolean(task.pullRequest?.url)
    );
  });
}

function clearUnmonitoredState(state: PullRequestMonitorState, tasks: Task[]): void {
  const monitoredTaskIds = new Set(tasks.map(({ id }) => id));
  for (const taskId of state.keys()) {
    if (!monitoredTaskIds.has(taskId)) state.delete(taskId);
  }
}

function createMonitorContext(
  task: Task,
  pullRequest: PullRequest,
  previousPullRequest: PullRequest,
): MonitorContext {
  return {
    event: "issue.monitored",
    service: task.serviceName,
    issue: {
      identifier: task.issueIdentifier,
      url: task.linkUrl,
      title: task.title,
      status: task.status,
    },
    pullRequest,
    previousPullRequest,
  };
}

function createMonitorHelpers(
  task: Task,
  slackClient: WebClient,
  watcherChannelId: string,
): MonitorHelpers {
  return {
    slack: {
      postMessage: async (message) => {
        await slackClient.chat.postMessage({ ...message, channel: watcherChannelId });
      },
      postThreadMessage: async (message) => {
        await slackClient.chat.postMessage({
          ...message,
          channel: task.parentChannelId!,
          thread_ts: task.parentMessageTs!,
        });
      },
    },
  };
}
