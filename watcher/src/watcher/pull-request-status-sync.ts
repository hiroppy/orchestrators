import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { isTerminalLinearStateType } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { Task } from "../domain/task.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";
import { effectiveLinearStateTypeForService, linearTeamForService } from "./runtime-config.ts";

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

  const tasks = store
    .getTasksForLinearSync(pendingTaskIds, new Map(), true)
    .filter(
      (task) =>
        !isTerminalLinearStateType(task.linearStateType) ||
        pendingTaskIds.has(task.id) ||
        Boolean(store.getLatestEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT)),
    );

  for (const task of tasks) {
    if (task.issueIdentifier.startsWith("watcher:")) continue;

    try {
      const team = linearTeamForService(config, task.serviceName);
      const targetStatus = team?.statuses.find(
        (status) => normalizeStatus(status) === normalizeStatus(statusSync.closed),
      );
      const linearIssue = await fetchLinearIssue(task.issueIdentifier, {
        apiKey: team?.apiKey,
        maxAttempts: 1,
      });
      if (!linearIssue) continue;
      const liveLinearStateType = effectiveLinearStateTypeForService(
        config,
        task.serviceName,
        linearIssue.state,
        linearIssue.stateType,
      );
      const pendingSync = pendingTaskIds.has(task.id)
        ? store.getLatestEvent(task.id, PULL_REQUEST_STATUS_SYNC_PENDING_EVENT)
        : undefined;
      const closedLifecycleStatus =
        pendingSync &&
        targetStatus &&
        normalizeStatus(linearIssue.state) === normalizeStatus(targetStatus)
          ? targetStatus
          : undefined;
      const pullRequestUrl = task.pullRequest?.url;
      if (!samePullRequest(linearIssue.pullRequest?.url, pullRequestUrl)) {
        const attachmentChangeKey = JSON.stringify({
          pullRequestUrl: linearIssue.pullRequest?.url ?? null,
        });
        ensurePendingStatusSync(
          store,
          task,
          pendingTaskIds,
          linearIssue.state ?? task.status,
          attachmentChangeKey,
        );
        await publishPullRequestChange(store, task, linearIssue.pullRequest, publishLinearUpdate);
        if (closedLifecycleStatus) {
          store.addEvent(
            statusSyncEvent(
              task.id,
              task.status,
              closedLifecycleStatus,
              pendingSync?.body ?? attachmentChangeKey,
            ),
          );
        }
        completePendingStatusSync(store, task, pendingTaskIds, attachmentChangeKey);
        continue;
      }
      if (!pullRequestUrl) continue;

      const pullRequest = await findPullRequestByUrl(pullRequestUrl);
      if (!pullRequest) continue;
      const pullRequestState = normalizeStatus(pullRequest.state);
      const pullRequestObservationKey = JSON.stringify({
        url: pullRequest.url,
        state: pullRequestState,
        headRefOid: pullRequest.headRefOid ?? null,
      });
      if (pullRequestState !== "closed") {
        if (pendingTaskIds.has(task.id)) {
          await publishLinearUpdate(task, pullRequest);
          if (closedLifecycleStatus) {
            store.addEvent(
              statusSyncEvent(
                task.id,
                task.status,
                closedLifecycleStatus,
                pendingSync?.body ?? pullRequestObservationKey,
              ),
            );
          }
          if (pullRequestState === "open") recordPullRequestReopen(store, task, pullRequest);
          completePendingStatusSync(store, task, pendingTaskIds, pullRequestObservationKey);
          continue;
        }
        if (pullRequestState === "open") recordPullRequestReopen(store, task, pullRequest);
        if (
          isTerminalLinearStateType(task.linearStateType) &&
          (normalizeStatus(task.status) !== normalizeStatus(linearIssue.state) ||
            normalizeStatus(task.linearStateType) !== normalizeStatus(liveLinearStateType))
        ) {
          await publishLinearUpdate(task, pullRequest);
          continue;
        }
        if (pullRequestMetadataChanged(task.pullRequest, pullRequest)) {
          const metadataChangeKey = pullRequestObservationKey;
          ensurePendingStatusSync(
            store,
            task,
            pendingTaskIds,
            linearIssue.state ?? task.status,
            metadataChangeKey,
          );
          await publishPullRequestChange(store, task, pullRequest, publishLinearUpdate);
          completePendingStatusSync(store, task, pendingTaskIds, metadataChangeKey);
        }
        continue;
      }
      if (!targetStatus) continue;
      const eventKey = JSON.stringify({
        url: pullRequest.url,
        state: pullRequestState,
        reopenEventId: store.getLatestEvent(task.id, PULL_REQUEST_STATUS_SYNC_REOPENED_EVENT)?.id,
      });
      if (
        isTerminalLinearStateType(liveLinearStateType) &&
        normalizeStatus(linearIssue.state) !== normalizeStatus(targetStatus)
      ) {
        const terminalStateKey = JSON.stringify({
          state: linearIssue.state,
          stateType: linearIssue.stateType,
        });
        const shouldPublish =
          pendingTaskIds.has(task.id) ||
          normalizeStatus(task.status) !== normalizeStatus(linearIssue.state) ||
          normalizeStatus(task.linearStateType) !== normalizeStatus(liveLinearStateType);
        if (shouldPublish) {
          ensurePendingStatusSync(
            store,
            task,
            pendingTaskIds,
            linearIssue.state ?? task.status,
            terminalStateKey,
          );
          await publishLinearUpdate(task, pullRequest);
        }
        if (!store.hasEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT, eventKey)) {
          store.addEvent(
            statusSyncEvent(task.id, task.status, linearIssue.state ?? task.status, eventKey),
          );
        }
        completePendingStatusSync(store, task, pendingTaskIds, terminalStateKey);
        continue;
      }
      if (store.hasEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT, eventKey)) {
        if (
          pendingTaskIds.has(task.id) ||
          normalizeStatus(task.status) !== normalizeStatus(linearIssue.state) ||
          normalizeStatus(task.linearStateType) !== normalizeStatus(liveLinearStateType)
        ) {
          await publishLinearUpdate(task, pullRequest);
        }
        if (pendingTaskIds.has(task.id)) {
          store.addEvent(statusSyncCompletedEvent(task.id, task.status, eventKey));
        }
        continue;
      }
      ensurePendingStatusSync(store, task, pendingTaskIds, targetStatus, eventKey);

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

function ensurePendingStatusSync(
  store: WatcherStore,
  task: Task,
  pendingTaskIds: Set<string>,
  toStatus: string,
  body: string,
): void {
  if (pendingTaskIds.has(task.id)) return;
  store.addEvent({
    taskId: task.id,
    type: PULL_REQUEST_STATUS_SYNC_PENDING_EVENT,
    actor: "watcher",
    fromStatus: task.status,
    toStatus,
    body,
  });
  pendingTaskIds.add(task.id);
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
  if (!current) return true;
  return (
    !samePullRequest(current.url, observed.url) ||
    current.number !== observed.number ||
    current.title !== observed.title ||
    JSON.stringify(current.labels ?? []) !== JSON.stringify(observed.labels ?? [])
  );
}

function samePullRequest(left: string | undefined, right: string | undefined): boolean {
  if (left === right) return true;
  const leftIdentity = pullRequestIdentity(left);
  return leftIdentity !== undefined && leftIdentity === pullRequestIdentity(right);
}

function pullRequestIdentity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
    if (!match) return undefined;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number < 1) return undefined;
    return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${number}`;
  } catch {
    return undefined;
  }
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
