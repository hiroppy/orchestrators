import type { WebClient } from "@slack/web-api";

import type { ResolvedWatcherRuntimeConfig } from "../config/runtime.ts";
import type { PullRequest } from "../domain/github.ts";
import { enteredTerminalLinearState, isTerminalLinearStateType } from "../domain/linear.ts";
import type { Task } from "../domain/task.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import { findPullRequestByUrl as findPullRequestByUrlDefault } from "../integrations/github/pull-requests.ts";
import {
  fetchLinearIssueState,
  fetchLinearIssueStateSummaries,
} from "../integrations/linear/issues.ts";
import { isLinearRateLimitError } from "../integrations/linear/client.ts";
import type { updateLinearIssueStatus } from "../integrations/linear/status.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { normalizeStatus } from "../domain/status.ts";
import { syncPullRequestReactionsSafely } from "./pull-request-reactions.ts";
import { checkReviewReadyNotificationSafely } from "./review-ready.ts";
import { decideReviewRequeue, shouldFetchReviewComments } from "./review-comments.ts";
import { enrichCreatorAssignee } from "./event-enrichment.ts";
import { processWatcherEvent } from "./process-event.ts";
import { effectiveLinearStateTypeForService, linearTeamForService } from "./runtime-config.ts";

export async function reconcileLinearStatuses({
  config,
  store,
  slackClient,
  slackChannelId,
  skipTaskIds,
  findPullRequestByUrl,
  updateLinearStatus,
  persistedTerminalTaskIds,
}: {
  config: ResolvedWatcherRuntimeConfig;
  store: WatcherStore;
  slackClient: WebClient;
  slackChannelId: string;
  skipTaskIds: Set<string>;
  findPullRequestByUrl: typeof findPullRequestByUrlDefault;
  updateLinearStatus: typeof updateLinearIssueStatus;
  persistedTerminalTaskIds: ReadonlySet<string>;
}): Promise<Set<string>> {
  const pendingPersistedTerminalTaskIds = new Set(persistedTerminalTaskIds);
  const activeStatusesByService = new Map(
    config.services.map(({ name, activeStates }) => [name, activeStates ?? []]),
  );
  const syncCandidates = store.getTasksForLinearSync(
    pendingPersistedTerminalTaskIds,
    activeStatusesByService,
  );
  const tasks = syncCandidates
    .map((task) => {
      const effectiveStateType = effectiveLinearStateTypeForService(
        config,
        task.serviceName,
        task.status,
        task.linearStateType,
      );
      if (
        !isTerminalLinearStateType(task.linearStateType) ||
        isTerminalLinearStateType(effectiveStateType)
      ) {
        return task;
      }
      store.setTaskLinearStateType(task.id, effectiveStateType);
      pendingPersistedTerminalTaskIds.delete(task.id);
      return { ...task, linearStateType: effectiveStateType };
    })
    .filter(
      (task) =>
        pendingPersistedTerminalTaskIds.has(task.id) ||
        isTaskEligibleForNormalLinearReconciliation(config, task, skipTaskIds),
    );
  const linearTeamByService = new Map(
    config.services.map(({ name, linearTeam }) => [name, linearTeam]),
  );
  const tasksByTeam = new Map<string, Task[]>();
  for (const task of tasks) {
    const teamName = linearTeamByService.get(task.serviceName);
    if (!teamName) continue;
    const teamTasks = tasksByTeam.get(teamName) ?? [];
    teamTasks.push(task);
    tasksByTeam.set(teamName, teamTasks);
  }
  const summaries = new Map<string, Awaited<ReturnType<typeof fetchLinearIssueStateSummaries>>>();
  const rateLimitedTeams = new Set<string>();
  for (const [teamName, teamTasks] of tasksByTeam) {
    try {
      summaries.set(
        teamName,
        await fetchLinearIssueStateSummaries(
          teamTasks.map(({ issueIdentifier }) => issueIdentifier),
          { apiKey: config.linearTeams[teamName]?.apiKey },
        ),
      );
    } catch (error) {
      if (!isLinearRateLimitError(error)) throw error;
      rateLimitedTeams.add(teamName);
    }
  }

  for (const task of tasks) {
    const recoveringPersistedTerminalTask = pendingPersistedTerminalTaskIds.has(task.id);
    const teamName = linearTeamByService.get(task.serviceName);
    if (teamName && rateLimitedTeams.has(teamName)) continue;
    const summary = teamName ? summaries.get(teamName)?.get(task.issueIdentifier) : undefined;
    if (summary?.state) {
      const fetchReviewComments = shouldFetchReviewComments(config, summary.state);
      const sameStatus = normalizeStatus(summary.state) === normalizeStatus(task.status);
      const effectiveStateType = effectiveLinearStateTypeForService(
        config,
        task.serviceName,
        summary.state,
        summary.stateType,
      );
      const enteredTerminalState = enteredTerminalLinearState(
        task.linearStateType,
        effectiveStateType,
      );
      if (
        sameStatus &&
        !enteredTerminalState &&
        !fetchReviewComments &&
        !shouldRefreshPullRequestForStatusSync(config, task.status)
      ) {
        if (effectiveStateType) {
          store.setTaskLinearStateType(task.id, effectiveStateType);
          pendingPersistedTerminalTaskIds.delete(task.id);
        }
        if (!pendingPersistedTerminalTaskIds.has(task.id)) continue;
      }
      if (effectiveStateType && recoveringPersistedTerminalTask && sameStatus) {
        store.setTaskLinearStateType(task.id, effectiveStateType);
        pendingPersistedTerminalTaskIds.delete(task.id);
        if (!isTaskEligibleForNormalLinearReconciliation(config, task, skipTaskIds)) continue;
      }
    }

    const linearIssue = await fetchLinearIssueState(task.issueIdentifier, {
      apiKey: linearTeamForService(config, task.serviceName)?.apiKey,
      includeCreator: true,
      maxAttempts: 1,
    });
    if (!linearIssue?.state) continue;
    const detailedSameStatus = normalizeStatus(linearIssue.state) === normalizeStatus(task.status);
    const effectiveStateType = effectiveLinearStateTypeForService(
      config,
      task.serviceName,
      linearIssue.state,
      linearIssue.stateType,
    );
    if (effectiveStateType && recoveringPersistedTerminalTask && detailedSameStatus) {
      store.setTaskLinearStateType(task.id, effectiveStateType);
      pendingPersistedTerminalTaskIds.delete(task.id);
      if (!isTaskEligibleForNormalLinearReconciliation(config, task, skipTaskIds)) continue;
    }
    const detailedEnteredTerminalState = enteredTerminalLinearState(
      task.linearStateType,
      effectiveStateType,
    );
    const reviewComment = config.reviewComment;
    const fetchDetailedReviewComments = shouldFetchReviewComments(config, linearIssue.state);
    if (
      detailedSameStatus &&
      !detailedEnteredTerminalState &&
      !fetchDetailedReviewComments &&
      !shouldRefreshPullRequestForStatusSync(config, task.status)
    ) {
      if (effectiveStateType) {
        store.setTaskLinearStateType(task.id, effectiveStateType);
      }
      continue;
    }
    let pullRequest = linearIssue.pullRequest;
    if (pullRequest?.url) {
      const enrichedPullRequest = await findPullRequestByUrl(pullRequest.url, {
        includeLatestReviewComment: fetchDetailedReviewComments,
        symphonyGitHubLogins: reviewComment?.symphonyGitHubLogins,
      }).catch(() => null);
      pullRequest = enrichedPullRequest ?? pullRequest;
    }
    if (storedPullRequestChanged(task.pullRequest, pullRequest)) {
      store.setTaskPullRequest(task.id, pullRequest);
    }
    await syncPullRequestReactionsSafely(slackClient, task, pullRequest);

    const event: WatcherEvent = {
      type: "updated",
      service: task.serviceName,
      linearIssueId: linearIssue.id,
      issueIdentifier: task.issueIdentifier,
      issueTitle: linearIssue.title,
      creatorName: linearIssue.creatorName,
      creatorEmail: linearIssue.creatorEmail,
      issueUrl: linearIssue.url ?? task.linkUrl,
      state: task.status,
      resolvedState: linearIssue.state,
      resolvedStateType: effectiveStateType,
      pullRequest,
      relatedIssues: linearIssue.relatedIssues,
    };
    const reviewDecision = decideReviewRequeue(config, store, event);
    if (!reviewDecision.shouldRequeue && reviewComment) {
      await checkReviewReadyNotificationSafely({
        store,
        slackClient,
        task: { ...task, status: linearIssue.state },
        inReviewStatus: reviewComment.inReviewStatus,
        delayMs: reviewComment.reviewReadyDelayMs,
        pullRequest,
      });
    }
    if (detailedSameStatus && !reviewDecision.shouldRequeue && !detailedEnteredTerminalState) {
      if (effectiveStateType) {
        store.setTaskLinearStateType(task.id, effectiveStateType);
      }
      continue;
    }

    const enrichedEvent = await enrichCreatorAssignee(event, slackClient);

    await processWatcherEvent({
      config,
      store,
      slackClient,
      slackChannelId,
      event: enrichedEvent,
      reviewDecision,
      updateLinearStatus,
    });
    if (recoveringPersistedTerminalTask) {
      pendingPersistedTerminalTaskIds.delete(task.id);
    }
  }
  return pendingPersistedTerminalTaskIds;
}

