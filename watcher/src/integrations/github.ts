import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

import type { PullRequest, WatcherEvent } from "../domain/types.ts";

const execFileDefault = promisify(execFileCallback);
const GH_PR_FIELDS =
  "url,number,title,body,state,isDraft,reviewDecision,headRefName,headRefOid,baseRefName";
const GH_PR_FIELDS_WITH_REACTIONS = `${GH_PR_FIELDS},reactionGroups`;
const GITHUB_REACTION_BY_EMOJI: Record<string, string> = {
  "👍": "THUMBS_UP",
  "👎": "THUMBS_DOWN",
  "😄": "LAUGH",
  "🎉": "HOORAY",
  "😕": "CONFUSED",
  "❤️": "HEART",
  "❤": "HEART",
  "🚀": "ROCKET",
  "👀": "EYES",
};

interface FindPullRequestOptions {
  execFile?: typeof execFileDefault;
  reaction?: string;
}

interface LinkPullRequestOptions {
  execFile?: typeof execFileDefault;
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
  reactionGroups?: Array<{
    content?: string;
    users?: { totalCount?: number };
  }>;
}

export async function requireGitHubCli(
  execFile: typeof execFileDefault = execFileDefault,
): Promise<void> {
  try {
    await execFile("gh", ["auth", "status"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
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
  if (!event.workspacePath) return null;
  if (event.state?.toLowerCase() === "todo") return null;

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

export async function linkPullRequestToLinearIssue(
  url: string,
  issueIdentifier: string,
  options: LinkPullRequestOptions = {},
): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid GitHub pull request URL: ${url}`);
  }
  const path = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !path
  ) {
    throw new Error(`Invalid GitHub pull request URL: ${url}`);
  }
  const [, owner, repositoryName, pullRequestNumber] = path;
  const repository = `${owner}/${repositoryName}`;

  const link = `Fixes ${issueIdentifier}`;
  const execFile = options.execFile ?? execFileDefault;
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        `repos/${repository}/pulls/${pullRequestNumber}`,
        "--jq",
        '.body // ""',
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    if (stdout.split("\n").some((line) => line.trim().toLowerCase() === link.toLowerCase())) {
      return;
    }

    const currentBody = stdout.trimEnd();
    const updatedBody = currentBody ? `${currentBody}\n\n${link}` : link;
    await execFile(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "PATCH",
        `repos/${repository}/pulls/${pullRequestNumber}`,
        "-f",
        `body=${updatedBody}`,
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new Error(`Could not link GitHub pull request to Linear issue ${issueIdentifier}.`);
  }
}

async function viewPullRequest(
  selector: string | undefined,
  options: FindPullRequestOptions,
  cwd?: string,
): Promise<PullRequest | null> {
  const execFile = options.execFile ?? execFileDefault;
  const fields = options.reaction ? GH_PR_FIELDS_WITH_REACTIONS : GH_PR_FIELDS;
  const args = ["pr", "view", ...(selector ? [selector] : []), "--json", fields];

  try {
    const { stdout } = await execFile("gh", args, {
      ...(cwd ? { cwd } : {}),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as GhPullRequest;
    return parsed.url ? toPullRequest(parsed, options.reaction) : null;
  } catch {
    return null;
  }
}

function toPullRequest(parsed: GhPullRequest, reaction?: string): PullRequest {
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
    ...(reaction
      ? {
          hasConfiguredReaction: Boolean(
            parsed.reactionGroups?.some(
              ({ content, users }) =>
                content === githubReactionContent(reaction) && (users?.totalCount ?? 0) > 0,
            ),
          ),
        }
      : {}),
  };
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

function githubReactionContent(reaction: string): string {
  const normalized = reaction.trim();
  return GITHUB_REACTION_BY_EMOJI[normalized] ?? normalized.toUpperCase();
}

function matchesIssueIdentifier(headRefName?: string, issueIdentifier?: string): boolean {
  if (!headRefName || !issueIdentifier) return false;

  const issueParts = issueIdentifier.match(/^([a-z]+)[^a-z0-9]*(\d+)$/i);
  if (!issueParts) return false;

  const [, prefix, number] = issueParts;
  const pattern = new RegExp(`(?:^|[^a-z0-9])${prefix}[^a-z0-9]*${number}(?=$|[^a-z0-9])`, "i");
  return pattern.test(headRefName);
}
