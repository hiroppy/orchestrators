import { createHash } from "node:crypto";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const WORKFLOW_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

export class TransientLinearError extends Error {}

import { isTerminalLinearStateType } from "../domain/linear.ts";
import type { PullRequest, RelatedIssue } from "../domain/types.ts";

const ISSUE_STATE_QUERY = `
  query OrchestratorWatcherIssueState($id: String!, $includeCreator: Boolean!) {
    issue(id: $id) {
      identifier
      title
      creator @include(if: $includeCreator) {
        name
        email
      }
      state {
        name
        type
      }
      attachments {
        nodes {
          url
        }
      }
      relations {
        nodes {
          type
          relatedIssue {
            identifier
            title
            url
            state {
              type
            }
          }
        }
      }
      url
    }
  }
`;

const ISSUE_STATUS_TARGET_QUERY = `
  query OrchestratorWatcherIssueStatusTarget($id: String!) {
    issue(id: $id) {
      id
      team {
        states {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

const ISSUE_STATUS_UPDATE_MUTATION = `
  mutation OrchestratorWatcherIssueStatusUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        state {
          name
        }
      }
    }
  }
`;

const ISSUE_WORKPAD_QUERY = `
  query OrchestratorWatcherIssueWorkpad($id: String!, $after: String) {
    issue(id: $id) {
      id
      comments(first: 250, after: $after) {
        nodes {
          id
          body
          createdAt
          resolvedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const COMMENT_REPLY_CREATE_MUTATION = `
  mutation OrchestratorWatcherCommentReplyCreate(
    $id: String!
    $issueId: String!
    $parentId: String!
    $body: String!
  ) {
    commentCreate(input: { id: $id, issueId: $issueId, parentId: $parentId, body: $body }) {
      success
    }
  }
`;

const FILE_UPLOAD_MUTATION = `
  mutation OrchestratorWatcherFileUpload(
    $filename: String!
    $contentType: String!
    $size: Int!
  ) {
    fileUpload(filename: $filename, contentType: $contentType, size: $size) {
      success
      uploadFile {
        uploadUrl
        assetUrl
        headers {
          key
          value
        }
      }
    }
  }
`;

const COMMENT_BY_ID_QUERY = `
  query OrchestratorWatcherCommentById($id: ID!) {
    comments(first: 1, filter: { id: { eq: $id } }) {
      nodes {
        id
      }
    }
  }
`;

const TEAM_WORKFLOW_STATES_QUERY = `
  query OrchestratorWatcherTeamWorkflowStates($id: String!) {
    team(id: $id) {
      states {
        nodes {
          name
          type
          position
        }
      }
    }
  }
`;

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

interface CreateLinearWorkpadReplyOptions extends FetchLinearOptions {
  idempotencyKey: string;
  images?: LinearReplyImage[];
}

interface LinearReplyImage {
  filename: string;
  contentType: string;
  loadData(): Promise<ArrayBuffer>;
}

interface WorkpadRequestOptions {
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
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

export async function fetchLinearWorkflowStates(
  teamId: string,
  { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }: LinearRequestOptions,
): Promise<string[]> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const data = await linearRequest<{
    team?: {
      states?: {
        nodes?: Array<{ name: string; type: string; position: number }>;
      };
    };
  }>(apiKey, TEAM_WORKFLOW_STATES_QUERY, { id: teamId }, timeoutMs);
  if (!data.team) throw new Error(`Linear team not found: ${teamId}`);

  const states = [...(data.team.states?.nodes ?? [])]
    .sort(
      (left, right) =>
        workflowStateTypeOrder(left.type) - workflowStateTypeOrder(right.type) ||
        left.position - right.position,
    )
    .map(({ name }) => name);
  if (states.length === 0) {
    throw new Error(`Linear team has no workflow states: ${teamId}`);
  }
  return states;
}

function workflowStateTypeOrder(type: string): number {
  const index = WORKFLOW_STATE_TYPES.indexOf(type);
  return index === -1 ? WORKFLOW_STATE_TYPES.length : index;
}

export async function updateLinearIssueStatus(
  issueIdentifier: string,
  statusName: string,
  { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }: LinearRequestOptions,
): Promise<void> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const target = await linearRequest<{
    issue?: {
      id: string;
      team?: {
        states?: { nodes?: Array<{ id: string; name: string }> };
      };
    };
  }>(apiKey, ISSUE_STATUS_TARGET_QUERY, { id: issueIdentifier }, timeoutMs);
  const issue = target.issue;
  if (!issue) throw new Error(`Linear issue not found: ${issueIdentifier}`);

  const normalizedStatus = statusName.trim().toLowerCase();
  const state = issue.team?.states?.nodes?.find(
    ({ name }) => name.trim().toLowerCase() === normalizedStatus,
  );
  if (!state) {
    throw new Error(`Linear status not found for ${issueIdentifier}: ${statusName}`);
  }

  const updated = await linearRequest<{
    issueUpdate?: { success?: boolean };
  }>(
    apiKey,
    ISSUE_STATUS_UPDATE_MUTATION,
    {
      id: issue.id,
      stateId: state.id,
    },
    timeoutMs,
  );
  if (!updated.issueUpdate?.success) {
    throw new Error(`Linear rejected status update for ${issueIdentifier}.`);
  }
}

export async function createLinearWorkpadReply(
  issueIdentifier: string,
  body: string,
  {
    apiKey,
    idempotencyKey,
    images,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  }: CreateLinearWorkpadReplyOptions,
): Promise<boolean> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const requestOptions = { apiKey, timeoutMs, maxAttempts, retryDelayMs };
  const workpad = await findLinearWorkpad(issueIdentifier, requestOptions);
  if (!workpad) return false;

  const commentId = stableUuid(idempotencyKey);
  const replyImages = images ?? [];
  if (replyImages.length > 0 && (await linearCommentExists(commentId, requestOptions))) return true;

  const imageMarkdown = await uploadReplyImages(replyImages, requestOptions);
  const replyBody = [body, ...imageMarkdown].filter(Boolean).join("\n\n");
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await linearRequest<{
        commentCreate?: { success?: boolean };
      }>(
        apiKey,
        COMMENT_REPLY_CREATE_MUTATION,
        {
          id: commentId,
          issueId: workpad.issueId,
          parentId: workpad.commentId,
          body: replyBody,
        },
        timeoutMs,
      );
      if (!result.commentCreate?.success) {
        throw new Error(`Linear rejected Workpad reply for ${issueIdentifier}.`);
      }
      return true;
    } catch (error) {
      try {
        if (await linearCommentExists(commentId, requestOptions)) return true;
      } catch {
        // Reconciliation is best-effort; retry based on the original mutation error.
      }
      if (attempt >= maxAttempts || !isTransientLinearError(error)) throw error;
      await sleep(retryDelayMs);
    }
  }
}

