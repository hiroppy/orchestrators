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
  includedTaskIds = new Set(),
  publishLinearUpdate,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  fetchLinearIssue: typeof fetchLinearIssueState;
  includedTaskIds?: ReadonlySet<string>;
  publishLinearUpdate: (task: Task, pullRequest: Task["pullRequest"]) => Promise<void>;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const statusSync = config.pullRequestStatusSync;
  if (!statusSync) return;

  for (const task of store.getTasksForLinearSync(includedTaskIds)) {
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
        continue;
      }
      if (!pullRequestUrl) continue;

      const pullRequest = await findPullRequestByUrl(pullRequestUrl);
      if (!pullRequest) continue;
      if (normalizeStatus(pullRequest.state) !== "closed") {
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
