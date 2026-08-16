import type { PullRequest } from "../../domain/github.ts";
import type { RelatedIssue } from "../../domain/linear.ts";
import { isLinearRateLimitError, LINEAR_ENDPOINT, linearRequest } from "./client.ts";
import { ISSUE_STATE_QUERY } from "./queries.ts";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const LINEAR_ISSUE_STATE_BATCH_SIZE = 50;

class TransientLinearError extends Error {}

interface LinearRequestOptions {
  apiKey?: string;
  timeoutMs?: number;
}

interface FetchLinearOptions extends LinearRequestOptions {
  includeCreator?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  throwOnTransientFailure?: boolean;
}

interface LinearIssueState {
  id?: string;
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

export interface LinearIssueStateSummary {
  identifier: string;
  state: string | null;
  stateType: string | null;
}

interface LinearIssueRelation {
  type?: string | null;
  relatedIssue?: {
    identifier?: string | null;
    title?: string | null;
    url?: string | null;
    state?: { name?: string | null; type?: string | null } | null;
  } | null;
}

interface LinearIssueResponse {
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  data?: {
    issue?: {
      id?: string;
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
      const relatedIssues = findBlockedRelatedIssues(issue.relations?.nodes);

      return {
        ...(issue.id ? { id: issue.id } : {}),
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

export async function fetchLinearIssueStateSummaries(
  issueIdentifiers: readonly string[],
  options: LinearRequestOptions = {},
): Promise<Map<string, LinearIssueStateSummary>> {
  const summaries = new Map<string, LinearIssueStateSummary>();
  if (!options.apiKey) return summaries;

  const identifiers = [...new Set(issueIdentifiers.filter(Boolean))];
  for (let offset = 0; offset < identifiers.length; offset += LINEAR_ISSUE_STATE_BATCH_SIZE) {
    const batch = identifiers.slice(offset, offset + LINEAR_ISSUE_STATE_BATCH_SIZE);
    const declarations = batch.map((_, index) => `$id${index}: String!`).join(", ");
    const fields = batch
      .map((_, index) => `issue${index}: issue(id: $id${index}) { identifier state { name type } }`)
      .join("\n");
    const variables = Object.fromEntries(
      batch.map((identifier, index) => [`id${index}`, identifier]),
    );

    try {
      const data = await linearRequest<
        Record<
          string,
          { identifier?: string; state?: { name?: string | null; type?: string | null } } | null
        >
      >(
        options.apiKey,
        `query OrchestratorWatcherIssueStateBatch(${declarations}) { ${fields} }`,
        variables,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      for (const [index, requestedIdentifier] of batch.entries()) {
        const issue = data[`issue${index}`];
        if (!issue?.identifier) continue;
        summaries.set(requestedIdentifier, {
          identifier: issue.identifier,
          state: issue.state?.name ?? null,
          stateType: issue.state?.type ?? null,
        });
      }
    } catch (error) {
      if (isLinearRateLimitError(error)) throw error;
      // Periodic reconciliation is best-effort; a later cycle will retry the batch.
    }
  }

  return summaries;
}

function findBlockedRelatedIssues(relations?: LinearIssueRelation[] | null): RelatedIssue[] {
  if (!Array.isArray(relations)) return [];

  return relations.flatMap(({ type, relatedIssue }) => {
    if (type?.trim().toLowerCase() !== "blocks" || !relatedIssue?.identifier) {
      return [];
    }

    return [
      {
        identifier: relatedIssue.identifier,
        title: relatedIssue.title ?? null,
        url: relatedIssue.url ?? null,
        state: relatedIssue.state?.name ?? null,
        stateType: relatedIssue.state?.type ?? null,
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
