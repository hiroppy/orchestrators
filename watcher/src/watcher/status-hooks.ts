import type { ChatPostMessageArguments } from "@slack/web-api";

import type { ResolvedStatusHookConfig } from "../config/runtime.ts";
import type { PullRequest, StatusHookContext, StatusHookHelpers, Task } from "../domain/types.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";

export type { StatusHookContext } from "../domain/types.ts";

export interface StatusHookResult {
  output?: string;
  error?: unknown;
}

const STATUS_HOOK_PENDING_EVENT = "status_hook_pending";
const STATUS_HOOK_COMPLETED_EVENT = "status_hook_completed";
const STATUS_HOOK_RUN_COMPLETED_EVENT = "status_hook_run_completed";
const deliveryQueues = new WeakMap<WatcherStore, Promise<void>>();

interface StatusHookSlackClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<unknown>;
  };
}

export function queueStatusHooks(
  hooks: ResolvedStatusHookConfig[],
  store: WatcherStore,
  task: Task,
  fromStatus: string,
  toStatus: string,
  pullRequest?: PullRequest,
): void {
  const event = createPendingStatusHookEvent(hooks, task, fromStatus, toStatus, pullRequest);
  if (event) store.addEvent(event);
}

export function createPendingStatusHookEvent(
  hooks: ResolvedStatusHookConfig[],
  task: Task,
  fromStatus: string,
  toStatus: string,
  pullRequest?: PullRequest,
): TaskEventInput | undefined {
  return hooks.some(({ status }) => normalizeStatus(status) === normalizeStatus(toStatus))
    ? {
        taskId: task.id,
        type: STATUS_HOOK_PENDING_EVENT,
        actor: "watcher",
        fromStatus,
        toStatus,
        body: JSON.stringify({ pullRequest }),
      }
    : undefined;
}

export async function deliverPendingStatusHooks({
  hooks,
  store,
  slackClient,
  watcherChannelId,
  taskId,
}: {
  hooks: ResolvedStatusHookConfig[];
  store: WatcherStore;
  slackClient: StatusHookSlackClient;
  watcherChannelId: string;
  taskId?: string;
}): Promise<void> {
  const previousDelivery = deliveryQueues.get(store) ?? Promise.resolve();
  const delivery = previousDelivery.then(() =>
    deliverPendingStatusHooksSerially({ hooks, store, slackClient, watcherChannelId, taskId }),
  );
  deliveryQueues.set(
    store,
    delivery.catch(() => {}),
  );
  return delivery;
}

async function deliverPendingStatusHooksSerially({
  hooks,
  store,
  slackClient,
  watcherChannelId,
  taskId,
}: {
  hooks: ResolvedStatusHookConfig[];
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
    const payload = JSON.parse(event.body ?? "{}") as { pullRequest?: PullRequest };
    const matchingHooks = hooks
      .map((hook, index) => ({ hook, index }))
      .filter(({ hook }) => normalizeStatus(hook.status) === normalizeStatus(event.toStatus!));
    let completed = true;
    for (const { hook, index } of matchingHooks) {
      const completionKey = `${event.id}:${index}`;
      if (store.hasEvent(task.id, STATUS_HOOK_RUN_COMPLETED_EVENT, completionKey)) continue;
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

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}
