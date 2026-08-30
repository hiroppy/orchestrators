import { createHash } from "node:crypto";

import type { KnownBlock } from "@slack/web-api";

import type { PullRequest } from "../domain/github.ts";
import type { Task, TaskActivity, TaskEvent } from "../domain/task.ts";
import type { WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "./client-types.ts";
import { withTaskCardQueue } from "./task-card-queue.ts";
import { resolveSlackDisplayName } from "./users.ts";
import { escapeSlack, truncate } from "./view-formatting.ts";
import { formatParentPullRequestField } from "./views.ts";

const STATUS_TIMELINE_EVENT = "status_timeline";
const MAX_TIMELINE_HISTORY_EVENTS = 10;

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
  pullRequest?: PullRequest;
  activity?: TaskActivity;
}

export interface StatusCard {
  events: readonly [StatusCardEvent, ...StatusCardEvent[]];
  facts: StatusCardFacts;
}

interface StatusCardDelivery {
  taskId: string;
  fallbackText: string;
  event: StatusCardEvent;
  idempotencyKey?: string;
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
  if (
    delivery.idempotencyKey &&
    store.hasStatusTimelineEvent(delivery.taskId, delivery.idempotencyKey)
  ) {
    await reloadStatusTimeline(client, store, delivery.taskId);
    return;
  }
  const storedEvent = recordStatusTimeline(store, delivery);
  await deliverStatusTimelineEvent(client, store, storedEvent);
}

export function recordStatusTimeline(store: WatcherStore, delivery: StatusCardDelivery): TaskEvent {
  const { event } = delivery;
  const { source } = event;
  return store.addEvent({
    taskId: delivery.taskId,
    type: STATUS_TIMELINE_EVENT,
    actor: source.type === "manual" ? source.actor.id : "watcher",
    statusEventType: source.type,
    statusEventLabel: source.type === "automatic" ? source.label : undefined,
    statusEventError: source.type === "automatic" ? source.error : undefined,
    statusEventKey: delivery.idempotencyKey,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    body: delivery.fallbackText,
    createdAt: new Date(event.occurredAt),
  });
}

export async function deliverPendingStatusTimelines(
  client: SlackClient,
  store: WatcherStore,
): Promise<void> {
  for (const event of store.getUndeliveredStatusTimelineEvents()) {
    try {
      await withTaskCardQueue(event.taskId, () => deliverStatusTimelineEvent(client, store, event));
    } catch (error) {
      console.error(`Failed to deliver pending status timeline for ${event.taskId}:`, error);
    }
  }
}

export async function deliverStatusTimelineEvent(
  client: SlackClient,
  store: WatcherStore,
  event: TaskEvent,
): Promise<void> {
  const task = store.getTask(event.taskId);
  if (!task?.parentChannelId || !task.parentMessageTs) return;
  const previous = store
    .getLatestDeliveredEventsByType(
      event.taskId,
      STATUS_TIMELINE_EVENT,
      MAX_TIMELINE_HISTORY_EVENTS + 1,
    )
    .filter((candidate) => candidate.id !== event.id)
    .slice(0, MAX_TIMELINE_HISTORY_EVENTS);
  const anchorTs = previous[0]?.slackThreadTs;
  const storedEvents = [event, ...previous].sort(
    (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id - left.id,
  );
  const events = await Promise.all(storedEvents.map((item) => toStatusCardEvent(client, item)));
  const [latest, ...history] = events;
  if (!latest) return;
  const fallbackText = storedEvents[0]?.body ?? `${latest.fromStatus} → ${latest.toStatus}`;
  const card = {
    events: [latest, ...history],
    facts: loadStatusCardFacts(task),
  } satisfies StatusCard;
  const blocks = buildStatusCard(card);

  let messageTs = anchorTs;
  if (anchorTs) {
    await client.chat.update({
      channel: task.parentChannelId,
      ts: anchorTs,
      text: fallbackText,
      blocks,
    });
  } else {
    const response = await client.chat.postMessage({
      channel: task.parentChannelId,
      thread_ts: task.parentMessageTs,
      text: fallbackText,
      blocks,
      client_msg_id: stableSlackClientMessageId(event.id),
    });
    if (!response.ts) throw new Error(`Slack did not return ts for task ${event.taskId}.`);
    messageTs = response.ts;
  }
  if (!messageTs) throw new Error(`Status timeline has no Slack timestamp: ${event.taskId}.`);
  store.setTaskEventSlackThreadTs(event.id, messageTs);
}

export async function reloadStatusTimeline(
  client: SlackClient,
  store: WatcherStore,
  taskId: string,
): Promise<boolean> {
  const task = store.getTask(taskId);
  const storedEvents = store.getLatestDeliveredEventsByType(
    taskId,
    STATUS_TIMELINE_EVENT,
    MAX_TIMELINE_HISTORY_EVENTS + 1,
  );
  const messageTs = storedEvents[0]?.slackThreadTs;
  if (!task?.parentChannelId || !messageTs) return false;

  const events = await Promise.all(storedEvents.map((event) => toStatusCardEvent(client, event)));
  const [latest, ...history] = events;
  if (!latest) return false;

  await client.chat.update({
    channel: task.parentChannelId,
    ts: messageTs,
    text: storedEvents[0]?.body ?? `${latest.fromStatus} → ${latest.toStatus}`,
    blocks: buildStatusCard({
      events: [latest, ...history],
      facts: loadStatusCardFacts(task),
    }),
  });
  return true;
}

function stableSlackClientMessageId(eventId: number): string {
  const hex = createHash("sha256").update(`status-timeline:${eventId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildStatusCard(card: StatusCard): KnownBlock[] {
  const latest = card.events[0];
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
    `*Event*\n${formatEventSource(source)}`,
    `*Updated at*\n\`${occurredAt}\``,
  ];
  blocks.push({
    type: "section",
    fields: primaryFields.map((text) => ({ type: "mrkdwn", text })),
  });
  if (card.facts.activity) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: formatCurrentActivity(card.facts.activity) },
    });
  }
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
  const lines = card.events.map(({ source, fromStatus, occurredAt, toStatus }) => {
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

function loadStatusCardFacts(task: Task): StatusCardFacts {
  return {
    pullRequest: task.pullRequest,
    activity: task.currentActivity,
  };
}

function formatCurrentActivity(activity: TaskActivity): string {
  const lines = ["*Current activity*", escapeSlack(truncate(activity.message, 120))];
  const files = activity.changedFiles
    .map((file) => `\`${escapeSlack(truncate(file, 80))}\``)
    .join(", ");
  if (files) {
    const omitted = activity.changedFileCount - activity.changedFiles.length;
    lines.push(omitted > 0 ? `${files} +${omitted} more` : files);
    const fileLabel = activity.changedFileCount === 1 ? "file" : "files";
    lines.push(
      `${activity.changedFileCount} ${fileLabel} (+${activity.additions} / −${activity.deletions})`,
    );
  }
  return lines.join("\n");
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
  for (const line of lines.slice(0, MAX_TIMELINE_HISTORY_EVENTS + 1)) {
    if (length + line.length + 1 > maxLength) break;
    kept.push(line);
    length += line.length + 1;
  }
  return kept.length === lines.length ? kept.join("\n") : `${kept.join("\n")}\n…`;
}
