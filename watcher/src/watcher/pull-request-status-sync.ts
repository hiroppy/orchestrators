import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";
import { linearTeamForService, serviceConfigFor } from "./runtime-config.ts";
import { createPendingStatusHookEvent } from "./status-hooks.ts";

const PULL_REQUEST_STATUS_SYNCED_EVENT = "pull_request_status_synced";

export async function syncPullRequestStatuses({
  config,
  store,
  findPullRequestByUrl,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const statusSync = config.pullRequestStatusSync;
  if (!statusSync) return;

  for (const task of store.getTasksForLinearSync()) {
    if (!task.pullRequest?.url || task.issueIdentifier.startsWith("watcher:")) continue;

    try {
      const pullRequest = await findPullRequestByUrl(task.pullRequest.url);
      if (normalizeStatus(pullRequest?.state) !== "closed" || !pullRequest) continue;

      const team = linearTeamForService(config, task.serviceName);
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

      if (normalizeStatus(task.status) === normalizeStatus(targetStatus)) {
        recordStatusSync(store, task.id, task.status, targetStatus, eventKey);
        continue;
      }

      await updateLinearStatus(task.issueIdentifier, targetStatus, {
        apiKey: team?.apiKey,
        teamId: team?.teamId,
      });
      const hooks = serviceConfigFor(config, task.serviceName)?.statusHooks ?? [];
      store.updateTaskStatusAtomically(task.id, targetStatus, (updatedTask, fromStatus) => {
        const hookEvent = createPendingStatusHookEvent(
          hooks,
          updatedTask,
          fromStatus,
          targetStatus,
          pullRequest,
        );
        return [
          ...(hookEvent ? [hookEvent] : []),
          statusSyncEvent(task.id, fromStatus, targetStatus, eventKey),
        ];
      });
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
