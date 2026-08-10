export async function postSlackOperationError(
  client: {
    chat?: {
      postMessage(args: { channel: string; thread_ts?: string; text: string }): Promise<unknown>;
    };
  },
  message: { channel: string; threadTs?: string },
  reason: string,
  logger?: { error(error: unknown): void },
): Promise<void> {
  if (!client.chat) return;

  try {
    await client.chat.postMessage({
      channel: message.channel,
      ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
      text: `[error] ${reason}`,
    });
  } catch (error) {
    if (logger) logger.error(error);
    else throw error;
  }
}
