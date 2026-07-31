const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_SLACK_IMAGE_BYTES = 25 * 1024 * 1024;

interface SlackFileDownloadOptions {
  expectedSize: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export async function downloadSlackFile(
  downloadUrl: string,
  botToken: string,
  {
    expectedSize,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  }: SlackFileDownloadOptions,
): Promise<ArrayBuffer> {
  const url = new URL(downloadUrl);
  if (url.protocol !== "https:" || !isSlackHostname(url.hostname)) {
    throw new Error(`Refusing to download a file from a non-Slack URL: ${url.hostname}`);
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error(`Invalid Slack image size: ${expectedSize}.`);
  }
  if (expectedSize > MAX_SLACK_IMAGE_BYTES) {
    throw new SlackFileTooLargeError(expectedSize);
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        if (attempt < maxAttempts && isTransientResponse(response.status)) {
          await sleep(retryDelay(response, retryDelayMs));
          continue;
        }
        throw new Error(`Slack file download returned HTTP ${response.status}.`);
      }
      return await readBoundedResponse(response);
    } catch (error) {
      if (
        error instanceof SlackFileTooLargeError ||
        attempt >= maxAttempts ||
        !isTransientFetchError(error)
      ) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }
}

function isSlackHostname(hostname: string): boolean {
  return hostname === "slack.com" || hostname.endsWith(".slack.com");
}

async function readBoundedResponse(response: Response): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SLACK_IMAGE_BYTES) {
    throw new SlackFileTooLargeError(contentLength);
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SLACK_IMAGE_BYTES) {
      await reader.cancel();
      throw new SlackFileTooLargeError(totalBytes);
    }
    chunks.push(value);
  }

  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}

function isTransientResponse(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTransientFetchError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function retryDelay(response: Response, fallbackMs: number): number {
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader === null) return fallbackMs;

  const retryAfter = Number(retryAfterHeader);
  return Number.isFinite(retryAfter) ? retryAfter * 1_000 : fallbackMs;
}

class SlackFileTooLargeError extends Error {
  constructor(size: number) {
    super(`Slack image exceeds the 25 MiB transfer limit (${size} bytes).`);
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
