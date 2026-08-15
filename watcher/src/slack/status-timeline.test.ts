import assert from "node:assert/strict";
import { it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import type { TaskEvent } from "../domain/types.ts";
import type { SlackClient } from "./client-types.ts";
import {
  buildStatusCard,
  deliverPendingStatusTimelines,
  publishStatusTimeline,
  type StatusCardEvent,
} from "./status-timeline.ts";

it("keeps the ten newest status timeline entries", () => {
  const generatedEvents = Array.from({ length: 12 }, (_, index): StatusCardEvent => ({
    fromStatus: `Status ${index}`,
    toStatus: `Status ${index + 1}`,
    occurredAt: new Date(2026, 7, 15, index).toISOString(),
    source: { type: "automatic", label: "Updated" },
  })).reverse();
  const [latest, ...history] = generatedEvents;
  assert.ok(latest);

  const blocks = buildStatusCard({ events: [latest, ...history], facts: { assignees: [] } });
  const timeline = JSON.stringify(blocks.at(-1));

  assert.match(timeline, /Status 10 → Status 11/);
  assert.match(timeline, /Status 1 → Status 2/);
  assert.doesNotMatch(timeline, /Status 0 → Status 1/);
});

it("rejects a new timeline card when Slack omits its timestamp", async () => {
  let eventStored = false;
  const store = {
    getTask: () => ({
      id: "service-a:ENG-62",
      parentChannelId: "C123",
      parentMessageTs: "10.000",
    }),
    getLatestEventsByType: () => [],
    getTaskAssignees: () => [],
    addEvent: () => {
      eventStored = true;
      return storedTimelineEvent();
    },
  } as unknown as WatcherStore;
  const client = {
    chat: { postMessage: async () => ({ ok: true }) },
  } as unknown as SlackClient;

  await assert.rejects(
    publishStatusTimeline(client, store, {
      taskId: "service-a:ENG-62",
      fallbackText: "Todo → In Progress",
      event: {
        fromStatus: "Todo",
        toStatus: "In Progress",
        occurredAt: "2026-08-15T12:00:00Z",
        source: { type: "automatic", label: "Started" },
      },
    }),
    /Slack did not return ts/,
  );
  assert.equal(eventStored, true);
});

it("recovers after Slack succeeds but recording its timestamp fails", async () => {
  const event = storedTimelineEvent();
  const clientMessageIds: string[] = [];
  let failPersistence = true;
  let delivered = false;
  const store = {
    getTask: () => ({
      id: event.taskId,
      parentChannelId: "C123",
      parentMessageTs: "10.000",
    }),
    getLatestEventsByType: () => [event],
    getTaskAssignees: () => [],
    addEvent: () => event,
    getUndeliveredStatusTimelineEvents: () => (delivered ? [] : [event]),
    setTaskEventSlackThreadTs: () => {
      if (failPersistence) {
        failPersistence = false;
        throw new Error("simulated persistence failure");
      }
      delivered = true;
    },
  } as unknown as WatcherStore;
  const client = {
    chat: {
      postMessage: async ({ client_msg_id }: { client_msg_id?: string }) => {
        clientMessageIds.push(String(client_msg_id));
        return { ok: true, ts: "20.000" };
      },
    },
  } as unknown as SlackClient;

  await assert.rejects(
    publishStatusTimeline(client, store, {
      taskId: event.taskId,
      fallbackText: event.body!,
      event: {
        fromStatus: event.fromStatus!,
        toStatus: event.toStatus!,
        occurredAt: event.createdAt,
        source: { type: "automatic", label: event.statusEventLabel! },
      },
    }),
    /simulated persistence failure/,
  );
  await deliverPendingStatusTimelines(client, store);

  assert.equal(delivered, true);
  assert.equal(clientMessageIds.length, 2);
  assert.equal(clientMessageIds[0], clientMessageIds[1]);
  assert.match(
    clientMessageIds[0]!,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

function storedTimelineEvent(): TaskEvent {
  return {
    id: 42,
    taskId: "service-a:ENG-62",
    type: "status_timeline",
    actor: "watcher",
    statusEventType: "automatic",
    statusEventLabel: "Started",
    fromStatus: "Todo",
    toStatus: "In Progress",
    body: "Todo → In Progress",
    createdAt: "2026-08-15T12:00:00Z",
  };
}
