import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { Task } from "../domain/task.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";
import { linearTeamForService } from "./runtime-config.ts";

const PULL_REQUEST_STATUS_SYNCED_EVENT = "pull_request_status_synced";
const PULL_REQUEST_STATUS_SYNC_PENDING_EVENT = "pull_request_status_sync_pending";
const PULL_REQUEST_STATUS_SYNC_COMPLETED_EVENT = "pull_request_status_sync_completed";
const PULL_REQUEST_STATUS_SYNC_REOPENED_EVENT = "pull_request_status_sync_reopened";

export async function syncPullRequestStatuses({
  config,
  store,
  findPullRequestByUrl,
  fetchLinearIssue,
  publishLinearUpdate,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  fetchLinearIssue: typeof fetchLinearIssueState;
  publishLinearUpdate: (task: Task, pullRequest: Task["pullRequest"]) => Promise<void>;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const statusSync = config.pullRequestStatusSync;
  if (!statusSync) return;
  const pendingTaskIds = new Set(
    store.getTaskIdsWithIncompleteEvent(
      PULL_REQUEST_STATUS_SYNC_PENDING_EVENT,
      PULL_REQUEST_STATUS_SYNC_COMPLETED_EVENT,
    ),
  );

  for (const task of store.getTasksForLinearSync(pendingTaskIds)) {
    if (task.issueIdentifier.startsWith("watcher:")) continue;

    try {
      const team = linearTeamForService(config, task.serviceName);
      const linearIssue = await fetchLinearIssue(task.issueIdentifier, {
        apiKey: team?.apiKey,
        maxAttempts: 1,
      });
      if (!linearIssue) continue;
      const pullRequestUrl = task.pullRequest?.url;
      if (linearIssue.pullRequest?.url !== pullRequestUrl) {
        await publishPullRequestChange(store, task, linearIssue.pullRequest, publishLinearUpdate);
        completePendingStatusSync(
          store,
          task,
          pendingTaskIds,
          JSON.stringify({ pullRequestUrl: linearIssue.pullRequest?.url ?? null }),
        );
        continue;
      }
      if (!pullRequestUrl) continue;

      const pullRequest = await findPullRequestByUrl(pullRequestUrl);
      if (!pullRequest) continue;
      const pullRequestState = normalizeStatus(pullRequest.state);
      if (pullRequestState !== "closed") {
        if (pullRequestState === "open") recordPullRequestReopen(store, task, pullRequest);
        if (pendingTaskIds.has(task.id)) {
          await publishLinearUpdate(task, pullRequest);
          completePendingStatusSync(
            store,
            task,
            pendingTaskIds,
            JSON.stringify({
              url: pullRequest.url,
              state: pullRequestState,
              headRefOid: pullRequest.headRefOid ?? null,
            }),
          );
          continue;
        }
        if (pullRequestMetadataChanged(task.pullRequest, pullRequest)) {
          await publishPullRequestChange(store, task, pullRequest, publishLinearUpdate);
        }
        continue;
      }

      const targetStatus = team?.statuses.find(
        (status) => normalizeStatus(status) === normalizeStatus(statusSync.closed),
      );
      if (!targetStatus) continue;

      const eventKey = JSON.stringify({
        url: pullRequest.url,
        state: pullRequestState,
        headRefOid: pullRequest.headRefOid ?? null,
        reopenEventId: store.getLatestEvent(task.id, PULL_REQUEST_STATUS_SYNC_REOPENED_EVENT)?.id,
      });
      if (store.hasEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT, eventKey)) {
        if (pendingTaskIds.has(task.id)) {
          store.addEvent(statusSyncCompletedEvent(task.id, task.status, eventKey));
        }
        continue;
      }
      if (!pendingTaskIds.has(task.id)) {
        store.addEvent({
          taskId: task.id,
          type: PULL_REQUEST_STATUS_SYNC_PENDING_EVENT,
          actor: "watcher",
          fromStatus: task.status,
          toStatus: targetStatus,
          body: eventKey,
        });
        pendingTaskIds.add(task.id);
      }

      if (normalizeStatus(linearIssue.state) !== normalizeStatus(targetStatus)) {
        await updateLinearStatus(task.issueIdentifier, targetStatus, {
          apiKey: team?.apiKey,
          teamId: team?.teamId,
        });
      }

      await publishLinearUpdate(task, pullRequest);
      const publishedStatus = store.getTask(task.id)?.status;
      if (normalizeStatus(publishedStatus) !== normalizeStatus(targetStatus)) {
        throw new Error(
          `Published ${task.issueIdentifier} as ${publishedStatus ?? "an unknown status"} instead of ${targetStatus}.`,
        );
      }
      recordStatusSync(store, task.id, task.status, targetStatus, eventKey);
    } catch (error) {
      console.error(
        `Failed to inspect or sync ${task.issueIdentifier} pull request status:`,
        error,
      );
    }
  }
}

