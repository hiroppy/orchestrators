import { ErrorCode } from "@slack/web-api";

export interface ReactionClient {
  reactions: {
    add(args: { channel: string; name: string; timestamp: string }): Promise<unknown>;
  };
}

export async function addSuccessReaction(
  client: ReactionClient,
  message: { channel: string; timestamp: string },
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.reactions.add({
        channel: message.channel,
        name: "white_check_mark",
        timestamp: message.timestamp,
      });
      return;
    } catch (error) {
      if (slackError(error) === "already_reacted") return;
      if (attempt >= 3 || !isTransientSlackError(error)) throw error;
      await sleep(retryDelayMs(error));
    }
  }
}

function retryDelayMs(error: unknown): number {
  if (!error || typeof error !== "object") return 100;
  const details = error as { code?: unknown; retryAfter?: unknown };
  return details.code === ErrorCode.RateLimitedError && typeof details.retryAfter === "number"
    ? details.retryAfter * 1000
    : 100;
}

function slackError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : undefined;
}

function isTransientSlackError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: unknown; statusCode?: unknown };
  if (details.code === ErrorCode.RequestError || details.code === ErrorCode.RateLimitedError) {
    return true;
  }
  if (details.code === ErrorCode.HTTPError) {
    return typeof details.statusCode !== "number" || details.statusCode >= 500;
  }
  return (
    details.code === ErrorCode.PlatformError &&
    ["fatal_error", "internal_error", "request_timeout", "service_unavailable"].includes(
      slackError(error) ?? "",
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
