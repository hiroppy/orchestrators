import type { ChatPostMessageArguments } from "@slack/web-api";
import type { StatusHookContext, StatusHookHelpers } from "orchestrator-config";

import type { ResolvedStatusHookConfig } from "../config/runtime.ts";
import type { PullRequest } from "../domain/github.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { Task } from "../domain/task.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";

export type { StatusHookContext } from "orchestrator-config";

export interface StatusHookResult {
  output?: string;
  error?: unknown;
}

const STATUS_HOOK_PENDING_EVENT = "status_hook_pending";
const STATUS_HOOK_COMPLETED_EVENT = "status_hook_completed";
const STATUS_HOOK_RUN_COMPLETED_EVENT = "status_hook_run_completed";
const STATUS_HOOK_ATTEMPT_FAILED_EVENT = "status_hook_attempt_failed";
const DEFAULT_STATUS_HOOK_MAX_ATTEMPTS = 10;
const deliveryQueues = new WeakMap<WatcherStore, Promise<void>>();

interface StatusHookSlackClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<unknown>;
  };
}

export function createPendingStatusHookEvent(
  hooks: ResolvedStatusHookConfig[],
  task: Task,
  fromStatus: string,
  toStatus: string,
  pullRequest?: PullRequest,
): TaskEventInput | undefined {
  const hookIds = hooks
    .filter(({ status }) => normalizeStatus(status) === normalizeStatus(toStatus))
    .map(({ id }) => id);
  return hookIds.length > 0
    ? {
        taskId: task.id,
        type: STATUS_HOOK_PENDING_EVENT,
        actor: "watcher",
        fromStatus,
        toStatus,
        body: JSON.stringify({ pullRequest, hookIds }),
      }
    : undefined;
}

export async function deliverPendingStatusHooks({
  hooks,
  hooksForService,
  store,
  slackClient,
  watcherChannelId,
  taskId,
}: {
  hooks: ResolvedStatusHookConfig[];
  hooksForService?: (serviceName: string) => ResolvedStatusHookConfig[];
  store: WatcherStore;
  slackClient: StatusHookSlackClient;
  watcherChannelId: string;
  taskId?: string;
}): Promise<void> {
  const previousDelivery = deliveryQueues.get(store) ?? Promise.resolve();
  const delivery = previousDelivery.then(() =>
    deliverPendingStatusHooksSerially({
      hooks,
      hooksForService,
      store,
      slackClient,
      watcherChannelId,
      taskId,
    }),
  );
  deliveryQueues.set(
    store,
    delivery.catch(() => {}),
  );
  return delivery;
}

export async function deliverPendingStatusHooksSafely(
  options: Parameters<typeof deliverPendingStatusHooks>[0],
): Promise<void> {
  try {
    await deliverPendingStatusHooks(options);
  } catch (error) {
    console.error("Status hook delivery failed; it will be retried:", error);
  }
}

