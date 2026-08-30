import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { PullRequest } from "../domain/github.ts";
import { isTerminalLinearStateType } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { REVIEW_REQUEUE_BASELINE_EVENT } from "./review-comments.ts";
import { linearTeamForService } from "./runtime-config.ts";

const PULL_REQUEST_STATUS_SYNCED_EVENT = "pull_request_status_synced";
const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

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
  const review = config.reviewComment;
  if (!statusSync && !review) return;

  for (const task of store.getTasksForLinearSync()) {
    if (!task.pullRequest?.url || task.issueIdentifier.startsWith("watcher:")) continue;

    const pullRequest = await findPullRequestByUrl(task.pullRequest.url);
    const targetStatus = pullRequest
      ? targetStatusForPullRequest(
          task.status,
          task.linearStateType,
          task.pullRequest.headRefOid,
          store.getLatestEvent(task.id, REVIEW_REQUEUE_BASELINE_EVENT)?.body,
          pullRequest,
          statusSync?.closed,
          review,
        )
      : undefined;
    if (!targetStatus || !pullRequest) continue;
    const eventKey = JSON.stringify({
      url: pullRequest.url,
      state: normalizeStatus(pullRequest.state),
      headRefOid: pullRequest.headRefOid ?? null,
      targetStatus,
      checks:
        pullRequest.checks?.map(({ name, status, conclusion }) => ({
          name,
          status: normalizeStatus(status ?? ""),
          conclusion: normalizeStatus(conclusion ?? ""),
        })) ?? null,
    });
    if (store.getLatestEvent(task.id, PULL_REQUEST_STATUS_SYNCED_EVENT)?.body === eventKey)
      continue;

    if (normalizeStatus(task.status) === normalizeStatus(targetStatus)) {
      recordStatusSync(store, task.id, task.status, targetStatus, eventKey);
      continue;
    }

    const team = linearTeamForService(config, task.serviceName);
    try {
      await updateLinearStatus(task.issueIdentifier, targetStatus, {
        apiKey: team?.apiKey,
        teamId: team?.teamId,
      });
      recordStatusSync(store, task.id, task.status, targetStatus, eventKey);
    } catch (error) {
      console.error(
        `Failed to sync ${task.issueIdentifier} from pull request state to ${targetStatus}:`,
        error,
      );
    }
  }
}

function targetStatusForPullRequest(
  taskStatus: string,
  linearStateType: string | undefined,
  previousHeadRefOid: string | null | undefined,
  reviewRequeueHeadRefOid: string | undefined,
  pullRequest: PullRequest,
  closedStatus: string | undefined,
  review: ResolvedWatcherRuntimeConfig["reviewComment"],
): string | undefined {
  if (normalizeStatus(pullRequest.state) === "closed") {
    return isTerminalLinearStateType(linearStateType) ? undefined : closedStatus;
  }
  if (!review) return undefined;
  const normalizedTaskStatus = normalizeStatus(taskStatus);
  const checksObserved = Boolean(pullRequest.checks?.length);
  const headChanged = Boolean(
    previousHeadRefOid && pullRequest.headRefOid && previousHeadRefOid !== pullRequest.headRefOid,
  );
  if (
    normalizedTaskStatus === normalizeStatus(review.inReviewStatus) &&
    (pullRequest.isDraft === true ||
      headChanged ||
      (checksObserved && !checksPassed(pullRequest.checks)))
  ) {
    return review.inProgressStatus;
  }
  if (
    normalizedTaskStatus === normalizeStatus(review.inProgressStatus) &&
    normalizeStatus(pullRequest.state) === "open" &&
    pullRequest.isDraft === false &&
    (reviewRequeueHeadRefOid === undefined || pullRequest.headRefOid !== reviewRequeueHeadRefOid) &&
    checksPassed(pullRequest.checks)
  ) {
    return review.inReviewStatus;
  }
  return undefined;
}

function checksPassed(checks: PullRequest["checks"]): boolean {
  if (!checks?.length) return false;
  return checks.every(
    ({ status, conclusion }) =>
      normalizeStatus(status ?? "") === "completed" &&
      PASSING_CHECK_CONCLUSIONS.has(normalizeStatus(conclusion ?? "")),
  );
}

function recordStatusSync(
  store: WatcherStore,
  taskId: string,
  fromStatus: string,
  toStatus: string,
  eventKey: string,
): void {
  store.addEvent({
    taskId,
    type: PULL_REQUEST_STATUS_SYNCED_EVENT,
    actor: "watcher",
    fromStatus,
    toStatus,
    body: eventKey,
  });
}
