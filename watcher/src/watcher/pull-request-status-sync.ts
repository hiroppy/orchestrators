import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { linearTeamForService } from "./runtime-config.ts";

export async function syncPullRequestStatuses({
  config,
  store,
  findPullRequestByUrl,
  fetchLinearIssue,
  updateLinearStatus,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  fetchLinearIssue: typeof fetchLinearIssueState;
  updateLinearStatus: typeof updateLinearIssueStatus;
}): Promise<Set<string>> {
  const updatedTaskIds = new Set<string>();
  const statusSync = config.pullRequestStatusSync;
  if (!statusSync) return updatedTaskIds;

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
        store.setTaskPullRequest(task.id, linearIssue.pullRequest);
        continue;
      }

      const pullRequest = await findPullRequestByUrl(task.pullRequest.url);
      if (normalizeStatus(pullRequest?.state) !== "closed" || !pullRequest) continue;

      const targetStatus = team?.statuses.find(
        (status) => normalizeStatus(status) === normalizeStatus(statusSync.closed),
      );
      if (!targetStatus) continue;

      if (normalizeStatus(linearIssue.state) !== normalizeStatus(targetStatus)) {
        await updateLinearStatus(task.issueIdentifier, targetStatus, {
          apiKey: team?.apiKey,
          teamId: team?.teamId,
        });
      }
      if (normalizeStatus(task.status) !== normalizeStatus(targetStatus)) {
        updatedTaskIds.add(task.id);
      }
    } catch (error) {
      console.error(
        `Failed to inspect or sync ${task.issueIdentifier} pull request status:`,
        error,
      );
    }
  }
  return updatedTaskIds;
}
