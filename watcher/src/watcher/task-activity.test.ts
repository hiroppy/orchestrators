import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTaskActivity, isTaskActivityUpdateDue } from "./task-activity.ts";

describe("task activity", () => {
  it("preserves Symphony's activity message", async () => {
    const activity = await buildTaskActivity({
      last_message: "item started: command execution (rs_example)",
      last_event_at: "2026-08-16T01:18:33Z",
    });

    assert.equal(activity.message, "item started: command execution (rs_example)");
    assert.deepEqual(activity.changedFiles, []);
  });

  it("falls back to the last event and then to Running", async () => {
    const fromEvent = await buildTaskActivity({ last_event: "retrying" });
    assert.equal(fromEvent.message, "retrying");

    const fallback = await buildTaskActivity({});
    assert.equal(fallback.message, "Running");
  });

  it("updates at the 15-second boundary", () => {
    const publishedAt = "2026-08-16T01:00:00.000Z";

    assert.equal(isTaskActivityUpdateDue(undefined, new Date(publishedAt)), true);
    assert.equal(isTaskActivityUpdateDue(publishedAt, new Date("2026-08-16T01:00:14.999Z")), false);
    assert.equal(isTaskActivityUpdateDue(publishedAt, new Date("2026-08-16T01:00:15.000Z")), true);
  });
});
