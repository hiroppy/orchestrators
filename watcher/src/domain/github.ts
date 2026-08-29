import type { PullRequestCheckContext, PullRequestContext } from "orchestrator-config";

export const GITHUB_REACTIONS = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
] as const;

export type GitHubReaction = (typeof GITHUB_REACTIONS)[number];

export type PullRequestCheck = PullRequestCheckContext;

export interface PullRequest extends PullRequestContext {
  body?: string | null;
  repository?: string | null;
  reactions?: GitHubReaction[];
  latestReviewCommentAt?: string | null;
}