async function uploadReplyImages(
  images: LinearReplyImage[],
  options: WorkpadRequestOptions,
): Promise<string[]> {
  const markdown: string[] = [];
  for (const image of images) {
    markdown.push(await uploadReplyImage(image, options));
  }
  return markdown;
}

async function uploadReplyImage(
  image: LinearReplyImage,
  options: WorkpadRequestOptions,
): Promise<string> {
  const data = await image.loadData();
  let lastTransferError: Error | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const upload = await requestLinearFileUpload(image, data.byteLength, options);
    const headers = new Headers({
      "Cache-Control": "public, max-age=31536000",
      "Content-Type": image.contentType,
    });
    for (const header of upload.headers) headers.set(header.key, header.value);

    try {
      const response = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers,
        body: data,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) {
        return `![${escapeMarkdownLabel(image.filename)}](${upload.assetUrl})`;
      }

      lastTransferError = new Error(`Linear file upload returned HTTP ${response.status}.`);
      if (!shouldRetryResponse(response.status)) throw lastTransferError;
    } catch (error) {
      if (!isTransientLinearError(error)) throw error;
      lastTransferError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt >= options.maxAttempts) throw lastTransferError;
    await sleep(options.retryDelayMs);
  }
}

async function requestLinearFileUpload(
  image: LinearReplyImage,
  size: number,
  options: WorkpadRequestOptions,
): Promise<{
  uploadUrl: string;
  assetUrl: string;
  headers: Array<{ key: string; value: string }>;
}> {
  const result = await retryLinearRequest(
    () =>
      linearRequest<{
        fileUpload?: {
          success?: boolean;
          uploadFile?: {
            uploadUrl: string;
            assetUrl: string;
            headers: Array<{ key: string; value: string }>;
          };
        };
      }>(
        options.apiKey,
        FILE_UPLOAD_MUTATION,
        {
          filename: image.filename,
          contentType: image.contentType,
          size,
        },
        options.timeoutMs,
      ),
    options,
  );
  const upload = result.fileUpload?.uploadFile;
  if (!result.fileUpload?.success || !upload) {
    throw new Error(`Linear rejected file upload for ${image.filename}.`);
  }
  return upload;
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll(/\r?\n/g, " ");
}

