import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import { fakeSlackClient, linearTeams, withStore } from "./runner.test-support.ts";
import { sendInReviewReminder } from "./in-review-reminder.ts";

const config = {
  status: "In Review",
  afterDays: 4,
  postAt: "09:00",
  timeZone: "Asia/Tokyo",
};

describe("global In Review reminders", () => {
  it("posts stale tasks once per local day after the configured time", async () => {
    await withStore(async (store) => {
      createTask(store, "ENG-62", "2026-08-26T00:00:00.000Z", "U123");
      createTask(store, "ENG-63", "2026-08-28T00:00:00.000Z", "U456");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);

      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-08-30T23:59:00.000Z"),
      });
      assert.equal(calls.length, 0);

      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-08-31T00:00:00.000Z"),
      });
      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-08-31T03:00:00.000Z"),
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.channel, "C123");
      assert.match(String(calls[0]?.text), /Tasks in In Review for 4\+ days/);
      assert.match(String(calls[0]?.text), /ENG-62.*<@U123>/);
      assert.doesNotMatch(String(calls[0]?.text), /ENG-63/);

      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-09-01T00:00:00.000Z"),
      });
      assert.equal(calls.length, 2);
      assert.match(String(calls[1]?.text), /ENG-62.*<@U123>/);
      assert.match(String(calls[1]?.text), /ENG-63.*<@U456>/);
    });
  });

  it("retries the daily post when Slack fails", async () => {
    await withStore(async (store) => {
      createTask(store, "ENG-62", "2026-08-26T00:00:00.000Z", "U123");
      const failedCalls: Array<Record<string, unknown>> = [];
      const now = new Date("2026-08-31T00:00:00.000Z");

      await assert.rejects(
        sendInReviewReminder({
          store,
          slackClient: fakeSlackClient(failedCalls, { rejectPostMessage: () => true }),
          channelId: "C123",
          config,
          now,
        }),
        /Simulated Slack failure/,
      );

      const calls: Array<Record<string, unknown>> = [];
      await sendInReviewReminder({
        store,
        slackClient: fakeSlackClient(calls),
        channelId: "C123",
        config,
        now,
      });
      assert.equal(calls.length, 1);
    });
  });
});

function createTask(
  store: WatcherStore,
  issueIdentifier: string,
  enteredReviewAt: string,
  assignee: string,
): void {
  store.syncDefinitions([{ name: "service-a", url: "", linearTeam: "team" }], {
    team: linearTeams(["In Review"])["workspace-a-eng"],
  });
  const task = store.upsertTaskFromEvent(
    {
      type: "started",
      service: "service-a",
      issueIdentifier,
      issueTitle: `Review ${issueIdentifier}`,
      issueUrl: `https://linear.app/acme/issue/${issueIdentifier}`,
      resolvedState: "In Review",
    },
    new Date(enteredReviewAt),
  );
  store.addEvent({
    taskId: task.id,
    type: "status_timeline",
    fromStatus: "In Progress",
    toStatus: "In Review",
    createdAt: new Date(enteredReviewAt),
  });
  store.assignTask(task.id, assignee);
}
