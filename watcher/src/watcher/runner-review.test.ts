import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideReviewComment, parseReviewRequeuePendingPayload } from "./review-comments.ts";
import { requeueReviewTask } from "./review-requeue.ts";
import { runOnce } from "./runner.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher inline review comments", () => {
  it("rejects a null event in a pending notification payload", () => {
    assert.throws(
      () => parseReviewRequeuePendingPayload(JSON.stringify({ message: "requeue", event: null })),
      /Invalid review requeue pending payload/,
    );
  });
  it("requeues the first inline comment observed in review", async () => {
    await withStore(async (store) => {
      const config = runtimeConfig({
        services: [{ name: "service-a", url: "", linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: { inReviewStatus: "In Review", inProgressStatus: "In Progress" },
        statusHooks: [],
        statusTypeOverrides: {},
        defaultAssignees: [],
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      const decision = decideReviewComment(config, store, {
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
      assert.equal(decision.commentAt, "2999-01-01T00:00:00.000Z");
    });
  });

  it("does not requeue without an authoritative Linear state", async () => {
    await withStore(async (store) => {
      const config = runtimeConfig({
        services: [{ name: "service-a", url: "", linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: { inReviewStatus: "In Review", inProgressStatus: "In Progress" },
      });
      store.syncDefinitions(config.services, config.linearTeams);

      const decision = decideReviewComment(config, store, {
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
      const config = runtimeConfig({
        services: [{ name: "service-a", url: "", linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: { inReviewStatus: "In Review", inProgressStatus: "In Progress" },
        statusHooks: [],
        statusTypeOverrides: {},
        defaultAssignees: [],
      });
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

      const decision = decideReviewComment(config, store, {
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
      const config = runtimeConfig({
        services: [{ name: "service-a", url: "", linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: { inReviewStatus: "In Review", inProgressStatus: "In Progress" },
        statusHooks: [],
        statusTypeOverrides: {},
        defaultAssignees: [],
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const decision = decideReviewComment(config, store, {
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
      const config = runtimeConfig({
        services: [{ name: "service-a", url: "", linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: { inReviewStatus: "In Review", inProgressStatus: "In Progress" },
        statusHooks: [],
        statusTypeOverrides: {},
        defaultAssignees: [],
      });
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
        decision: { shouldRequeue: true, commentAt: "2026-08-15T00:00:00.000Z" },
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

  it("checks for new comments while an In Review task remains in the snapshot", async (context) => {
    await withStore(async (store) => {
      const snapshot = {
        running: [{ issue_identifier: "ENG-62", state: "In Review" }],
        retrying: [],
        blocked: [],
      };
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
              attachments: { nodes: [{ url: "https://github.com/acme/example/pull/42" }] },
              relations: { nodes: [] },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [{ name: "service-a", url: dataUrl(snapshot), linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: { inReviewStatus: "In Review", inProgressStatus: "In Progress" },
      });
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
});