async function linearCommentExists(
  commentId: string,
  options: WorkpadRequestOptions,
): Promise<boolean> {
  const result = await retryLinearRequest(
    () =>
      linearRequest<{ comments?: { nodes?: Array<{ id: string }> } }>(
        options.apiKey,
        COMMENT_BY_ID_QUERY,
        { id: commentId },
        options.timeoutMs,
      ),
    options,
  );
  return result.comments?.nodes?.some((comment) => comment.id === commentId) ?? false;
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function findLinearWorkpad(
  issueIdentifier: string,
  options: WorkpadRequestOptions,
): Promise<{ issueId: string; commentId: string } | null> {
  let after: string | undefined;
  let latestWorkpad: { id: string; createdAt: string } | undefined;

  while (true) {
    const data = await retryLinearRequest(
      () =>
        linearRequest<{
          issue?: {
            id: string;
            comments?: {
              nodes?: Array<{
                id: string;
                body?: string | null;
                createdAt: string;
                resolvedAt?: string | null;
              }>;
              pageInfo?: {
                hasNextPage?: boolean;
                endCursor?: string | null;
              };
            };
          };
        }>(
          options.apiKey,
          ISSUE_WORKPAD_QUERY,
          {
            id: issueIdentifier,
            ...(after ? { after } : {}),
          },
          options.timeoutMs,
        ),
      options,
    );
    if (!data.issue) throw new Error(`Linear issue not found: ${issueIdentifier}`);

    for (const comment of data.issue.comments?.nodes ?? []) {
      const isActiveWorkpad =
        !comment.resolvedAt && comment.body?.trimStart().startsWith("## Codex Workpad");
      if (isActiveWorkpad && (!latestWorkpad || comment.createdAt > latestWorkpad.createdAt)) {
        latestWorkpad = comment;
      }
    }

    const pageInfo = data.issue.comments?.pageInfo;
    if (!pageInfo?.hasNextPage) {
      return latestWorkpad ? { issueId: data.issue.id, commentId: latestWorkpad.id } : null;
    }
    if (!pageInfo.endCursor) {
      throw new Error(`Linear comment pagination omitted a cursor for ${issueIdentifier}.`);
    }
    after = pageInfo.endCursor;
  }
}

async function retryLinearRequest<T>(
  request: () => Promise<T>,
  options: Pick<WorkpadRequestOptions, "maxAttempts" | "retryDelayMs">,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt >= options.maxAttempts || !isTransientLinearError(error)) throw error;
      await sleep(options.retryDelayMs);
    }
  }
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

async function linearRequest<T>(
  apiKey: string,
  query: string,
  variables: Record<string, string | number>,
  timeoutMs: number,
): Promise<T> {
  const response = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json().catch(() => undefined)) as
    | {
        data?: T;
        errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      }
    | undefined;
  const rateLimited = body?.errors?.some((error) => error.extensions?.code === "RATELIMITED");
  if (!response.ok) {
    throw new LinearHttpError(
      `Linear returned HTTP ${response.status}.`,
      Boolean(rateLimited) || shouldRetryResponse(response.status),
    );
  }

  if (body?.errors?.length) {
    const message = `Linear GraphQL error: ${body.errors[0]?.message ?? "unknown error"}`;
    if (rateLimited) throw new LinearHttpError(message, true);
    throw new Error(message);
  }
  if (!body?.data) throw new Error("Linear response did not include data.");
  return body.data;
}

class LinearHttpError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

function isTransientLinearError(error: unknown): boolean {
  if (error instanceof LinearHttpError) return error.retryable;
  if (error instanceof TypeError) return true;
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
