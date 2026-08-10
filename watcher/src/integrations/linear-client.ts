export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export async function linearRequest<T>(
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

export async function retryLinearRequest<T>(
  request: () => Promise<T>,
  options: { maxAttempts: number; retryDelayMs: number },
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

function shouldRetryResponse(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

class LinearHttpError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export function isTransientLinearError(error: unknown): boolean {
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
