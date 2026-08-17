import {
  TAKE_PR_ATTACHMENT_CREATE_MUTATION,
  TAKE_PR_ISSUE_CREATE_MUTATION,
  TAKE_PR_ISSUE_QUERY,
  TAKE_PR_TARGET_QUERY,
} from "./queries.ts";
import { linearRequest } from "./client.ts";
import { stableLinearUuid } from "./id.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

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

  const todo = team.states?.nodes?.find(({ name }) => name.trim().toLowerCase() === "todo");
  if (!todo) throw new Error(`Linear team has no Todo state: ${input.teamId}`);

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
          stateId: todo.id,
          title: input.title,
          description: input.description,
        },
        timeoutMs,
      );
      if (!created.issueCreate?.success) {
        throw new Error("Linear rejected take-pr issue creation in Todo.");
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
  if (!issue?.identifier || !issue.url || issue.state?.name?.trim().toLowerCase() !== "todo") {
    throw new Error("Linear rejected take-pr issue creation in Todo.");
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
