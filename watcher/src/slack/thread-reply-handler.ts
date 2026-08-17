import type { Task } from "../domain/task.ts";
import { isLinearRateLimitError } from "../integrations/linear/client.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { withQueue } from "./async-queue.ts";
import { postSlackOperationError } from "./errors.ts";
import { addSuccessReaction, type ReactionClient } from "./reactions.ts";
import { parseUserThreadReply, type UserThreadReply } from "./thread-replies.ts";
import { resolveSlackDisplayName } from "./users.ts";
import type { SlackClient } from "./client-types.ts";

interface SlackReplyFile {
  filename: string;
  contentType: string;
  downloadUrl: string;
  size: number;
}

export interface SlackThreadReply {
  text: string;
  files: SlackReplyFile[];
  authorName: string;
}

export type LinearWorkpadReplier = (
  task: Task,
  reply: SlackThreadReply,
  idempotencyKey: string,
) => Promise<boolean>;

const replyQueues = new Map<string, Promise<void>>();

export async function handleThreadReply(
  { message, client, logger }: MessageArguments,
  store: WatcherStore,
  createLinearWorkpadReply: LinearWorkpadReplier,
  botUserId?: string,
): Promise<void> {
  const reply = parseUserThreadReply(message, botUserId);
  if (!reply) return;

  const task = store.getTaskBySlackThread(reply.channel, reply.thread_ts);
  if (!task) return;

  const queueKey = `${reply.channel}:${reply.thread_ts}`;
  await withQueue(replyQueues, queueKey, async () => {
    const replyRecorded = store.hasRecordedSlackMessage(task.id, reply.ts, "workpad_replied");

    if (!replyRecorded) {
      const created = await createWorkpadReply(
        client,
        logger,
        store,
        task,
        reply,
        createLinearWorkpadReply,
      );
      if (!created) return;
    }

    if (store.hasRecordedSlackMessage(task.id, reply.ts, "workpad_reply_acknowledged")) return;

    try {
      await addSuccessReaction(client, { channel: reply.channel, timestamp: reply.ts });
      store.addEvent({
        taskId: task.id,
        type: "workpad_reply_acknowledged",
        actor: reply.user,
        slackThreadTs: reply.ts,
      });
    } catch (error) {
      logger.error(error);
    }
  });
}

async function createWorkpadReply(
  client: MessageArguments["client"],
  logger: MessageArguments["logger"],
  store: WatcherStore,
  task: Task,
  reply: UserThreadReply,
  createLinearWorkpadReply: LinearWorkpadReplier,
): Promise<boolean> {
  let created: boolean;
  try {
    const authorName = await resolveSlackDisplayName(client, { id: reply.user }, logger);
    created = await createLinearWorkpadReply(
      task,
      {
        text: reply.text,
        authorName,
        files: reply.files.map((file) => ({
          filename: file.name,
          contentType: file.mimetype,
          downloadUrl: file.url_private_download ?? file.url_private,
          size: file.size,
        })),
      },
      `${reply.channel}:${reply.ts}`,
    );
  } catch (error) {
    logger.error(error);
    const reason = isLinearRateLimitError(error)
      ? "The Linear API rate limit was reached. Please try again later."
      : "An error occurred while copying the reply to Linear.";
    await postLinearReplyFailure(client, reply, reason, logger);
    return false;
  }

  if (!created) {
    await postLinearReplyFailure(
      client,
      reply,
      "The destination Workpad could not be found in Linear.",
      logger,
    );
    return false;
  }

  try {
    store.addEvent({
      taskId: task.id,
      type: "workpad_replied",
      actor: reply.user,
      body: reply.text,
      slackThreadTs: reply.ts,
    });
    return true;
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: reply.channel, threadTs: reply.thread_ts },
      "The reply was copied to Linear, but the result could not be recorded.",
      logger,
    );
    return false;
  }
}

async function postLinearReplyFailure(
  client: MessageArguments["client"],
  reply: UserThreadReply,
  reason: string,
  logger: MessageArguments["logger"],
): Promise<void> {
  await postSlackOperationError(
    client,
    { channel: reply.channel, threadTs: reply.thread_ts },
    `Failed to copy the reply to Linear. Reason: ${reason}`,
    logger,
  );
}

interface MessageArguments {
  message: unknown;
  client: ReactionClient & {
    chat?: Pick<SlackClient["chat"], "postMessage">;
    users?: SlackClient["users"];
  };
  logger: { error(error: unknown): void };
}
