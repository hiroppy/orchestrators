const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;

class TransientLinearError extends Error {}

import { isTerminalLinearStateType } from "../domain/linear.ts";
import type { PullRequest, RelatedIssue } from "../domain/types.ts";
import {
  ISSUE_STATE_QUERY,
  TAKE_PR_ATTACHMENT_CREATE_MUTATION,
  TAKE_PR_ISSUE_CREATE_MUTATION,
  TAKE_PR_ISSUE_QUERY,
  TAKE_PR_TARGET_QUERY,
} from "./linear-queries.ts";
import { LINEAR_ENDPOINT, linearRequest } from "./linear-client.ts";
import { stableLinearUuid } from "./linear-id.ts";

export { fetchLinearWorkflowStates, updateLinearIssueStatus } from "./linear-status.ts";
export { createLinearWorkpadReply } from "./linear-workpad.ts";

interface LinearRequestOptions {
  apiKey?: string;
  timeoutMs?: number;
}

export interface CreateLinearTakePrIssueInput {
  idempotencyKey: string;
  teamId: string;
  projectSlug: string;
  title: string;
  description: string;
  pullRequestTitle: string;
  pullRequestUrl: string;
}

export interface CreatedLinearIssue {
  identifier: string;
  url: string;
}

export class AmbiguousLinearTakePrIssueError extends Error {}

interface FetchLinearOptions extends LinearRequestOptions {
  includeCreator?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  throwOnTransientFailure?: boolean;
}

interface LinearIssueState {
  identifier: string;
  title: string | null;
  state: string | null;
  stateType: string | null;
  url: string | null;
  creatorName?: string | null;
  creatorEmail?: string | null;
  pullRequest?: PullRequest;
  relatedIssues?: RelatedIssue[];
}

interface LinearIssueRelation {
  type?: string | null;
  relatedIssue?: {
    identifier?: string | null;
    title?: string | null;
    url?: string | null;
    state?: { type?: string | null } | null;
  } | null;
}

interface LinearIssueResponse {
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  data?: {
    issue?: {
      identifier: string;
      title?: string | null;
      creator?: { name?: string | null; email?: string | null } | null;
      state?: { name?: string | null; type?: string | null } | null;
      attachments?: { nodes?: Array<{ url?: string | null }> | null } | null;
      relations?: { nodes?: LinearIssueRelation[] | null } | null;
      url?: string | null;
    } | null;
  };
}

export async function createLinearTakePrIssue(
  input: CreateLinearTakePrIssueInput,
  { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }: LinearRequestOptions,
): Promise<CreatedLinearIssue> {
  if (!apiKey) throw new Error("Linear API key is not configured.");
  const projectSlugId = linearProjectSlugId(input.projectSlug);
  const issueId = stableLinearUuid(`take-pr:${input.idempotencyKey}:${projectSlugId}`);

  const target = await linearRequest<{
    team?: {
      id: string;
      states?: { nodes?: Array<{ id: string; name: string }> };
    };
    projects?: {
      nodes?: Array<{
        id: string;
        name: string;
        slugId: string;
        teams?: { nodes?: Array<{ id: string }> };
      }>;
    };
  }>(apiKey, TAKE_PR_TARGET_QUERY, { teamId: input.teamId, projectSlug: projectSlugId }, timeoutMs);
  const team = target.team;
  if (!team) throw new Error(`Linear team not found: ${input.teamId}`);

  const project = target.projects?.nodes?.find(({ slugId }) => slugId === projectSlugId);
  if (!project) throw new Error(`Linear project not found: ${input.projectSlug}`);
  if (!project.teams?.nodes?.some(({ id }) => id === team.id)) {
    throw new Error(
      `Linear project ${input.projectSlug} is not associated with team ${input.teamId}.`,
    );
  }

  const inProgress = team.states?.nodes?.find(
    ({ name }) => name.trim().toLowerCase() === "in progress",
  );
  if (!inProgress) throw new Error(`Linear team has no In Progress state: ${input.teamId}`);

  let issue = await findLinearTakePrIssue(apiKey, issueId, timeoutMs);

  if (!issue) {
    try {
      const created = await linearRequest<{
        issueCreate?: {
          success?: boolean;
          issue?: LinearTakePrIssue;
        };
      }>(
        apiKey,
        TAKE_PR_ISSUE_CREATE_MUTATION,
        {
          issueId,
          teamId: team.id,
          projectId: project.id,
          stateId: inProgress.id,
          title: input.title,
          description: input.description,
        },
        timeoutMs,
      );
      if (!created.issueCreate?.success) {
        throw new Error("Linear rejected take-pr issue creation in In Progress.");
      }
      issue = {
        ...requireNewLinearTakePrIssue(created.issueCreate.issue),
        attachmentUrls: [],
      };
    } catch (error) {
      try {
        issue = await findLinearTakePrIssue(apiKey, issueId, timeoutMs);
      } catch (reconciliationError) {
        throw new AmbiguousLinearTakePrIssueError(
          `Linear issue creation could not be reconciled: ${errorMessage(reconciliationError)}`,
          { cause: error },
        );
      }
      if (!issue) throw error;
    }
  }

  if (!issue.attachmentUrls.includes(input.pullRequestUrl)) {
    await createLinearTakePrAttachment(apiKey, issueId, input, timeoutMs);
  }
  return { identifier: issue.identifier, url: issue.url };
}

function linearProjectSlugId(projectSlug: string): string {
  return projectSlug.match(/(?:^|-)([0-9a-f]{12})$/i)?.[1] ?? projectSlug;
}

