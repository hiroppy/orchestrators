import assert from "node:assert/strict";
import { it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import type { TaskEvent } from "../domain/task.ts";
import type { SlackClient } from "./client-types.ts";
import {
  buildStatusCard,
  deliverPendingStatusTimelines,
  publishStatusTimeline,
  type StatusCardEvent,
} from "./status-timeline.ts";

it("shows the current transition and ten newest history entries", () => {
  const generatedEvents = Array.from({ length: 12 }, (_, index): StatusCardEvent => ({
    fromStatus: `Status ${index}`,
    toStatus: `Status ${index + 1}`,
    occurredAt: new Date(2026, 7, 15, index).toISOString(),
    source: { type: "automatic", label: "Updated" },
  })).reverse();
  const [latest, ...history] = generatedEvents;
  assert.ok(latest);

  const blocks = buildStatusCard({ events: [latest, ...history], facts: {} });
  const timeline = JSON.stringify(blocks.at(-1));

  assert.match(timeline, /Status 11 → Status 12/);
  assert.match(timeline, /Status 10 → Status 11/);
  assert.match(timeline, /Status 1 → Status 2/);
  assert.doesNotMatch(timeline, /Status 0 → Status 1/);
});

it("includes the current status in the timeline when there is no history", () => {
  const occurredAt = new Date(2026, 7, 15, 12).toISOString();
  const blocks = buildStatusCard({
    events: [
      {
        fromStatus: "Todo",
        toStatus: "In Progress",
        occurredAt,
        source: { type: "automatic", label: "Started" },
      },
    ],
    facts: {},
  });
  const rendered = JSON.stringify(blocks);

  assert.match(rendered, /\*Event\*\\nStarted/);
  assert.match(rendered, /\*Updated at\*\\n`12:00`/);
  assert.match(rendered, /\*Timeline\*\\n12:00.*Todo → In Progress/);
  assert.doesNotMatch(rendered, /Assignees/);
});

it("omits events that do not change the status from the timeline", () => {
  const blocks = buildStatusCard({
    events: [
      {
        fromStatus: "Todo",
        toStatus: "Todo",
        occurredAt: "2026-08-15T12:00:00.000Z",
        source: { type: "automatic", label: "Updated" },
      },
      {
        fromStatus: "Backlog",
        toStatus: "Todo",
        occurredAt: "2026-08-15T11:00:00.000Z",
        source: { type: "automatic", label: "Queued" },
      },
      {
        fromStatus: "Backlog",
        toStatus: "Backlog",
        occurredAt: "2026-08-15T10:00:00.000Z",
        source: { type: "automatic", label: "Observed" },
      },
    ],
    facts: {},
  });
  const timeline = JSON.stringify(blocks.at(-1));

  assert.match(timeline, /Backlog → Todo/);
  assert.doesNotMatch(timeline, /Todo → Todo/);
  assert.doesNotMatch(timeline, /Backlog → Backlog/);
});

it("shows concise current activity and truncates the changed-file list upstream", () => {
  const blocks = buildStatusCard({
    events: [
      {
        fromStatus: "Todo",
        toStatus: "In Progress",
        occurredAt: "2026-08-16T01:00:00.000Z",
        source: { type: "automatic", label: "Started" },
      },
    ],
    facts: {
      pullRequest: {
        url: "https://github.com/example/app/pull/42",
        number: 42,
        title: "Show live activity",
      },
      activity: {
        message: "Running tests",
        changedFiles: ["views.ts", "views.test.ts", "runner.ts"],
        changedFileCount: 5,
        additions: 42,
        deletions: 8,
      },
    },
  });
  const rendered = JSON.stringify(blocks);

  assert.match(rendered, /\*Current activity\*\\nRunning tests/);
  assert.match(rendered, /views\.ts.*views\.test\.ts.*runner\.ts.*\+2 more/);
  assert.ok(rendered.indexOf("Current activity") < rendered.indexOf("PR#42"));
});

it("rejects a new timeline card when Slack omits its timestamp", async () => {
  let eventStored = false;
  const store = {
    getTask: () => ({
      id: "service-a:ENG-62",
      parentChannelId: "C123",
      parentMessageTs: "10.000",
    }),
    getLatestDeliveredEventsByType: () => [],
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
    getLatestDeliveredEventsByType: () => [],
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

it("reuses the delivered anchor when newer pending events exceed the history limit", async () => {
  const event = storedTimelineEvent();
  const pendingEvents = Array.from({ length: 11 }, (_, index): TaskEvent => ({
    ...storedTimelineEvent(),
    id: event.id + index + 1,
    createdAt: new Date(Date.parse(event.createdAt) + (index + 1) * 1_000).toISOString(),
  }));
  const deliveredEvent = {
    ...storedTimelineEvent(),
    id: 1,
    slackThreadTs: "20.000",
    createdAt: "2026-08-15T11:00:00Z",
  };
  let updates = 0;
  let posts = 0;
  const store = {
    getTask: () => ({
      id: event.taskId,
      parentChannelId: "C123",
      parentMessageTs: "10.000",
    }),
    getLatestEventsByType: () => [event, ...pendingEvents],
    getLatestDeliveredEventsByType: () => [deliveredEvent],
    getTaskAssignees: () => [],
    addEvent: () => event,
    setTaskEventSlackThreadTs: () => undefined,
  } as unknown as WatcherStore;
  const client = {
    chat: {
      update: async ({ ts }: { ts: string }) => {
        assert.equal(ts, deliveredEvent.slackThreadTs);
        updates += 1;
        return { ok: true };
      },
      postMessage: async () => {
        posts += 1;
        return { ok: true, ts: "duplicate.000" };
      },
    },
  } as unknown as SlackClient;

  await publishStatusTimeline(client, store, {
    taskId: event.taskId,
    fallbackText: event.body!,
    event: {
      fromStatus: event.fromStatus!,
      toStatus: event.toStatus!,
      occurredAt: event.createdAt,
      source: { type: "automatic", label: event.statusEventLabel! },
    },
  });

  assert.equal(updates, 1);
  assert.equal(posts, 0);
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