async function deliverPendingStatusHooksSerially({
  hooks,
  hooksForService,
  store,
  slackClient,
  watcherChannelId,
  taskId,
}: {
  hooks: ResolvedStatusHookConfig[];
  hooksForService?: (serviceName: string) => ResolvedStatusHookConfig[];
  store: WatcherStore;
  slackClient: StatusHookSlackClient;
  watcherChannelId: string;
  taskId?: string;
}): Promise<void> {
  for (const event of store.getUncompletedEvents(
    STATUS_HOOK_PENDING_EVENT,
    STATUS_HOOK_COMPLETED_EVENT,
    taskId,
  )) {
    const task = store.getTask(event.taskId);
    if (!task?.parentChannelId || !task.parentMessageTs || !event.fromStatus || !event.toStatus) {
      continue;
    }
    const serviceHooks = hooksForService?.(task.serviceName) ?? hooks;
    const payload = JSON.parse(event.body ?? "{}") as {
      pullRequest?: PullRequest;
      hookIds?: string[];
    };
    const hooksById = new Map(serviceHooks.map((hook) => [hook.id, hook]));
    const hookIds =
      payload.hookIds ??
      serviceHooks
        .filter(({ status }) => normalizeStatus(status) === normalizeStatus(event.toStatus!))
        .map(({ id }) => id);
    let completed = true;
    for (const hookId of hookIds) {
      const hook = hooksById.get(hookId);
      if (!hook || normalizeStatus(hook.status) !== normalizeStatus(event.toStatus)) continue;
      const completionKey = `${event.id}:${hookId}`;
      if (store.hasEvent(task.id, STATUS_HOOK_RUN_COMPLETED_EVENT, completionKey)) continue;
      const maxAttempts = hook.maxAttempts ?? DEFAULT_STATUS_HOOK_MAX_ATTEMPTS;
      const failedAttempts = store.countEventsWithBody(
        task.id,
        STATUS_HOOK_ATTEMPT_FAILED_EVENT,
        completionKey,
      );
      if (failedAttempts >= maxAttempts) {
        try {
          await slackClient.chat.postMessage({
            channel: task.parentChannelId,
            thread_ts: task.parentMessageTs,
            text: `Status hook \`${hook.id}\` failed after ${maxAttempts} attempts and will not be retried.`,
          });
          store.addEvent({
            taskId: task.id,
            type: STATUS_HOOK_RUN_COMPLETED_EVENT,
            actor: "watcher",
            fromStatus: event.fromStatus,
            toStatus: event.toStatus,
            body: completionKey,
          });
        } catch (error) {
          completed = false;
          console.error(
            `Status hook retry-limit notification failed for ${task.issueIdentifier}:`,
            error,
          );
        }
        continue;
      }
      try {
        await dispatchStatusHooks({
          hooks: [hook],
          task,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          pullRequest: payload.pullRequest,
          slackClient,
          watcherChannelId,
        });
        store.addEvent({
          taskId: task.id,
          type: STATUS_HOOK_RUN_COMPLETED_EVENT,
          actor: "watcher",
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          body: completionKey,
        });
      } catch (error) {
        store.addEvent({
          taskId: task.id,
          type: STATUS_HOOK_ATTEMPT_FAILED_EVENT,
          actor: "watcher",
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          body: completionKey,
        });
        completed = false;
        console.error(`Status hook delivery failed for ${task.issueIdentifier}:`, error);
      }
    }
    if (!completed) continue;
    store.addEvent({
      taskId: task.id,
      type: STATUS_HOOK_COMPLETED_EVENT,
      actor: "watcher",
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      body: String(event.id),
    });
  }
}

export async function dispatchStatusHooks({
  hooks,
  task,
  fromStatus,
  toStatus,
  pullRequest,
  slackClient,
  watcherChannelId,
}: {
  hooks: ResolvedStatusHookConfig[];
  task: Task;
  fromStatus: string;
  toStatus: string;
  pullRequest?: PullRequest;
  slackClient: StatusHookSlackClient;
  watcherChannelId: string;
}): Promise<void> {
  if (!task.parentChannelId || !task.parentMessageTs || hooks.length === 0) return;

  const results = await runStatusHooks(
    hooks,
    {
      event: "issue.status_changed",
      service: task.serviceName,
      issue: { identifier: task.issueIdentifier, url: task.linkUrl, title: task.title },
      transition: { from: fromStatus, to: toStatus },
      pullRequest: pullRequest ?? task.pullRequest,
    },
    {
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
    },
  );

  for (const result of results) {
    if (result.error) {
      console.error(`Status hook failed for ${task.issueIdentifier}:`, result.error);
      throw result.error;
    } else if (result.output) {
      await slackClient.chat.postMessage({
        channel: task.parentChannelId,
        thread_ts: task.parentMessageTs,
        text: result.output,
      });
    }
  }
}

export async function runStatusHooks(
  hooks: ResolvedStatusHookConfig[],
  context: StatusHookContext,
  helpers: StatusHookHelpers,
): Promise<StatusHookResult[]> {
  const matchingHooks = hooks.filter(
    ({ status }) => normalizeStatus(status) === normalizeStatus(context.transition.to),
  );

  return Promise.all(
    matchingHooks.map(async ({ run }) => {
      try {
        const value = await run(context, helpers);
        const output = typeof value === "string" ? value.trim() : "";
        return output ? { output } : {};
      } catch (error) {
        return { error };
      }
    }),
  );
}
