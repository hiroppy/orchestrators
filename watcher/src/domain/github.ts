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

export interface PullRequestCheck {
  name: string;
  workflowName?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
}

export interface PullRequest {
  url: string;
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
  repository?: string | null;
  labels?: string[];
  reactions?: GitHubReaction[];
  latestReviewCommentAt?: string | null;
  checks?: PullRequestCheck[];
}
