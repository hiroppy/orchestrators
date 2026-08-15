import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { PullRequest, WatcherEvent } from "../domain/types.ts";

const execFileDefault = promisify(execFileCallback);
const GH_PR_FIELDS =
  "url,number,title,body,state,isDraft,reviewDecision,headRefName,headRefOid,baseRefName,labels";

interface FindPullRequestOptions {
  execFile?: typeof execFileDefault;
  includeLatestReviewComment?: boolean;
}

interface GhPullRequest {
  url?: string;
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  labels?: Array<{ name?: string }>;
}

interface GhReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            isResolved?: boolean;
            isOutdated?: boolean;
            comments?: { nodes?: Array<{ createdAt?: string }> };
          }>;
        };
      };
    };
  };
}

const LATEST_UNRESOLVED_REVIEW_COMMENT_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(last: 1) { nodes { createdAt } }
        }
      }
    }
  }
}`;

export async function requireGitHubCli(
  execFile: typeof execFileDefault = execFileDefault,
): Promise<void> {
  try {
    await execFile("gh", ["auth", "status"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(
      "GitHub CLI is required and must be authenticated. Run `gh auth login` before starting the watcher.",
    );
  }
}

export async function findPullRequest(
  event: WatcherEvent,
  options: FindPullRequestOptions = {},
): Promise<PullRequest | null> {
  if (!event.workspacePath || event.state?.toLowerCase() === "todo") return null;
  const pullRequest = await viewPullRequest(undefined, options, event.workspacePath);
  return pullRequest &&
    matchesIssueIdentifier(pullRequest.headRefName ?? undefined, event.issueIdentifier)
    ? pullRequest
    : null;
}

export async function findPullRequestByUrl(
  url: string,
  options: FindPullRequestOptions = {},
): Promise<PullRequest | null> {
  return viewPullRequest(url, options);
}

async function viewPullRequest(
  selector: string | undefined,
  options: FindPullRequestOptions,
  cwd?: string,
): Promise<PullRequest | null> {
  const execFile = options.execFile ?? execFileDefault;
  const args = ["pr", "view", ...(selector ? [selector] : []), "--json", GH_PR_FIELDS];

  try {
    const { stdout } = await execFile("gh", args, {
      ...(cwd ? { cwd } : {}),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as GhPullRequest;
    if (!parsed.url) return null;
    const pullRequest = toPullRequest(parsed);
    if (!options.includeLatestReviewComment) return pullRequest;
    const latestReviewCommentAt = await fetchLatestReviewCommentAt(execFile, pullRequest).catch(
      () => null,
    );
    return { ...pullRequest, latestReviewCommentAt };
  } catch {
    return null;
  }
}

function toPullRequest(parsed: GhPullRequest): PullRequest {
  return {
    url: parsed.url!,
    number: parsed.number ?? null,
    title: parsed.title ?? null,
    body: parsed.body ?? null,
    state: parsed.state ?? null,
    isDraft: parsed.isDraft ?? null,
    reviewDecision: parsed.reviewDecision ?? null,
    headRefName: parsed.headRefName ?? null,
    headRefOid: parsed.headRefOid ?? null,
    baseRefName: parsed.baseRefName ?? null,
    repository: repositoryFromPullRequestUrl(parsed.url!),
    labels: parsed.labels?.flatMap(({ name }) => (name ? [name] : [])) ?? [],
  };
}

async function fetchLatestReviewCommentAt(
  execFile: typeof execFileDefault,
  pullRequest: PullRequest,
): Promise<string | null> {
  if (!pullRequest.repository || !pullRequest.number) return null;
  const [owner, repo] = pullRequest.repository.split("/");
  if (!owner || !repo) return null;
  const { stdout } = await execFile(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${repo}`,
      "-F",
      `number=${pullRequest.number}`,
      "-f",
      `query=${LATEST_UNRESOLVED_REVIEW_COMMENT_QUERY}`,
    ],
    {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const response = JSON.parse(stdout) as GhReviewThreadsResponse;
  return (
    response.data?.repository?.pullRequest?.reviewThreads?.nodes
      ?.filter(({ isResolved, isOutdated }) => !isResolved && !isOutdated)
      .flatMap(({ comments }) => comments?.nodes ?? [])
      .flatMap(({ createdAt }) => (createdAt ? [createdAt] : []))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  );
}

function repositoryFromPullRequestUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function matchesIssueIdentifier(headRefName?: string, issueIdentifier?: string): boolean {
  if (!headRefName || !issueIdentifier) return false;
  const issueParts = issueIdentifier.match(/^([a-z]+)[^a-z0-9]*(\d+)$/i);
  if (!issueParts) return false;
  const [, prefix, number] = issueParts;
  const pattern = new RegExp(`(?:^|[^a-z0-9])${prefix}[^a-z0-9]*${number}(?=$|[^a-z0-9])`, "i");
  return pattern.test(headRefName);
}
