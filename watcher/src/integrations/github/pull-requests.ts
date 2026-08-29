import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  GITHUB_REACTIONS,
  type GitHubReaction,
  type PullRequest,
  type PullRequestCheck,
} from "../../domain/github.ts";
import type { WatcherEvent } from "../../domain/watcher-event.ts";

const execFileDefault = promisify(execFileCallback);
const GH_PR_FIELDS =
  "url,number,title,body,state,isDraft,reviewDecision,mergeable,headRefName,headRefOid,baseRefName,labels,reactionGroups";
const GH_PR_FIELDS_WITH_CHECKS = `${GH_PR_FIELDS},statusCheckRollup`;

interface FindPullRequestOptions {
  execFile?: typeof execFileDefault;
  includeLatestReviewComment?: boolean;
  symphonyGitHubLogins?: string[];
}

interface GhPullRequest {
  url?: string;
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  mergeable?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  labels?: Array<{ name?: string }>;
  reactionGroups?: Array<{ content?: string; users?: { totalCount?: number } }>;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    workflowName?: string;
    status?: string;
    state?: string;
    conclusion?: string;
    detailsUrl?: string;
    targetUrl?: string;
  }>;
}

interface GhReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        author?: { login?: string };
        reviewThreads?: {
          nodes?: Array<{
            isResolved?: boolean;
            isOutdated?: boolean;
            comments?: {
              nodes?: Array<{ author?: { login?: string }; createdAt?: string }>;
            };
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
      author { login }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(last: 100) { nodes { author { login } createdAt } }
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
  try {
    const parsed = await loadPullRequest(execFile, selector, cwd);
    if (!parsed.url) return null;
    const pullRequest = toPullRequest(parsed);
    if (!options.includeLatestReviewComment) return pullRequest;
    const latestReviewCommentAt = await fetchLatestReviewCommentAt(
      execFile,
      pullRequest,
      options.symphonyGitHubLogins ?? [],
    ).catch(() => null);
    return { ...pullRequest, latestReviewCommentAt };
  } catch {
    return null;
  }
}

async function loadPullRequest(
  execFile: typeof execFileDefault,
  selector: string | undefined,
  cwd: string | undefined,
): Promise<GhPullRequest> {
  const view = async (fields: string) => {
    const args = ["pr", "view", ...(selector ? [selector] : []), "--json", fields];
    const { stdout } = await execFile("gh", args, {
      ...(cwd ? { cwd } : {}),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout) as GhPullRequest;
  };

  try {
    return await view(GH_PR_FIELDS_WITH_CHECKS);
  } catch {
    return view(GH_PR_FIELDS);
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
    mergeable: parsed.mergeable ?? null,
    headRefName: parsed.headRefName ?? null,
    headRefOid: parsed.headRefOid ?? null,
    baseRefName: parsed.baseRefName ?? null,
    repository: repositoryFromPullRequestUrl(parsed.url!),
    labels: parsed.labels?.flatMap(({ name }) => (name ? [name] : [])) ?? [],
    reactions:
      parsed.reactionGroups?.flatMap(({ content, users }) =>
        content && (users?.totalCount ?? 0) > 0 && isGitHubReaction(content) ? [content] : [],
      ) ?? [],
    ...(parsed.statusCheckRollup
      ? { checks: parsed.statusCheckRollup.flatMap(toPullRequestCheck) }
      : {}),
  };
}

function toPullRequestCheck(
  check: NonNullable<GhPullRequest["statusCheckRollup"]>[number],
): PullRequestCheck[] {
  const name = check.name ?? check.context;
  if (!name) return [];
  const legacyStatus = check.state?.toUpperCase();
  const legacyPending = legacyStatus === "PENDING" || legacyStatus === "EXPECTED";
  const status = check.status ?? (legacyPending ? "IN_PROGRESS" : legacyStatus && "COMPLETED");
  const conclusion = check.conclusion ?? (legacyPending ? null : legacyStatus);
  return [
    {
      name,
      workflowName: check.workflowName ?? null,
      status: status || null,
      conclusion: conclusion ?? null,
      detailsUrl: check.detailsUrl ?? check.targetUrl ?? null,
    },
  ];
}

function isGitHubReaction(value: string): value is GitHubReaction {
  return GITHUB_REACTIONS.some((reaction) => reaction === value);
}

async function fetchLatestReviewCommentAt(
  execFile: typeof execFileDefault,
  pullRequest: PullRequest,
  symphonyGitHubLogins: string[],
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
  const responsePullRequest = response.data?.repository?.pullRequest;
  const ignoredAuthors = new Set(
    [responsePullRequest?.author?.login, ...symphonyGitHubLogins]
      .filter((login): login is string => Boolean(login))
      .map((login) => login.toLowerCase()),
  );
  return (
    responsePullRequest?.reviewThreads?.nodes
      ?.filter(({ isResolved, isOutdated }) => !isResolved && !isOutdated)
      .flatMap(({ comments }) => comments?.nodes ?? [])
      .flatMap(({ author, createdAt }) =>
        createdAt && (!author?.login || !ignoredAuthors.has(author.login.toLowerCase()))
          ? [createdAt]
          : [],
      )
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
