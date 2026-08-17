import type { PullRequest } from "../../domain/github.ts";
import { findPullRequestByUrl } from "../../integrations/github/pull-requests.ts";
import type { CreateLinearTakePrIssueInput } from "../../integrations/linear/take-pr.ts";
import type { TakePrOptions, CompletePullRequest } from "./types.ts";

const MAX_LINEAR_ISSUE_TITLE_LENGTH = 255;

export function hasCompletePullRequestMetadata(
  pullRequest: PullRequest | null,
): pullRequest is CompletePullRequest {
  return Boolean(
    pullRequest?.url &&
    pullRequest.title &&
    pullRequest.repository &&
    pullRequest.headRefName &&
    pullRequest.baseRefName &&
    pullRequest.state,
  );
}

export function buildLinearIssueInput(
  request: {
    id: string;
    pullRequestUrl: string;
    repository: string;
    pullRequestTitle: string;
    pullRequestBody: string;
    headBranch: string;
    baseBranch: string;
  },
  teamId: string,
  projectSlug: string,
  slackMessageUrl: string,
): CreateLinearTakePrIssueInput {
  const title = `[take-pr] ${singleLine(request.pullRequestTitle)}`.slice(
    0,
    MAX_LINEAR_ISSUE_TITLE_LENGTH,
  );
  const pullRequestDescription = request.pullRequestBody.trim() || "No description provided.";
  const description = [
    "## Existing pull request",
    "",
    request.pullRequestUrl,
    "",
    "## PR Description",
    "",
    pullRequestDescription,
    "",
    "## Initial PR linkage action",
    "",
    "Add `Fixes <Linear issue ID>` to the existing pull request description.",
    "Follow the repository's pull request template and conventions when choosing where to add it, preserve existing content, and avoid duplicate issue references.",
    "Do not change the PR title or branch name.",
    "",
    "## Requested from",
    "",
    slackMessageUrl,
  ].join("\n");
  return {
    idempotencyKey: [request.pullRequestUrl.replace(/\/$/, ""), teamId].join(":"),
    teamId,
    projectSlug,
    title,
    description,
    pullRequestTitle: singleLine(request.pullRequestTitle),
    pullRequestUrl: request.pullRequestUrl,
  };
}

export function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function revalidatePullRequest(
  pullRequestUrl: string,
  options: TakePrOptions,
  logger: { error(error: unknown): void },
): Promise<{ pullRequest: CompletePullRequest } | { error: string }> {
  let pullRequest: PullRequest | null;
  try {
    pullRequest = await (options.findPullRequest ?? findPullRequestByUrl)(pullRequestUrl);
  } catch (error) {
    logger.error(error);
    pullRequest = null;
  }
  if (!hasCompletePullRequestMetadata(pullRequest)) {
    return { error: "Could not revalidate the GitHub pull request. No Linear issue was created." };
  }
  if (pullRequest.state.toUpperCase() !== "OPEN") {
    return { error: "The GitHub pull request is no longer open. No Linear issue was created." };
  }
  return { pullRequest };
}
