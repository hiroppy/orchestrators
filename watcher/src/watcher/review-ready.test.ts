import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fakeSlackClient, linearTeams, withStore } from "./runner.test-support.ts";
import {
  checkReviewReadyNotification,
  REVIEW_READY_DELAY_MS,
  REVIEW_READY_NOTIFIED_EVENT,
} from "./review-ready.ts";

describe("review-ready notifications", () => {
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
});
