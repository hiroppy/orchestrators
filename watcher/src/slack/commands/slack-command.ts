import type { SlackCommandConfig, SlackCommandHelpers } from "orchestrator-config";

import type { Task } from "../../domain/task.ts";
import type { MentionCommandContext } from "../mention-commands.ts";

export async function handleSlackCommand(
  slackCommand: SlackCommandConfig,
  task: Task,
  { event, client, args }: MentionCommandContext,
): Promise<void> {
  const threadTs = event.threadTs;
  if (!threadTs) return;

  const helpers: SlackCommandHelpers = {
    slack: {
      client,
      channelId: event.channel,
      messageTs: event.ts,
      threadTs,
      postMessage: async (message) => {
        await client.chat.postMessage({ ...message, channel: event.channel });
      },
      postThreadMessage: async (message) => {
        await client.chat.postMessage({ ...message, channel: event.channel, thread_ts: threadTs });
      },
    },
  };
  const output = await slackCommand.run(
    {
      service: task.serviceName,
      command: slackCommand.command,
      args,
      ...(event.user ? { user: event.user } : {}),
      issue: {
        identifier: task.issueIdentifier,
        ...(task.linkUrl ? { url: task.linkUrl } : {}),
        title: task.title,
        status: task.status,
      },
    },
    helpers,
  );
  if (output) await helpers.slack.postThreadMessage({ text: output });
}
