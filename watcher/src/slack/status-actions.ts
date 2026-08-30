import type { App } from "@slack/bolt";

import type { Task } from "../domain/task.ts";
import type { TaskEventInput, WatcherStore } from "../persistence/store.ts";
import { buildStatusChangedMessage, buildTaskCard } from "./views.ts";
import { TASK_STATUS_ACTION_ID, taskIdFromBlockId } from "./interactions.ts";
import type { SlackClient } from "./client-types.ts";
import { postSlackOperationError } from "./errors.ts";
import { publishStatusTimeline } from "./status-timeline.ts";
import { withTaskCardQueue } from "./task-card-queue.ts";
import { resolveSlackAssigneeLabels, resolveSlackDisplayName } from "./users.ts";
import { escapeSlack } from "./view-formatting.ts";

export type LinearStatusUpdater = (task: Task, status: string) => Promise<void>;
export type StatusTransitionHandler = (
  task: Task,
  fromStatus: string,
  toStatus: string,
  client: SlackClient,
) => Promise<void>;
export type StatusTransitionEventFactory = (
  task: Task,
  fromStatus: string,
  toStatus: string,
) => TaskEventInput | TaskEventInput[] | undefined;

export function registerStatusAction(
  app: App,
  store: WatcherStore,
  updateLinearStatus: LinearStatusUpdater,
  createStatusTransitionEvent?: StatusTransitionEventFactory,
  onStatusTransition?: StatusTransitionHandler,
): void {
  app.action(TASK_STATUS_ACTION_ID, async (args) => {
    await handleStatusAction(
      args,
      store,
      updateLinearStatus,
      onStatusTransition,
      createStatusTransitionEvent,
    );
  });
}

export async function handleStatusAction(
  { ack, action, body, client, logger }: StatusActionArguments,
  store: WatcherStore,
  updateLinearStatus: LinearStatusUpdater,
  onStatusTransition?: StatusTransitionHandler,
  createStatusTransitionEvent?: StatusTransitionEventFactory,
): Promise<void> {
  await ack();

  try {
    const selectedStatus = selectedStatusFromAction(action);
    const actionBody = body as StatusActionBody;
    const taskId =
      actionBody.message?.metadata?.event_payload?.task_id ??
      taskIdFromBlockId(actionBody.actions?.[0]?.block_id);
    const actor = actionBody.user?.id;

    if (!selectedStatus) throw new Error("Slack action did not include a selected status.");
    if (!taskId) throw new Error("Slack action did not include a task ID.");
    if (!actor) throw new Error("Slack action did not include a user ID.");

    const statusTransition = await withTaskCardQueue(taskId, async () => {
      const existingTask = store.getTask(taskId);
      if (!existingTask) throw new Error(`Task not found: ${taskId}`);
      const configuredStatuses = store.getSelectableStatuses(existingTask.serviceName);
      if (!configuredStatuses.includes(selectedStatus)) {
        throw new Error(
          `Status is not configured for ${existingTask.serviceName}: ${selectedStatus}`,
        );
      }
      if (existingTask.status === selectedStatus) return;
      if (!existingTask.parentChannelId || !existingTask.parentMessageTs) {
        throw new Error(`Task has no Slack parent message: ${taskId}`);
      }
      const assigneeLabels = await resolveSlackAssigneeLabels(
        client,
        store.getTaskAssignees(taskId),
        logger,
      );
      const card = buildTaskCard(
        {
          ...existingTask,
          status: selectedStatus,
          updatedAt: new Date().toISOString(),
        },
        configuredStatuses,
        {
          type: "updated",
          service: existingTask.serviceName,
          issueIdentifier: existingTask.issueIdentifier,
          resolvedState: selectedStatus,
        },
        assigneeLabels,
      );
      try {
        await updateLinearStatus(existingTask, selectedStatus);
      } catch (error) {
        await postSlackOperationError(
          client,
          {
            channel: existingTask.parentChannelId,
            threadTs: existingTask.parentMessageTs,
          },
          `Failed to confirm the Linear status update to ${escapeSlack(selectedStatus)}. The watcher still shows ${escapeSlack(existingTask.status)}; the Linear status may have changed. ${linearStatusErrorDetails(error)} Please check Linear before trying again.`,
          logger,
        );
        throw error;
      }
      await client.chat.update({
        channel: existingTask.parentChannelId,
        ts: existingTask.parentMessageTs,
        ...card,
      });
      const { task, fromStatus } = store.updateTaskStatusAtomically(
        taskId,
        selectedStatus,
        (updatedTask, previousStatus) =>
          createStatusTransitionEvent?.(updatedTask, previousStatus, selectedStatus),
      );
      store.setRenderedSummary(task.id, JSON.stringify(card));
      const actorDisplayName = await resolveSlackDisplayName(client, actionBody.user, logger);
      const statusChangedLine = buildStatusChangedMessage(
        actorDisplayName,
        fromStatus,
        selectedStatus,
      );
      await publishStatusTimeline(client, store, {
        taskId: task.id,
        event: {
          fromStatus,
          toStatus: selectedStatus,
          occurredAt: new Date().toISOString(),
          source: { type: "manual", actor: { id: actor, label: actorDisplayName } },
        },
        fallbackText: statusChangedLine,
      });
      store.addEvent({
        taskId: task.id,
        type: "status_changed",
        actor,
        fromStatus,
        toStatus: selectedStatus,
        body: statusChangedLine,
      });
      return { task, fromStatus };
    });
    if (statusTransition) {
      await onStatusTransition?.(
        statusTransition.task,
        statusTransition.fromStatus,
        selectedStatus,
        client,
      );
    }
  } catch (error) {
    logger.error(error);
  }
}

function linearStatusErrorDetails(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^Linear returned HTTP \d{3}\.$/.test(message)
    ? `Error: ${message}`
    : "See the watcher logs for error details.";
}

interface StatusActionBody {
  user?: { id?: string; name?: string; username?: string };
  message?: {
    metadata?: {
      event_payload?: { task_id?: string };
    };
  };
  actions?: Array<{ block_id?: string }>;
}

interface StatusActionArguments {
  ack: () => Promise<unknown>;
  action: unknown;
  body: unknown;
  client: SlackClient;
  logger: { error(error: unknown): void };
}

function selectedStatusFromAction(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const selectedOption = (action as { selected_option?: { value?: unknown } }).selected_option;
  return typeof selectedOption?.value === "string" ? selectedOption.value : undefined;
}
