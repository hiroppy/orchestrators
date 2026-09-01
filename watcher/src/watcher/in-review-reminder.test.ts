import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import { fakeSlackClient, linearTeams, withStore } from "./runner.test-support.ts";
import { sendInReviewReminder } from "./in-review-reminder.ts";

const config = {
  status: "In Review",
  afterDays: 3,
  postAt: "09:00",
  timeZone: "Asia/Tokyo",
};

describe("global In Review reminders", () => {
  it("posts stale tasks once per local day after the configured time", async () => {
    await withStore(async (store) => {
      createTask(store, "ENG-62", "2026-08-26T00:00:00.000Z", "U123");
      createTask(store, "ENG-63", "2026-08-29T00:00:00.000Z", "U456");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);

      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-08-30T23:54:00.000Z"),
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
        now: new Date("2026-08-31T00:04:00.000Z"),
      });

      const firstPost = calls.find(({ method }) => method === "postMessage");
      assert.equal(firstPost?.channel, "C123");
      assert.equal(firstPost?.unfurl_links, false);
      assert.equal(firstPost?.unfurl_media, false);
      assert.match(String(firstPost?.text), /Tasks in In Review for 3\+ days/);
      assert.match(String(firstPost?.text), /<@U123>.*example\.slack\.com.*ENG-62/s);
      assert.doesNotMatch(String(firstPost?.text), /linear\.app/);
      assert.doesNotMatch(String(firstPost?.text), /ENG-63/);

      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-09-01T00:00:00.000Z"),
      });
      const posts = calls.filter(({ method }) => method === "postMessage");
      assert.equal(posts.length, 2);
      assert.match(String(posts[1]?.text), /<@U123>.*ENG-62/s);
      assert.match(String(posts[1]?.text), /<@U456>.*ENG-63/s);
    });
  });

  it("only posts within five minutes of the configured local time", async () => {
    await withStore(async (store) => {
      createTask(store, "ENG-62", "2026-08-26T00:00:00.000Z", "U123");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);

      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-08-31T00:06:00.000Z"),
      });
      assert.equal(calls.length, 0);

      await sendInReviewReminder({
        store,
        slackClient,
        channelId: "C123",
        config,
        now: new Date("2026-09-01T23:55:00.000Z"),
      });
      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
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
      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
    });
  });

  it("keeps the daily scan marker when its anchor service becomes inactive", async () => {
    await withStore(async (store) => {
      createTask(store, "ENG-62", "2026-08-26T00:00:00.000Z", "U123");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);
      const now = new Date("2026-08-31T00:00:00.000Z");

      await sendInReviewReminder({ store, slackClient, channelId: "C123", config, now });
      store.syncDefinitions([], {});
      createTask(store, "ENG-63", "2026-08-26T00:00:00.000Z", "U456", "service-b");
      await sendInReviewReminder({ store, slackClient, channelId: "C123", config, now });

      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
    });
  });

  it("uses the configured review status in the heading", async () => {
    await withStore(async (store) => {
      createTask(store, "ENG-62", "2026-08-26T00:00:00.000Z", "U123", "service-a", "QA Review");
      const calls: Array<Record<string, unknown>> = [];

      await sendInReviewReminder({
        store,
        slackClient: fakeSlackClient(calls),
        channelId: "C123",
        config: { ...config, status: "QA Review" },
        now: new Date("2026-08-31T00:00:00.000Z"),
      });

      const post = calls.find(({ method }) => method === "postMessage");
      assert.match(String(post?.text), /Tasks in QA Review for 3\+ days/);
    });
  });

  it("uses persisted status time when the status timeline is missing", async () => {
    await withStore(async (store) => {
      store.syncDefinitions([{ name: "service-a", url: "", linearTeam: "team" }], {
        team: linearTeams(["In Progress", "In Review"])["workspace-a-eng"],
      });
      store.upsertTaskFromEvent(
        {
          type: "started",
          service: "service-a",
          issueIdentifier: "ENG-62",
          resolvedState: "In Progress",
        },
        new Date("2026-08-01T00:00:00.000Z"),
      );
      const task = store.upsertTaskFromEvent(
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          resolvedState: "In Review",
        },
        new Date("2026-08-31T00:00:00.000Z"),
      );
      store.assignTask(task.id, "U123");
      const calls: Array<Record<string, unknown>> = [];

      await sendInReviewReminder({
        store,
        slackClient: fakeSlackClient(calls),
        channelId: "C123",
        config,
        now: new Date("2026-08-31T00:00:00.000Z"),
      });

      assert.equal(calls.length, 0);
      assert.equal(store.getTask(task.id)?.statusChangedAt, "2026-08-31T00:00:00.000Z");
    });
  });
});

function createTask(
  store: WatcherStore,
  issueIdentifier: string,
  enteredReviewAt: string,
  assignee: string,
  serviceName = "service-a",
  status = "In Review",
): void {
  store.syncDefinitions([{ name: serviceName, url: "", linearTeam: "team" }], {
    team: linearTeams([status])["workspace-a-eng"],
  });
  const task = store.upsertTaskFromEvent(
    {
      type: "started",
      service: serviceName,
      issueIdentifier,
      issueTitle: `Review ${issueIdentifier}`,
      issueUrl: `https://linear.app/acme/issue/${issueIdentifier}`,
      resolvedState: status,
    },
    new Date(enteredReviewAt),
  );
  store.addEvent({
    taskId: task.id,
    type: "status_timeline",
    fromStatus: "In Progress",
    toStatus: status,
    createdAt: new Date(enteredReviewAt),
  });
  store.assignTask(task.id, assignee);
  store.setParentMessage(task.id, "C123", `${issueIdentifier.slice(4)}.000`, "summary");
}
