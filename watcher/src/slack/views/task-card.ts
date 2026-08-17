import type { Task } from "../../domain/task.ts";
import type { WatcherEvent } from "../../domain/watcher-event.ts";
import { TASK_STATUS_ACTION_ID, taskBlockId } from "../interactions.ts";
import { capitalize, escapeSlack, isPresent } from "../view-formatting.ts";
import {
  buildFieldSections,
  buildTextSection,
  formatAssignees,
  formatError,
  formatNonNotifyingAssignee,
  formatParentPullRequestField,
  isWatcherErrorTask,
  parentEventLabel,
} from "./shared.ts";

export interface TaskCard {
  text: string;
  blocks: Array<Record<string, unknown>>;
  metadata: {
    event_type: "watcher_task";
    event_payload: { task_id: string };
  };
}

export interface TaskCardOptions {
  interactive?: boolean;
  titlePrefix?: string;
}

export function buildTaskCard(
  task: Task,
  configuredStatuses: string[],
  event?: WatcherEvent,
  assignees: string[] = [],
  options: TaskCardOptions = {},
): TaskCard {
  const watcherErrorTask = isWatcherErrorTask(task);
  const issueUrl = event?.issueUrl ?? task.linkUrl;
  const issueTitle = watcherErrorTask
    ? "Symphony connection"
    : task.title === task.issueIdentifier
      ? undefined
      : task.title;
  const displayTitle = [options.titlePrefix, `[${task.serviceName}]`, issueTitle]
    .filter(isPresent)
    .join(" ");
  const linkedTitle = issueUrl
    ? `<${issueUrl}|${escapeSlack(displayTitle)}>`
    : escapeSlack(displayTitle);
  const selectOptions = configuredStatuses.map((name) => ({
    text: { type: "plain_text", text: name },
    value: name,
  }));
  const selected = selectOptions.find(({ value }) => value === task.status);
  const blockId = taskBlockId(task.id, task.status);
  const showStatusSelect = options.interactive !== false && !watcherErrorTask;
  const displayedAssignees = assignees.map(formatNonNotifyingAssignee);
  const primaryFields = [
    watcherErrorTask ? `*Status*\n${escapeSlack(capitalize(task.status))}` : null,
    event ? `*Event*\n${escapeSlack(parentEventLabel(event))}` : null,
    displayedAssignees.length > 0 ? formatAssignees(displayedAssignees) : null,
  ].filter(isPresent);
  const errorFields = [event?.error ? `*Error*\n${formatError(event.error)}` : null].filter(
    isPresent,
  );
  const pullRequestFields = [
    event?.pullRequest ? formatParentPullRequestField(event.pullRequest) : null,
  ].filter(isPresent);
  const overviewBlocks = buildFieldSections(primaryFields, errorFields, pullRequestFields);
  const fallbackText =
    displayedAssignees.length > 0
      ? `${displayTitle}. Assigned to ${displayedAssignees.join(" ")}`
      : displayTitle;
  return {
    text: fallbackText,
    metadata: {
      event_type: "watcher_task",
      event_payload: { task_id: task.id },
    },
    blocks: [
      {
        type: "section",
        block_id: `task_summary:${encodeURIComponent(task.id)}`,
        text: {
          type: "mrkdwn",
          text: `*${linkedTitle}*`,
        },
      },
      ...(showStatusSelect
        ? [
            {
              type: "actions",
              block_id: blockId,
              elements: [
                {
                  type: "static_select",
                  action_id: TASK_STATUS_ACTION_ID,
                  placeholder: { type: "plain_text", text: "Status" },
                  options: selectOptions,
                  ...(selected ? { initial_option: selected } : {}),
                },
              ],
            },
          ]
        : []),
      ...overviewBlocks,
    ],
  };
}

export function replaceTaskCardAssignees(card: TaskCard, assignees: string[]): TaskCard {
  const field =
    assignees.length > 0 ? formatAssignees(assignees.map(formatNonNotifyingAssignee)) : undefined;
  let replaced = false;
  const blocks = card.blocks.flatMap((block) => {
    if (block.type !== "section") return [block];

    if (Array.isArray(block.fields)) {
      const fields = (block.fields as Array<Record<string, unknown>>).flatMap((item) => {
        if (typeof item.text !== "string" || !item.text.startsWith("*Assignees*\n")) {
          return [item];
        }
        replaced = true;
        return field ? [{ ...item, text: field }] : [];
      });
      return fields.length > 0 ? [{ ...block, fields }] : [];
    }

    const text = block.text as Record<string, unknown> | undefined;
    if (typeof text?.text !== "string" || !text.text.startsWith("*Assignees*\n")) {
      return [block];
    }
    replaced = true;
    return field ? [{ ...block, text: { ...text, text: field } }] : [];
  });

  if (field && !replaced) {
    const insertAt = blocks.findLastIndex((block) => block.type === "actions") + 1;
    blocks.splice(insertAt, 0, buildTextSection(field));
  }

  return { ...card, blocks };
}
