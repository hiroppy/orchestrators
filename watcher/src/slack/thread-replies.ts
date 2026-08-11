const SUPPORTED_FILE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

interface SlackFile {
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
  url_private_download?: string;
}

export interface UserThreadReply {
  channel: string;
  thread_ts: string;
  ts: string;
  user: string;
  text: string;
  files: SlackFile[];
}

export function parseUserThreadReply(
  message: unknown,
  botUserId?: string,
): UserThreadReply | undefined {
  if (!message || typeof message !== "object") return undefined;

  const event = message as Record<string, unknown>;
  const files = Array.isArray(event.files) ? event.files.filter(isSupportedSlackFile) : [];
  const isSupportedSubtype =
    event.subtype === undefined ||
    event.subtype === "thread_broadcast" ||
    event.subtype === "file_share";
  if (
    typeof event.channel !== "string" ||
    typeof event.thread_ts !== "string" ||
    typeof event.ts !== "string" ||
    typeof event.user !== "string" ||
    typeof event.text !== "string" ||
    isRecognizedMentionCommand(event.text, botUserId) ||
    (event.text.trim().length === 0 && files.length === 0) ||
    !isSupportedSubtype ||
    event.bot_id !== undefined
  ) {
    return undefined;
  }

  return {
    channel: event.channel,
    thread_ts: event.thread_ts,
    ts: event.ts,
    user: event.user,
    text: event.text,
    files,
  };
}

function isRecognizedMentionCommand(text: string, botUserId?: string): boolean {
  if (!botUserId) return false;
  const match = text.match(/^\s*<@([A-Z0-9]+)>\s+(?:assign|help|status)(?:\s|$)/i);
  return match?.[1]?.toLowerCase() === botUserId.toLowerCase();
}

function isSupportedSlackFile(file: unknown): file is SlackFile {
  if (!file || typeof file !== "object") return false;

  const value = file as Record<string, unknown>;
  return (
    typeof value.name === "string" &&
    typeof value.mimetype === "string" &&
    SUPPORTED_FILE_CONTENT_TYPES.has(value.mimetype) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.url_private === "string" &&
    (value.url_private_download === undefined || typeof value.url_private_download === "string")
  );
}
