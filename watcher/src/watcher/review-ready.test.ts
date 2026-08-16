import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import { fakeSlackClient, linearTeams, withStore } from "./runner.test-support.ts";
import {
  checkReviewReadyNotification,
  checkReviewReadyNotificationSafely,
  REVIEW_READY_DELAY_MS,
  REVIEW_READY_NOTIFIED_EVENT,
} from "./review-ready.ts";

describe("review-ready notifications", () => {
  it("uses the configured review-ready delay", async () => {
    await withStore(async (store) => {
      const { calls, firstSeen, pullRequest, slackClient, task } = setupReviewReadyTask(store);
      const delayMs = 5_000;

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        delayMs,
        now: firstSeen,
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        delayMs,
        now: new Date(firstSeen.getTime() + delayMs - 1),
      });
      assert.equal(calls.length, 0);

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        delayMs,
        now: new Date(firstSeen.getTime() + delayMs),
      });

      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
    });
  });

  it("mentions assignees once after the same review SHA is quiet for 20 minutes", async () => {
    await withStore(async (store) => {
      store.syncDefinitions([{ name: "service-a", url: "", linearTeam: "team" }], {
        team: linearTeams(["In Review"])["workspace-a-eng"],
      });
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);
      const pullRequest = {
        url: "https://github.com/acme/example/pull/42",
        state: "OPEN",
        isDraft: false,
        headRefOid: "abcdef123456",
      };
      const firstSeen = new Date("2026-01-01T00:00:00.000Z");

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: firstSeen,
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS - 1),
      });
      assert.equal(calls.length, 0);

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS),
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS * 2),
      });

      const notifications = calls.filter(({ method }) => method === "postMessage");
      assert.equal(notifications.length, 1);
      assert.match(String(notifications[0]?.text), /<@U123>/);
      assert.equal(
        store.countEventsWithBody(
          task.id,
          REVIEW_READY_NOTIFIED_EVENT,
          `${pullRequest.url}#${pullRequest.headRefOid}`,
        ),
        1,
      );
    });
  });

  it("restarts the quiet window when the SHA changes", async () => {
    await withStore(async (store) => {
      store.syncDefinitions([{ name: "service-a", url: "", linearTeam: "team" }], {
        team: linearTeams(["In Review"])["workspace-a-eng"],
      });
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);
      const firstSeen = new Date("2026-01-01T00:00:00.000Z");
      const base = {
        url: "https://github.com/acme/example/pull/42",
        state: "OPEN",
        isDraft: false,
      };

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest: { ...base, headRefOid: "old-sha" },
        now: firstSeen,
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest: { ...base, headRefOid: "new-sha" },
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS),
      });

      assert.equal(calls.length, 0);
    });
  });

  it("restarts the quiet window after leaving review", async () => {
    await withStore(async (store) => {
      store.syncDefinitions([{ name: "service-a", url: "", linearTeam: "team" }], {
        team: linearTeams(["In Progress", "In Review"])["workspace-a-eng"],
      });
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);
      const pullRequest = {
        url: "https://github.com/acme/example/pull/42",
        state: "OPEN",
        isDraft: false,
        headRefOid: "abcdef123456",
      };
      const firstSeen = new Date("2026-01-01T00:00:00.000Z");

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: firstSeen,
      });
      const { task: inProgress } = store.updateTaskStatusAtomically(
        task.id,
        "In Progress",
        () => undefined,
      );
      await checkReviewReadyNotification({
        store,
        slackClient,
        task: inProgress,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS),
      });
      const { task: backInReview } = store.updateTaskStatusAtomically(
        task.id,
        "In Review",
        () => undefined,
      );
      await checkReviewReadyNotification({
        store,
        slackClient,
        task: backInReview,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS * 2),
      });

      assert.equal(calls.length, 0);
    });
  });

  it("preserves the quiet window while pull request metadata is unavailable", async () => {
    await withStore(async (store) => {
      const { calls, firstSeen, pullRequest, slackClient, task } = setupReviewReadyTask(store);

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: firstSeen,
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest: undefined,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS - 1),
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS),
      });

      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
    });
  });

  it("restarts the quiet window after the pull request becomes a draft", async () => {
    await withStore(async (store) => {
      const { calls, firstSeen, pullRequest, slackClient, task } = setupReviewReadyTask(store);

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: firstSeen,
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest: { ...pullRequest, isDraft: true },
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS),
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS * 2),
      });
      assert.equal(calls.length, 0);

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS * 3),
      });
      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
    });
  });

  it("completes pending events superseded by a new head SHA", async (context) => {
    await withStore(async (store) => {
      const { firstSeen, pullRequest, task } = setupReviewReadyTask(store);
      const failingSlackClient = fakeSlackClient([], {
        rejectPostMessage: () => true,
      });
      context.mock.method(console, "error", () => undefined);

      await checkReviewReadyNotification({
        store,
        slackClient: failingSlackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: firstSeen,
      });
      await checkReviewReadyNotification({
        store,
        slackClient: failingSlackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS),
      });

      const revisedPullRequest = { ...pullRequest, headRefOid: "fedcba654321" };
      const successfulCalls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(successfulCalls);
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest: revisedPullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS + 1),
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest: revisedPullRequest,
        now: new Date(firstSeen.getTime() + REVIEW_READY_DELAY_MS * 2 + 1),
      });

      assert.equal(successfulCalls.filter(({ method }) => method === "postMessage").length, 1);
      assert.equal(
        store.getUncompletedEvents(
          "review_ready_notification_pending",
          "review_ready_notification_delivered",
          task.id,
        ).length,
        0,
      );
    });
  });

  it("isolates notification state failures from the caller", async (context) => {
    await withStore(async (store) => {
      const { pullRequest, slackClient, task } = setupReviewReadyTask(store);
      const errors: unknown[] = [];
      context.mock.method(console, "error", (message: unknown) => {
        errors.push(message);
      });
      context.mock.method(store, "hasEvent", () => {
        throw new Error("Simulated store failure");
      });

      await checkReviewReadyNotificationSafely({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
      });

      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /Review-ready notification check failed/);
    });
  });
});

function setupReviewReadyTask(store: WatcherStore) {
  store.syncDefinitions([{ name: "service-a", url: "", linearTeam: "team" }], {
    team: linearTeams(["In Review"])["workspace-a-eng"],
  });
  const task = store.upsertTaskFromEvent({
    type: "started",
    service: "service-a",
    issueIdentifier: "ENG-62",
    resolvedState: "In Review",
  });
  store.setParentMessage(task.id, "C123", "1.000", "{}");
  store.assignTask(task.id, "U123");
  const calls: Array<Record<string, unknown>> = [];

  return {
    calls,
    firstSeen: new Date("2026-01-01T00:00:00.000Z"),
    pullRequest: {
      url: "https://github.com/acme/example/pull/42",
      state: "OPEN",
      isDraft: false,
      headRefOid: "abcdef123456",
    },
    slackClient: fakeSlackClient(calls),
    task,
  };
}
