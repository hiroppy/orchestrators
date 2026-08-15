import type { KnownBlock } from "@slack/web-api";

import type { PullRequest, Task, TaskEvent } from "../domain/types.ts";
import type { WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "./client-types.ts";
import { resolveSlackAssigneeLabels, resolveSlackDisplayName } from "./users.ts";
import { escapeSlack, truncate } from "./view-formatting.ts";
import { formatAssignees, formatParentPullRequestField } from "./views.ts";

const STATUS_TIMELINE_EVENT = "status_timeline";
const MAX_TIMELINE_EVENTS = 10;

export interface StatusCardEvent {
  fromStatus: string;
  toStatus: string;
  occurredAt: string;
  source: StatusEventSource;
}

type StatusEventSource =
  | {
      type: "automatic";
      label: string;
      error?: string;
    }
  | {
      type: "manual";
      actor: {
        id: string;
        label: string;
      };
    };

interface StatusCardFacts {
  assignees: readonly string[];
  pullRequest?: PullRequest;
}

export interface StatusCard {
  events: readonly [StatusCardEvent, ...StatusCardEvent[]];
  facts: StatusCardFacts;
}

interface StatusCardDelivery {
  taskId: string;
  fallbackText: string;
  event: StatusCardEvent;
}

export async function publishStatusTimeline(
  client: SlackClient,
  store: WatcherStore,
  delivery: StatusCardDelivery,
): Promise<void> {
  const task = store.getTask(delivery.taskId);
  if (!task?.parentChannelId || !task.parentMessageTs) {
    throw new Error(`Task has no Slack parent message: ${delivery.taskId}`);
  }
  const previous = store.getLatestEventsByType(
    delivery.taskId,
    STATUS_TIMELINE_EVENT,
    MAX_TIMELINE_EVENTS,
  );
  const anchorTs = previous[0]?.slackThreadTs;
  const history = await Promise.all(previous.map((event) => toStatusCardEvent(client, event)));
  const card = {
    events: [delivery.event, ...history],
    facts: await loadStatusCardFacts(client, store, task),
  } satisfies StatusCard;
  const blocks = buildStatusCard(card);

  let messageTs = anchorTs;
  if (anchorTs) {
    await client.chat.update({
      channel: task.parentChannelId,
      ts: anchorTs,
      text: delivery.fallbackText,
      blocks,
    });
  } else {
    const response = await client.chat.postMessage({
      channel: task.parentChannelId,
      thread_ts: task.parentMessageTs,
      text: delivery.fallbackText,
      blocks,
    });
    messageTs = response.ts;
  }

  const { event } = delivery;
  const { source } = event;
  store.addEvent({
    taskId: delivery.taskId,
    type: STATUS_TIMELINE_EVENT,
    actor: source.type === "manual" ? source.actor.id : "watcher",
    statusEventType: source.type,
    statusEventLabel: source.type === "automatic" ? source.label : undefined,
    statusEventError: source.type === "automatic" ? source.error : undefined,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    body: delivery.fallbackText,
    slackThreadTs: messageTs,
    createdAt: new Date(event.occurredAt),
  });
}

export async function reloadStatusTimeline(
  client: SlackClient,
  store: WatcherStore,
  taskId: string,
): Promise<void> {
  const task = store.getTask(taskId);
  const storedEvents = store.getLatestEventsByType(
    taskId,
    STATUS_TIMELINE_EVENT,
    MAX_TIMELINE_EVENTS + 1,
  );
  const messageTs = storedEvents[0]?.slackThreadTs;
  if (!task?.parentChannelId || !messageTs) return;

  const events = await Promise.all(storedEvents.map((event) => toStatusCardEvent(client, event)));
  const [latest, ...history] = events;
  if (!latest) return;

  await client.chat.update({
    channel: task.parentChannelId,
    ts: messageTs,
    text: storedEvents[0]?.body ?? `${latest.fromStatus} → ${latest.toStatus}`,
    blocks: buildStatusCard({
      events: [latest, ...history],
      facts: await loadStatusCardFacts(client, store, task),
    }),
  });
}

export function buildStatusCard(card: StatusCard): KnownBlock[] {
  const [latest, ...history] = card.events;
  const { source } = latest;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlack(latest.fromStatus)} → ${escapeSlack(latest.toStatus)}*`,
      },
    },
  ];
  const occurredAt = formatTimelineTime(latest.occurredAt);
  const primaryFields = [
    `*Event*\n\`${occurredAt}\` ${formatEventSource(source)}`,
    card.facts.assignees.length ? formatAssignees(card.facts.assignees) : undefined,
  ].filter((value): value is string => value !== undefined);
  blocks.push({
    type: "section",
    fields: primaryFields.map((text) => ({ type: "mrkdwn", text })),
  });
  if (card.facts.pullRequest) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: formatParentPullRequestField(card.facts.pullRequest) },
    });
  }
  if (source.type === "automatic" && source.error) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n${escapeSlack(truncate(source.error, 180))}` },
    });
  }
  if (history.length === 0) return blocks;
  const lines = history.map(({ source, fromStatus, occurredAt, toStatus }) => {
    const attribution = source.type === "manual" ? ` by ${escapeSlack(source.actor.label)}` : "";
    return `${formatTimelineTime(occurredAt)}\u2003${escapeSlack(fromStatus)} → ${escapeSlack(toStatus)}${attribution}`;
  });
  const timeline = truncateTimeline(lines);
  return [
    ...blocks,
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*Timeline*\n${timeline}` } },
  ];
}

async function toStatusCardEvent(client: SlackClient, event: TaskEvent): Promise<StatusCardEvent> {
  if (!event.fromStatus || !event.toStatus) {
    throw new Error(`Persisted status card event has no transition: ${event.id}`);
  }
  let source: StatusEventSource;
  if (event.statusEventType === "automatic" && event.statusEventLabel) {
    source = {
      type: "automatic",
      label: event.statusEventLabel,
      ...(event.statusEventError ? { error: event.statusEventError } : {}),
    };
  } else if (event.statusEventType === "manual" && event.actor) {
    source = {
      type: "manual",
      actor: {
        id: event.actor,
        label: await resolveSlackDisplayName(client, { id: event.actor }),
      },
    };
  } else {
    throw new Error(`Invalid persisted status card event: ${event.id}`);
  }
  return {
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    occurredAt: event.createdAt,
    source,
  };
}

async function loadStatusCardFacts(
  client: SlackClient,
  store: WatcherStore,
  task: Task,
): Promise<StatusCardFacts> {
  return {
    assignees: await resolveSlackAssigneeLabels(client, store.getTaskAssignees(task.id)),
    pullRequest: task.pullRequest,
  };
}

function formatEventSource(source: StatusEventSource): string {
  if (source.type === "automatic") return escapeSlack(source.label);
  return `Changed by ${escapeSlack(source.actor.label)}`;
}

function formatTimelineTime(occurredAt: string): string {
  const date = new Date(occurredAt);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function truncateTimeline(lines: string[]): string {
  const maxLength = 2_900;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines.slice(0, MAX_TIMELINE_EVENTS)) {
    if (length + line.length + 1 > maxLength) break;
    kept.push(line);
    length += line.length + 1;
  }
  return kept.length === lines.length ? kept.join("\n") : `${kept.join("\n")}\n…`;
}