function completePendingStatusSync(
  store: WatcherStore,
  task: Task,
  pendingTaskIds: Set<string>,
  body: string,
): void {
  if (!pendingTaskIds.has(task.id)) return;
  const status = store.getTask(task.id)?.status ?? task.status;
  store.addEvent(statusSyncCompletedEvent(task.id, status, body));
  pendingTaskIds.delete(task.id);
}

function recordPullRequestReopen(
  store: WatcherStore,
  task: Task,
  pullRequest: NonNullable<Task["pullRequest"]>,
): void {
  const synced = store.getLatestEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT);
  const reopened = store.getLatestEvent(task.id, PULL_REQUEST_STATUS_SYNC_REOPENED_EVENT);
  if (!synced || (reopened && reopened.id > synced.id)) return;
  store.addEvent({
    taskId: task.id,
    type: PULL_REQUEST_STATUS_SYNC_REOPENED_EVENT,
    actor: "watcher",
    fromStatus: task.status,
    toStatus: task.status,
    body: JSON.stringify({
      url: pullRequest.url,
      headRefOid: pullRequest.headRefOid ?? null,
    }),
  });
}

async function publishPullRequestChange(
  store: WatcherStore,
  task: Task,
  pullRequest: Task["pullRequest"],
  publishLinearUpdate: (task: Task, pullRequest: Task["pullRequest"]) => Promise<void>,
): Promise<void> {
  try {
    await publishLinearUpdate(task, pullRequest);
  } catch (error) {
    store.setTaskPullRequest(task.id, task.pullRequest);
    throw error;
  }
}

function pullRequestMetadataChanged(
  current: Task["pullRequest"],
  observed: NonNullable<Task["pullRequest"]>,
): boolean {
  return (
    current?.url !== observed.url ||
    current.number !== observed.number ||
    current.title !== observed.title ||
    JSON.stringify(current.labels ?? []) !== JSON.stringify(observed.labels ?? [])
  );
}

function recordStatusSync(
  store: WatcherStore,
  taskId: string,
  fromStatus: string,
  toStatus: string,
  eventKey: string,
): void {
  store.addEvents([
    statusSyncEvent(taskId, fromStatus, toStatus, eventKey),
    statusSyncCompletedEvent(taskId, toStatus, eventKey),
  ]);
}

function statusSyncCompletedEvent(
  taskId: string,
  status: string,
  eventKey: string,
): TaskEventInput {
  return {
    taskId,
    type: PULL_REQUEST_STATUS_SYNC_COMPLETED_EVENT,
    actor: "watcher",
    fromStatus: status,
    toStatus: status,
    body: eventKey,
  };
}

function statusSyncEvent(
  taskId: string,
  fromStatus: string,
  toStatus: string,
  eventKey: string,
): TaskEventInput {
  return {
    taskId,
    type: PULL_REQUEST_STATUS_SYNCED_EVENT,
    actor: "watcher",
    fromStatus,
    toStatus,
    body: eventKey,
  };
}
