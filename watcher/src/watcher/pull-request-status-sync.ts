import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { Task } from "../domain/task.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";
import { linearTeamForService } from "./runtime-config.ts";

const PULL_REQUEST_STATUS_SYNCED_EVENT = "pull_request_status_synced";

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

  for (const task of store.getTasksForLinearSync()) {
    if (!task.pullRequest?.url || task.issueIdentifier.startsWith("watcher:")) continue;

    try {
      const team = linearTeamForService(config, task.serviceName);
      const linearIssue = await fetchLinearIssue(task.issueIdentifier, {
        apiKey: team?.apiKey,
        maxAttempts: 1,
      });
      if (!linearIssue) continue;
      if (linearIssue.pullRequest?.url !== task.pullRequest.url) {
        try {
          await publishLinearUpdate(task, linearIssue.pullRequest);
        } catch (error) {
          store.setTaskPullRequest(task.id, task.pullRequest);
          throw error;
        }
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
