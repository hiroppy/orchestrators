import type { Task } from "../../domain/task.ts";
import type { WatcherStore } from "../../persistence/store.ts";
import { addSuccessReaction } from "../reactions.ts";
import { postSlackOperationError } from "../errors.ts";
import { buildTaskCard, replaceTaskCardAssignees, type TaskCard } from "../views.ts";
import type { SlackClient } from "../client-types.ts";
import { resolveSlackAssigneeId, resolveSlackAssigneeLabels } from "../users.ts";
import { withTaskCardQueue } from "../task-card-queue.ts";
import { reloadStatusTimeline } from "../status-timeline.ts";
import type { MentionCommandContext } from "../mention-commands.ts";

const MAX_ASSIGNEES_LENGTH = 2_000 - "*Assignees*\\n".length;

export async function handleAssignCommand({
  event,
  client,
  logger,
  store,
  args,
}: MentionCommandContext): Promise<void> {
  const threadTs = event.threadTs;
  if (!threadTs) return;

  const task = store.getTaskBySlackThread(event.channel, threadTs);
  if (!task) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "Run `assign` from a tracked task thread.",
    );
    return;
  }

  const slackAssigneeId =
    args.length === 1 ? await resolveSlackAssigneeId(client, args[0], event.user) : undefined;
  if (!slackAssigneeId) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Usage: ${event.botMention} \`assign @user-or-group|username|me\``,
    );
    return;
  }
  const assignees = store.getTaskAssignees(task.id);
  const slackMention = slackAssigneeId.startsWith("!subteam^")
    ? `<${slackAssigneeId}>`
    : `<@${slackAssigneeId}>`;
  const alreadyAssigned = assignees.includes(slackMention);
  if (!alreadyAssigned && [...assignees, slackMention].join(" ").length > MAX_ASSIGNEES_LENGTH) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Cannot assign ${slackMention}: task assignees reached Slack's text limit.`,
    );
    return;
  }

  if (!alreadyAssigned) {
    try {
      store.assignTask(task.id, slackAssigneeId);
    } catch (error) {
      logger.error(error);
      await postSlackOperationError(
        client,
        { channel: event.channel, threadTs },
        "Failed to assign the user to the task. No assignment was changed.",
        logger,
      );
      return;
    }
  }
  try {
    await refreshTaskAssignees(client, store, task, logger);
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "The user was assigned, but the task card could not be updated.",
      logger,
    );
    return;
  }
  try {
    await addSuccessReaction(client, { channel: event.channel, timestamp: event.ts });
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "The user was assigned, but the confirmation reaction could not be added.",
      logger,
    );
  }
}

export async function handleUnassignCommand({
  event,
  client,
  logger,
  store,
  args,
}: MentionCommandContext): Promise<void> {
  const threadTs = event.threadTs;
  if (!threadTs) {
    await postSlackOperationError(
      client,
      { channel: event.channel },
      "Run `unassign` from a tracked task thread.",
    );
    return;
  }

  const task = store.getTaskBySlackThread(event.channel, threadTs);
  if (!task) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "Run `unassign` from a tracked task thread.",
    );
    return;
  }

  const slackAssigneeId =
    args.length === 1 ? await resolveSlackAssigneeId(client, args[0], event.user) : undefined;
  if (!slackAssigneeId) {
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      `Usage: ${event.botMention} \`unassign @user-or-group|username|me\``,
    );
    return;
  }
  store.unassignTask(task.id, slackAssigneeId);
  try {
    await refreshTaskAssignees(client, store, task, logger);
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "The user was unassigned, but the task card could not be updated.",
      logger,
    );
    return;
  }
  try {
    await addSuccessReaction(client, { channel: event.channel, timestamp: event.ts });
  } catch (error) {
    logger.error(error);
    await postSlackOperationError(
      client,
      { channel: event.channel, threadTs },
      "The user was unassigned, but the confirmation reaction could not be added.",
      logger,
    );
  }
}

async function refreshTaskAssignees(
  client: Pick<SlackClient, "chat" | "users">,
  store: WatcherStore,
  task: Task,
  logger: { error(error: unknown): void },
): Promise<void> {
  await withTaskCardQueue(task.id, async () => {
    const currentTask = store.getTask(task.id) ?? task;
    if (!currentTask.parentChannelId || !currentTask.parentMessageTs) return;

    const assignees = store.getTaskAssignees(currentTask.id);
    const assigneeLabels = await resolveSlackAssigneeLabels(client, assignees, logger);
    const baseCard = buildTaskCard(
      currentTask,
      store.getSelectableStatuses(currentTask.serviceName),
      undefined,
      assigneeLabels,
    );
    let currentCard = baseCard;
    try {
      if (currentTask.lastRenderedSummary) {
        const parsed = JSON.parse(currentTask.lastRenderedSummary) as unknown;
        if (isTaskCard(parsed)) currentCard = { ...parsed, text: baseCard.text };
      }
    } catch (error) {
      logger.error(error);
    }
    const card = replaceTaskCardAssignees(currentCard, assigneeLabels);
    await client.chat.update({
      channel: currentTask.parentChannelId,
      ts: currentTask.parentMessageTs,
      ...card,
    });
    store.setRenderedSummary(currentTask.id, JSON.stringify(card));
    await reloadStatusTimeline(client, store, currentTask.id);
  });
}

function isTaskCard(value: unknown): value is TaskCard {
  if (!value || typeof value !== "object") return false;
  const card = value as Partial<TaskCard>;
  return typeof card.text === "string" && Array.isArray(card.blocks) && card.metadata !== undefined;
}
