import { isTransientLinearError, linearRequest, retryLinearRequest } from "./linear-client.ts";
import { stableLinearUuid } from "./linear-id.ts";
import {
  COMMENT_BY_ID_QUERY,
  COMMENT_REPLY_CREATE_MUTATION,
  FILE_UPLOAD_MUTATION,
  ISSUE_WORKPAD_QUERY,
} from "./linear-queries.ts";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;

interface LinearReplyFile {
  filename: string;
  contentType: string;
  loadData(): Promise<ArrayBuffer>;
}

interface CreateLinearWorkpadReplyOptions {
  apiKey?: string;
  idempotencyKey: string;
  files?: LinearReplyFile[];
  authorName?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

interface WorkpadRequestOptions {
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

export async function createLinearWorkpadReply(
  issueIdentifier: string,
  body: string,
  {
    apiKey,
    idempotencyKey,
    files,
    authorName,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  }: CreateLinearWorkpadReplyOptions,
): Promise<boolean> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const requestOptions = { apiKey, timeoutMs, maxAttempts, retryDelayMs };
  const workpad = await findLinearWorkpad(issueIdentifier, requestOptions);
  if (!workpad) return false;

  const commentId = stableLinearUuid(idempotencyKey);
  const replyFiles = files ?? [];
  if (replyFiles.length > 0 && (await linearCommentExists(commentId, requestOptions))) return true;

  const fileMarkdown = await uploadReplyFiles(replyFiles, requestOptions);
  const authorLabel = authorName ? `Slack投稿者: ${authorName}` : undefined;
  const replyBody = [authorLabel, body, ...fileMarkdown].filter(Boolean).join("\n\n");
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

async function uploadReplyFiles(
  files: LinearReplyFile[],
  options: WorkpadRequestOptions,
): Promise<string[]> {
  const markdown: string[] = [];
  for (const file of files) {
    markdown.push(await uploadReplyFile(file, options));
  }
  return markdown;
}

async function uploadReplyFile(
  file: LinearReplyFile,
  options: WorkpadRequestOptions,
): Promise<string> {
  const data = await file.loadData();
  let lastTransferError: Error | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const upload = await requestLinearFileUpload(file, data.byteLength, options);
    const headers = new Headers({
      "Cache-Control": "public, max-age=31536000",
      "Content-Type": file.contentType,
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
        return `![${escapeMarkdownLabel(file.filename)}](${upload.assetUrl})`;
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
  file: LinearReplyFile,
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
          filename: file.filename,
          contentType: file.contentType,
          size,
        },
        options.timeoutMs,
      ),
    options,
  );
  const upload = result.fileUpload?.uploadFile;
  if (!result.fileUpload?.success || !upload) {
    throw new Error(`Linear rejected file upload for ${file.filename}.`);
  }
  return upload;
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

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll(/\r?\n/g, " ");
}

function shouldRetryResponse(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
