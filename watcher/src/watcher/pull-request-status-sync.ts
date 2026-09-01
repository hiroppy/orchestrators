import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import { isTerminalLinearStateType } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import { fetchLinearIssueState } from "../integrations/linear/issues.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { effectiveLinearStateTypeForService, linearTeamForService } from "./runtime-config.ts";

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

  await Promise.all(
    store.getTasksForLinearSync().map(async (task) => {
      if (task.issueIdentifier.startsWith("watcher:") || !task.pullRequest?.url) return;

      try {
        const team = linearTeamForService(config, task.serviceName);
        const targetStatus = team?.statuses.find(
          (status) => normalizeStatus(status) === normalizeStatus(statusSync.closed),
        );
        if (!team || !targetStatus) return;

        const pullRequest = await findPullRequestByUrl(task.pullRequest.url);
        if (!pullRequest || normalizeStatus(pullRequest.state) !== "closed") return;

        const observation = JSON.stringify({
          url: pullRequest.url,
          state: "closed",
          headRefOid: pullRequest.headRefOid ?? null,
        });
        if (store.hasEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT, observation)) return;

        const linearIssue = await fetchLinearIssue(task.issueIdentifier, {
          apiKey: team.apiKey,
          maxAttempts: 1,
        });
        if (!linearIssue) return;
        if (normalizeStatus(linearIssue.state) === "rework") return;

        const liveStateType = effectiveLinearStateTypeForService(
          config,
          task.serviceName,
          linearIssue.state,
          linearIssue.stateType,
        );
        if (isTerminalLinearStateType(liveStateType)) return;

        const storedPullRequestIdentity = pullRequestIdentity(task.pullRequest.url);
        const currentPullRequestIdentity = pullRequestIdentity(linearIssue.pullRequest?.url);
        if (!storedPullRequestIdentity || currentPullRequestIdentity !== storedPullRequestIdentity)
          return;

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
    }),
  );
}

function pullRequestIdentity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      !match
    ) {
      return undefined;
    }
    const [, owner, repository, pullRequestNumber] = match;
    const number = Number(pullRequestNumber);
    if (!Number.isSafeInteger(number) || number < 1) return undefined;
    return `${owner!.toLowerCase()}/${repository!.toLowerCase()}#${number}`;
  } catch {
    return undefined;
  }
}