function storedPullRequestChanged(
  previous: PullRequest | undefined,
  current: PullRequest | undefined,
) {
  return (
    previous?.url !== current?.url ||
    previous?.number !== current?.number ||
    previous?.title !== current?.title ||
    JSON.stringify(previous?.labels) !== JSON.stringify(current?.labels)
  );
}

function isTaskEligibleForNormalLinearReconciliation(
  config: ResolvedWatcherRuntimeConfig,
  task: Task,
  skipTaskIds: ReadonlySet<string>,
): boolean {
  const shouldRefreshPullRequest = shouldRefreshPullRequestForStatusSync(config, task.status);
  const hasCurrentLinearState =
    skipTaskIds.has(task.id) &&
    Boolean(task.linearStateType) &&
    !shouldFetchReviewComments(config, task.status) &&
    !shouldRefreshPullRequest;
  return !(
    hasCurrentLinearState ||
    task.issueIdentifier.startsWith("watcher:") ||
    !task.parentChannelId ||
    !task.parentMessageTs
  );
}

function shouldRefreshPullRequestForStatusSync(
  config: ResolvedWatcherRuntimeConfig,
  status: string,
): boolean {
  const review = config.reviewComment;
  return Boolean(review && normalizeStatus(status) === normalizeStatus(review.inProgressStatus));
}
