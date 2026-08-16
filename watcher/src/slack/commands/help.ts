import { buildHelpMessage, buildHelpMessageBlocks } from "../views.ts";
import { resolveSlackDisplayName } from "../users.ts";
import type { MentionCommandContext } from "../mention-commands.ts";

export async function handleHelpCommand({
  event,
  client,
  logger,
  args,
}: MentionCommandContext): Promise<void> {
  if (args.length > 0) return;
  const botName = await resolveSlackDisplayName(client, { id: event.botUserId }, logger);

  await client.chat.postMessage({
    channel: event.channel,
    text: buildHelpMessage(botName),
    blocks: buildHelpMessageBlocks(botName),
  });
}
