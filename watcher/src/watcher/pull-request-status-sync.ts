import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { Task } from "../domain/task.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";
import { linearTeamForService, serviceConfigFor } from "./runtime-config.ts";
import { createPendingStatusHookEvent } from "./status-hooks.ts";

const PULL_REQUEST_STATUS_SYNCED_EVENT = "pull_request_status_synced";

export async function syncPullRequestStatuses({
  config,
  store,
  findPullRequestByUrl,
  fetchLinearIssue,
  publishStatusTransition,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  fetchLinearIssue: typeof fetchLinearIssueState;
  publishStatusTransition: (task: Task) => Promise<void>;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const statusSync = config.pullRequestStatusSync;
  if (!statusSync) return;

  for (const task of store.getTasksForLinearSync()) {
    if (!task.pullRequest?.url || task.issueIdentifier.startsWith("watcher:")) continue;

    try {
      const team = linearTeamForService(config, task.serviceName);
      const linearIssue = await fetchLinearIssue(task.issueIdentifier, {
        apiKey: team?.apiKey,
        maxAttempts: 1,
      });
      if (linearIssue?.pullRequest?.url !== task.pullRequest.url) {
        store.setTaskPullRequest(task.id, linearIssue?.pullRequest);
        continue;
      }

      const pullRequest = await findPullRequestByUrl(task.pullRequest.url);
      if (normalizeStatus(pullRequest?.state) !== "closed" || !pullRequest) continue;

      const targetStatus = team?.statuses.find(
        (status) => normalizeStatus(status) === normalizeStatus(statusSync.closed),
      );
      if (!targetStatus) continue;

      const eventKey = JSON.stringify({
        url: pullRequest.url,
        state: normalizeStatus(pullRequest.state),
        headRefOid: pullRequest.headRefOid ?? null,
      });
      if (store.hasEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT, eventKey)) continue;

      let updatedTask = task;
      if (normalizeStatus(task.status) !== normalizeStatus(targetStatus)) {
        await updateLinearStatus(task.issueIdentifier, targetStatus, {
          apiKey: team?.apiKey,
          teamId: team?.teamId,
        });
        const hooks = serviceConfigFor(config, task.serviceName)?.statusHooks ?? [];
        updatedTask = store.updateTaskStatusAtomically(
          task.id,
          targetStatus,
          (persistedTask, fromStatus) =>
            createPendingStatusHookEvent(
              hooks,
              persistedTask,
              fromStatus,
              targetStatus,
              pullRequest,
            ),
        ).task;
      }

      await publishStatusTransition(updatedTask);
      recordStatusSync(store, task.id, task.status, targetStatus, eventKey);
    } catch (error) {
      console.error(
        `Failed to inspect or sync ${task.issueIdentifier} pull request status:`,
        error,
      );
    }
  }
}

function recordStatusSync(
  store: WatcherStore,
  taskId: string,
  fromStatus: string,
  toStatus: string,
  eventKey: string,
): void {
  store.addEvent(statusSyncEvent(taskId, fromStatus, toStatus, eventKey));
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
