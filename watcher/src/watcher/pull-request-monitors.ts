import type {
  PullRequestMonitorConfig,
  PullRequestMonitorResult,
  StatusHookSlackThreadMessage,
} from "orchestrator-config";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { toPullRequestContext } from "../domain/pull-request-context.ts";
import type { PullRequestMonitorStarter } from "../domain/pull-request-monitor.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { Task } from "../domain/task.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { WatcherStore } from "../persistence/store.ts";

const DEFAULT_MAX_ATTEMPTS = 10;

type PullRequestMonitorTrigger = Parameters<PullRequestMonitorStarter>[2];

interface MonitoringActivation {
  state: "monitoring";
  taskId: string;
  monitor: PullRequestMonitorConfig;
  attempts: number;
  trigger: PullRequestMonitorTrigger & { startedAt: string };
}

interface NotifyingActivation extends Omit<MonitoringActivation, "state"> {
  state: "notifying";
  message: StatusHookSlackThreadMessage;
}

type Activation = MonitoringActivation | NotifyingActivation;

interface MonitorSlackClient {
  chat: {
    postMessage(
      args: StatusHookSlackThreadMessage & {
        channel: string;
        thread_ts: string;
      },
    ): Promise<unknown>;
  };
}

export class PullRequestMonitorRegistry {
  private readonly activations = new Map<string, Activation>();
  private readonly config: ResolvedWatcherRuntimeConfig;
  private readonly store: WatcherStore;
  private readonly slackClient: MonitorSlackClient;
  private readonly findPullRequestByUrl: typeof findPullRequestByUrlDefault;

  constructor(
    config: ResolvedWatcherRuntimeConfig,
    store: WatcherStore,
    slackClient: MonitorSlackClient,
    findPullRequestByUrl: typeof findPullRequestByUrlDefault = findPullRequestByUrlDefault,
  ) {
    this.config = config;
    this.store = store;
    this.slackClient = slackClient;
    this.findPullRequestByUrl = findPullRequestByUrl;
  }

  start(task: Task, monitor: PullRequestMonitorConfig, trigger: PullRequestMonitorTrigger): void {
    validateMonitor(monitor);
    const monitorId = monitor.id.trim();
    const currentTask = this.store.getTask(task.id);
    if (!currentTask?.pullRequest?.url) {
      throw new Error(`Task ${task.issueIdentifier} does not have a pull request.`);
    }
    if (currentTask.pullRequest.url !== task.pullRequest?.url) {
      throw new Error(`Task ${task.issueIdentifier} changed to a different pull request.`);
    }
    if (!this.isInReview(currentTask)) {
      throw new Error(
        `Pull request monitors can only start while ${task.issueIdentifier} is In Review.`,
      );
    }
    this.activations.set(activationKey(task.id, monitorId), {
      state: "monitoring",
      taskId: task.id,
      monitor: { ...monitor, id: monitorId },
      attempts: 0,
      trigger: { ...trigger, args: [...trigger.args], startedAt: new Date().toISOString() },
    });
  }

  async poll(): Promise<void> {
    for (const [key, activation] of Array.from(this.activations)) {
      const task = this.store.getTask(activation.taskId);
      if (!task?.pullRequest?.url || !task.parentChannelId || !task.parentMessageTs) {
        this.activations.delete(key);
        continue;
      }
      if (!this.isInReview(task)) {
        this.activations.delete(key);
        continue;
      }
      if (activation.state === "notifying") {
        await this.notify(key, activation, task);
        continue;
      }

      await this.check(key, activation, task);
    }
  }

  private async check(key: string, activation: MonitoringActivation, task: Task): Promise<void> {
    const { monitor } = activation;
    try {
      const pullRequest = await this.findPullRequestByUrl(task.pullRequest!.url);
      if (!pullRequest) throw new Error("GitHub pull request is unavailable.");
      const result = await monitor.run({
        service: task.serviceName,
        issue: {
          identifier: task.issueIdentifier,
          ...(task.linkUrl ? { url: task.linkUrl } : {}),
          title: task.title,
        },
        pullRequest: toPullRequestContext(pullRequest),
        trigger: activation.trigger,
      });
      validateResult(result);
      if (this.activations.get(key) !== activation) return;
      const currentTask = this.getCurrentMonitorTask(task);
      if (!currentTask) {
        this.activations.delete(key);
        return;
      }
      if (result.status === "complete") {
        const notifying = { ...activation, state: "notifying", message: result.message } as const;
        this.activations.set(key, notifying);
        await this.notify(key, notifying, currentTask);
        return;
      }
      await this.recordFailedAttempt(key, activation, currentTask, monitor);
    } catch (error) {
      console.error(
        `Pull request monitor ${monitor.id} failed for ${task.issueIdentifier}:`,
        error,
      );
      if (this.activations.get(key) === activation) {
        const currentTask = this.getCurrentMonitorTask(task);
        if (!currentTask) {
          this.activations.delete(key);
          return;
        }
        await this.recordFailedAttempt(key, activation, currentTask, monitor);
      }
    }
  }

  private async recordFailedAttempt(
    key: string,
    activation: MonitoringActivation,
    task: Task,
    monitor: PullRequestMonitorConfig,
  ): Promise<void> {
    const attempts = activation.attempts + 1;
    if (attempts < (monitor.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      this.activations.set(key, { ...activation, attempts });
      return;
    }
    const notifying = {
      ...activation,
      state: "notifying",
      attempts,
      message: {
        text: `Pull request monitor \`${monitor.id}\` failed after ${attempts} attempts and will not be retried.`,
      },
    } as const;
    this.activations.set(key, notifying);
    await this.notify(key, notifying, task);
  }

  private async notify(key: string, activation: NotifyingActivation, task: Task): Promise<void> {
    try {
      await this.slackClient.chat.postMessage({
        ...activation.message,
        channel: task.parentChannelId!,
        thread_ts: task.parentMessageTs!,
      });
      if (this.activations.get(key) === activation) this.activations.delete(key);
    } catch (error) {
      console.error(
        `Pull request monitor notification failed for ${task.issueIdentifier}; it will be retried:`,
        error,
      );
    }
  }

  private isInReview(task: Task): boolean {
    const inReviewStatus = this.config.reviewComment?.inReviewStatus;
    return Boolean(
      inReviewStatus && normalizeStatus(task.status) === normalizeStatus(inReviewStatus),
    );
  }

  private getCurrentMonitorTask(task: Task): Task | null {
    const currentTask = this.store.getTask(task.id);
    if (
      !currentTask?.pullRequest?.url ||
      currentTask.pullRequest.url !== task.pullRequest?.url ||
      !this.isInReview(currentTask)
    ) {
      return null;
    }
    return currentTask;
  }
}

function activationKey(taskId: string, monitorId: string): string {
  return `${taskId}\0${monitorId}`;
}

function validateResult(result: PullRequestMonitorResult): void {
  if (
    !result ||
    (result.status !== "pending" &&
      (result.status !== "complete" || !result.message || typeof result.message !== "object"))
  ) {
    throw new Error("Pull request monitor returned an invalid result.");
  }
}

function validateMonitor(monitor: PullRequestMonitorConfig): void {
  if (!monitor || typeof monitor !== "object") {
    throw new Error("Pull request monitor must be an object.");
  }
  if (!monitor.id?.trim()) {
    throw new Error("Pull request monitor id must be a non-empty string.");
  }
  const maxAttempts = monitor.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Pull request monitor maxAttempts must be a positive integer.");
  }
  if (typeof monitor.run !== "function") {
    throw new Error("Pull request monitor run must be a function.");
  }
}
