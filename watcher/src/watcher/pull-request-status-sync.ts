import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { linearTeamForService } from "./runtime-config.ts";

const PULL_REQUEST_STATUS_SYNCED_EVENT = "pull_request_status_synced";

export async function syncPullRequestStatuses({
  config,
  store,
  fetchLinearIssue,
  findPullRequestByUrl,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  fetchLinearIssue: typeof fetchLinearIssueState;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<void> {
  const statusSync = config.pullRequestStatusSync;
  if (!statusSync) return;

  for (const task of store.getTasksForLinearSync()) {
    if (task.issueIdentifier.startsWith("watcher:") || !task.pullRequest?.url) continue;

    try {
      const team = linearTeamForService(config, task.serviceName);
      const targetStatus = team?.statuses.find(
        (status) => normalizeStatus(status) === normalizeStatus(statusSync.closed),
      );
      if (!team || !targetStatus) continue;

      const linearIssue = await fetchLinearIssue(task.issueIdentifier, {
        apiKey: team.apiKey,
        maxAttempts: 1,
      });
      if (linearIssue?.pullRequest?.url !== task.pullRequest.url) continue;

      const pullRequest = await findPullRequestByUrl(task.pullRequest.url);
      if (!pullRequest || normalizeStatus(pullRequest.state) !== "closed") continue;

      const observation = JSON.stringify({
        url: pullRequest.url,
        state: "closed",
        headRefOid: pullRequest.headRefOid ?? null,
      });
      if (store.hasEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT, observation)) continue;

      await updateLinearStatus(task.issueIdentifier, targetStatus, {
        apiKey: team.apiKey,
        teamId: team.teamId,
      });
      store.addEvent({
        taskId: task.id,
        type: PULL_REQUEST_STATUS_SYNCED_EVENT,
        actor: "watcher",
        fromStatus: task.status,
        toStatus: targetStatus,
        body: observation,
      });
    } catch (error) {
      console.error(
        `Pull request status sync failed for ${task.issueIdentifier}; it will be retried:`,
        error,
      );
    }
  }
}
