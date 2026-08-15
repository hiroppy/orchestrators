import assert from "node:assert/strict";
import { it } from "node:test";

import { buildStatusCard, type StatusCardEvent } from "./status-timeline.ts";

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
