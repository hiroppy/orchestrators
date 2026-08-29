import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import type { PullRequest } from "../domain/github.ts";
import { decideReviewRequeue, parseReviewRequeuePendingPayload } from "./review-comments.ts";
import { requeueReviewTask } from "./review-requeue.ts";
import { runOnce } from "./run-once.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

function reviewConfig(url = "") {
  return runtimeConfig({
    services: [{ name: "service-a", url, linearTeam: "workspace-a-eng" }],
    linearTeams: linearTeams(["In Progress", "In Review"]),
    reviewComment: { inReviewStatus: "In Review", inProgressStatus: "In Progress" },
  });
}

describe("watcher review requeue", () => {
  it("rejects a null event in a pending notification payload", () => {
    assert.throws(
      () => parseReviewRequeuePendingPayload(JSON.stringify({ message: "requeue", event: null })),
      /Invalid review requeue pending payload/,
    );
  });
  it("requeues the first inline comment observed in review", async () => {
    await withStore(async (store) => {
      const config = reviewConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      const decision = decideReviewRequeue(config, store, {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          latestReviewCommentAt: "2999-01-01T00:00:00.000Z",
        },
      });

      assert.deepEqual(decision, {
        shouldRequeue: true,
        reason: "review-comment",
        commentAt: "2999-01-01T00:00:00.000Z",
      });
    });
  });

  it("requeues a merge conflict observed in review", async () => {
    await withStore(async (store) => {
      const decision = decideReviewRequeue(reviewConfig(), store, {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          mergeable: "CONFLICTING",
        },
      });

      assert.deepEqual(decision, { shouldRequeue: true, reason: "merge-conflict" });
    });
  });

  it("does not requeue a merge conflict outside review", async () => {
    await withStore(async (store) => {
      const decision = decideReviewRequeue(reviewConfig(), store, {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Progress",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          mergeable: "CONFLICTING",
        },
      });

      assert.deepEqual(decision, { shouldRequeue: false });
    });
  });

  it("does not requeue without an authoritative Linear state", async () => {
    await withStore(async (store) => {
      const config = reviewConfig();
      store.syncDefinitions(config.services, config.linearTeams);

      const decision = decideReviewRequeue(config, store, {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          latestReviewCommentAt: "2999-01-01T00:00:00.000Z",
        },
      });

      assert.equal(decision.shouldRequeue, false);
    });
  });

  it("ignores the latest comment after it has been handled", async () => {
    await withStore(async (store) => {
      const config = reviewConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      store.addEvent({
        taskId: "service-a:ENG-62",
        type: "review_comment_handled",
        body: "2000-01-01T00:00:00.000Z",
      });

      const decision = decideReviewRequeue(config, store, {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          latestReviewCommentAt: "2000-01-01T00:00:00.000Z",
        },
      });

      assert.equal(decision.shouldRequeue, false);
    });
  });

  it("requeues a comment that arrives before the watcher first observes In Review", async () => {
    await withStore(async (store) => {
      const config = reviewConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const decision = decideReviewRequeue(config, store, {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          latestReviewCommentAt: "2999-01-01T00:00:00.000Z",
        },
      });

      assert.equal(decision.shouldRequeue, true);
    });
  });

  it("updates Linear and the stored task after a new inline comment", async () => {
    await withStore(async (store) => {
      const config = reviewConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      store.setParentMessage("service-a:ENG-62", "C123", "1.000", "{}");
      const updates: string[] = [];

      await requeueReviewTask({
        config,
        store,
        slackClient: fakeSlackClient([]),
        watcherChannelId: "C123",
        event: {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          resolvedState: "In Review",
        },
        decision: {
          shouldRequeue: true,
          reason: "review-comment",
          commentAt: "2026-08-15T00:00:00.000Z",
        },
        updateLinearStatus: async (_identifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, ["In Progress"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
      assert.equal(
        store.getLatestEvent("service-a:ENG-62", "review_comment_handled")?.body,
        "2026-08-15T00:00:00.000Z",
      );
    });
  });

  it("updates Linear after a merge conflict and handles a concurrent comment", async () => {
    await withStore(async (store) => {
      const config = reviewConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      store.setParentMessage("service-a:ENG-62", "C123", "1.000", "{}");
      const updates: string[] = [];
      const event = {
        type: "updated" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          mergeable: "CONFLICTING",
          latestReviewCommentAt: "2026-08-15T00:00:00.000Z",
        },
      };
      const decision = decideReviewRequeue(config, store, event);

      assert.deepEqual(decision, {
        shouldRequeue: true,
        reason: "merge-conflict",
        commentAt: "2026-08-15T00:00:00.000Z",
      });

      await requeueReviewTask({
        config,
        store,
        slackClient: fakeSlackClient([]),
        watcherChannelId: "C123",
        event,
        decision,
        updateLinearStatus: async (_identifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, ["In Progress"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
      assert.equal(
        store.getLatestEvent("service-a:ENG-62", "review_comment_handled")?.body,
        "2026-08-15T00:00:00.000Z",
      );
      assert.deepEqual(
        decideReviewRequeue(config, store, {
          ...event,
          pullRequest: { ...event.pullRequest, mergeable: "MERGEABLE" },
        }),
        { shouldRequeue: false },
      );
      const pending = store.getLatestEvent(
        "service-a:ENG-62",
        "review_requeue_notification_pending",
      );
      assert.match(pending?.body ?? "", /Merge conflict detected/);
    });
  });

  it("identifies the issue and transition when a comment requeue fails", async () => {
    await withStore(async (store) => {
      const config = reviewConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });

      await assert.rejects(
        requeueReviewTask({
          config,
          store,
          slackClient: fakeSlackClient([]),
          watcherChannelId: "C123",
          event: {
            type: "updated",
            service: "service-a",
            issueIdentifier: "ENG-62",
            resolvedState: "In Review",
          },
          decision: {
            shouldRequeue: true,
            reason: "review-comment",
            commentAt: "2026-08-15T00:00:00.000Z",
          },
          updateLinearStatus: async () => {
            throw new Error("Linear returned HTTP 400. Linear GraphQL error: invalid state");
          },
        }),
        {
          message: "Failed to requeue ENG-62 from In Review to In Progress.",
          cause: new Error("Linear returned HTTP 400. Linear GraphQL error: invalid state"),
        },
      );
    });
  });

  it("checks for new comments while an In Review task remains in the snapshot", async (context) => {
    await withStore(async (store) => {
      const snapshot = {
        running: [{ issue_identifier: "ENG-62", state: "In Review" }],
        retrying: [],
        blocked: [],
      };
      mockInReviewIssue(context, "https://github.com/acme/example/pull/42");
      const config = reviewConfig(dataUrl(snapshot));
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": snapshot });
      const task = store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const updates: string[] = [];

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        findPullRequestByUrl: async (url) => ({
          url,
          number: 42,
          title: "Review me",
          latestReviewCommentAt: "2026-08-15T00:00:00.000Z",
        }),
        updateLinearStatus: async (_identifier, status) => updates.push(status),
      });

      assert.deepEqual(updates, ["In Progress"]);
      assert.equal(store.getTask(task.id)?.status, "In Progress");
    });
  });

  it("stores a replacement pull request while the task remains In Review", async (context) => {
    await withStore(async (store) => {
      const snapshot = {
        running: [{ issue_identifier: "ENG-62", state: "In Review" }],
        retrying: [],
        blocked: [],
      };
      mockInReviewIssue(context, "https://github.com/acme/example/pull/42");
      const config = reviewConfig(dataUrl(snapshot));
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": snapshot });
      const task = store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
        resolvedStateType: "started",
        pullRequest: { url: "https://github.com/acme/example/pull/41", labels: ["old"] },
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");

      const observations: Array<PullRequest | null> = [
        null,
        {
          url: "https://github.com/acme/example/pull/42",
          number: 42,
          title: "Replacement PR",
          labels: ["ready"],
        },
      ];
      const run = () =>
        runOnce({
          config,
          store,
          slackClient: fakeSlackClient([]),
          slackChannelId: "C123",
          findPullRequestByUrl: async () => observations.shift() ?? null,
        });

      await run();
      assert.deepEqual(store.getTask(task.id)?.pullRequest, {
        url: "https://github.com/acme/example/pull/42",
        number: 42,
        labels: [],
      });

      await run();

      assert.deepEqual(store.getTask(task.id)?.pullRequest, {
        url: "https://github.com/acme/example/pull/42",
        number: 42,
        title: "Replacement PR",
        labels: ["ready"],
      });
      assert.equal(store.getTask(task.id)?.status, "In Review");
    });
  });
});

function mockInReviewIssue(context: TestContext, pullRequestUrl: string): void {
  const nativeFetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).startsWith("data:")) return nativeFetch(url, options);
    const { query } = JSON.parse(String(options?.body)) as { query: string };
    if (query.includes("OrchestratorWatcherIssueStateBatch")) {
      return Response.json({
        data: {
          issue0: { identifier: "ENG-62", state: { name: "In Review", type: "started" } },
        },
      });
    }
    return Response.json({
      data: {
        issue: {
          id: "linear-62",
          identifier: "ENG-62",
          title: "Review me",
          state: { name: "In Review", type: "started" },
          attachments: { nodes: [{ url: pullRequestUrl }] },
          relations: { nodes: [] },
        },
      },
    });
  });
}
