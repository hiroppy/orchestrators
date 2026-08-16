import { normalizeStatus } from "../../domain/status.ts";
import { buildStatusSummary, buildStatusSummaryBlocks, STATUS_SUMMARY_STATUSES } from "../views.ts";
import type { MentionCommandContext } from "../mention-commands.ts";

const STATUS_NAMES = new Set(STATUS_SUMMARY_STATUSES.map(normalizeStatus));

export async function handleStatusCommand({
  event,
  client,
  logger,
  store,
  args,
  statusSummaryContext,
}: MentionCommandContext): Promise<void> {
  if (args.length > 0) return;

  const tasks = store
    .getTasksForLinearSync()
    .filter((task) => STATUS_NAMES.has(normalizeStatus(task.status)));
  const slackLinks = new Map<string, string>();

  await Promise.all(
    tasks.map(async (task) => {
      if (!task.parentChannelId || !task.parentMessageTs) return;
      try {
        const response = await client.chat.getPermalink({
          channel: task.parentChannelId,
          message_ts: task.parentMessageTs,
        });
        if (response.permalink) slackLinks.set(task.id, response.permalink);
      } catch (error) {
        logger.error(error);
      }
    }),
  );

  await client.chat.postMessage({
    channel: event.channel,
    text: buildStatusSummary(tasks, slackLinks, statusSummaryContext),
    blocks: buildStatusSummaryBlocks(tasks, slackLinks, statusSummaryContext),
    unfurl_links: false,
    unfurl_media: false,
  });
}
