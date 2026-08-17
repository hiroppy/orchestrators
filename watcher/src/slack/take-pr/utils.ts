import { createHash } from "node:crypto";

import type { SlackClient } from "../client-types.ts";
import { postSlackOperationError } from "../errors.ts";
import type { TakePrMentionEvent } from "./types.ts";

export function stableSlackClientMessageId(
  kind: "selection" | "success",
  requestId: string,
): string {
  const hex = createHash("sha256").update(`take-pr:${kind}:${requestId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function stableTakePrRequestId(event: Pick<TakePrMentionEvent, "channel" | "ts">): string {
  return `takepr_${createHash("sha256").update(`${event.channel}:${event.ts}`).digest("hex").slice(0, 20)}`;
}

export async function postTakePrError(
  client: Pick<SlackClient, "chat">,
  channel: string,
  threadTs: string,
  reason: string,
): Promise<void> {
  await postSlackOperationError(client, { channel, threadTs }, reason);
}

export function takePrErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to create a Linear issue for the PR.";
}