async function createLinearTakePrAttachment(
  apiKey: string,
  issueId: string,
  input: Pick<CreateLinearTakePrIssueInput, "pullRequestTitle" | "pullRequestUrl">,
  timeoutMs: number,
): Promise<void> {
  const data = await linearRequest<{ attachmentCreate?: { success?: boolean } }>(
    apiKey,
    TAKE_PR_ATTACHMENT_CREATE_MUTATION,
    {
      issueId,
      title: input.pullRequestTitle,
      url: input.pullRequestUrl,
    },
    timeoutMs,
  );
  if (!data.attachmentCreate?.success) {
    throw new Error("Linear rejected take-pr pull request attachment creation.");
  }
}

interface LinearTakePrIssue {
  identifier?: string;
  url?: string;
  attachments?: { nodes?: Array<{ url?: string | null }> | null } | null;
  state?: { name?: string };
}

interface ReconciledLinearTakePrIssue extends CreatedLinearIssue {
  attachmentUrls: string[];
}

async function findLinearTakePrIssue(
  apiKey: string,
  issueId: string,
  timeoutMs: number,
): Promise<ReconciledLinearTakePrIssue | null> {
  try {
    const data = await linearRequest<{ issue?: LinearTakePrIssue | null }>(
      apiKey,
      TAKE_PR_ISSUE_QUERY,
      { issueId },
      timeoutMs,
    );
    if (!data.issue) return null;
    return {
      ...requireReconciledLinearTakePrIssue(data.issue),
      attachmentUrls: data.issue.attachments?.nodes?.flatMap(({ url }) => (url ? [url] : [])) ?? [],
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Linear GraphQL error: Entity not found: Issue"
    ) {
      return null;
    }
    throw error;
  }
}

function requireNewLinearTakePrIssue(issue: LinearTakePrIssue | undefined): CreatedLinearIssue {
  if (
    !issue?.identifier ||
    !issue.url ||
    issue.state?.name?.trim().toLowerCase() !== "in progress"
  ) {
    throw new Error("Linear rejected take-pr issue creation in In Progress.");
  }
  return { identifier: issue.identifier, url: issue.url };
}

function requireReconciledLinearTakePrIssue(
  issue: LinearTakePrIssue | undefined,
): CreatedLinearIssue {
  if (!issue?.identifier || !issue.url) {
    throw new Error("Linear take-pr issue reconciliation returned incomplete metadata.");
  }
  return { identifier: issue.identifier, url: issue.url };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export async function fetchLinearIssueState(
  issueIdentifier?: string,
  options: FetchLinearOptions = {},
): Promise<LinearIssueState | null> {
  const apiKey = options.apiKey;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const includeCreator = options.includeCreator ?? true;
  const throwOnTransientFailure = options.throwOnTransientFailure ?? false;

  if (!apiKey || !issueIdentifier) return null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(LINEAR_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: ISSUE_STATE_QUERY,
          variables: { id: issueIdentifier, includeCreator },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        if (shouldRetryResponse(response.status) && attempt < maxAttempts) {
          await sleep(retryDelayMs);
          continue;
        }

        if (shouldRetryResponse(response.status) && throwOnTransientFailure) {
          throw new TransientLinearError(`Linear request failed with status ${response.status}.`);
        }

        return null;
      }

      const body = (await response.json()) as LinearIssueResponse;
      const rateLimited = body.errors?.some((error) => error.extensions?.code === "RATELIMITED");
      if (rateLimited) {
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs);
          continue;
        }
        if (throwOnTransientFailure) {
          throw new TransientLinearError("Linear GraphQL request was rate limited.");
        }
        return null;
      }
      const issue = body?.data?.issue;

      if (!issue) return null;

      const pullRequest = findPullRequestAttachment(issue.attachments?.nodes);
      const relatedIssues = findNextRelatedIssues(issue.relations?.nodes);

      return {
        identifier: issue.identifier,
        title: issue.title ?? null,
        state: issue.state?.name ?? null,
        stateType: issue.state?.type ?? null,
        url: issue.url ?? null,
        ...(includeCreator && issue.creator?.name ? { creatorName: issue.creator.name } : {}),
        ...(includeCreator && issue.creator?.email ? { creatorEmail: issue.creator.email } : {}),
        ...(pullRequest ? { pullRequest } : {}),
        ...(relatedIssues.length > 0 ? { relatedIssues } : {}),
      };
    } catch (error) {
      if (error instanceof TransientLinearError) throw error;
      if (attempt >= maxAttempts) {
        if (throwOnTransientFailure) {
          throw new TransientLinearError("Linear request failed transiently.");
        }
        return null;
      }
      await sleep(retryDelayMs);
    }
  }

  return null;
}

function findNextRelatedIssues(relations?: LinearIssueRelation[] | null): RelatedIssue[] {
  if (!Array.isArray(relations)) return [];

  return relations.flatMap(({ type, relatedIssue }) => {
    if (
      type?.trim().toLowerCase() !== "blocks" ||
      !relatedIssue?.identifier ||
      isTerminalLinearStateType(relatedIssue.state?.type)
    ) {
      return [];
    }

    return [
      {
        identifier: relatedIssue.identifier,
        title: relatedIssue.title ?? null,
        url: relatedIssue.url ?? null,
      },
    ];
  });
}

function findPullRequestAttachment(
  attachments?: Array<{ url?: string | null }> | null,
): PullRequest | null {
  if (!Array.isArray(attachments)) return null;

  for (const attachment of attachments) {
    const url = attachment?.url;
    if (!url) continue;

    const match = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:$|[/?#])/i);

    if (match) {
      return {
        url,
        number: Number(match[1]),
      };
    }
  }

  return null;
}

function shouldRetryResponse(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
