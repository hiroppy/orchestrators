import type { PullRequestContext } from "orchestrator-config";

import type { PullRequest } from "./github.ts";

export function toPullRequestContext(pullRequest: PullRequest): PullRequestContext {
  return {
    url: pullRequest.url,
    ...(pullRequest.number !== undefined ? { number: pullRequest.number } : {}),
    ...(pullRequest.title !== undefined ? { title: pullRequest.title } : {}),
    ...(pullRequest.state !== undefined ? { state: pullRequest.state } : {}),
    ...(pullRequest.isDraft !== undefined ? { isDraft: pullRequest.isDraft } : {}),
    ...(pullRequest.reviewDecision !== undefined
      ? { reviewDecision: pullRequest.reviewDecision }
      : {}),
    ...(pullRequest.headRefName !== undefined ? { headRefName: pullRequest.headRefName } : {}),
    ...(pullRequest.headRefOid !== undefined ? { headRefOid: pullRequest.headRefOid } : {}),
    ...(pullRequest.labels !== undefined ? { labels: pullRequest.labels } : {}),
  };
}
