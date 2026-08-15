import assert from "node:assert/strict";
import { it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "./client-types.ts";
import { buildStatusCard, publishStatusTimeline, type StatusCardEvent } from "./status-timeline.ts";

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
  assert.equal(eventStored, false);
});
