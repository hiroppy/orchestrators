import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideReviewComment } from "./review-comments.ts";
import { requeueReviewTask } from "./review-requeue.ts";
import { fakeSlackClient, linearTeams, runtimeConfig, withStore } from "./runner.test-support.ts";

describe("watcher inline review comments", () => {
  it("requeues when the latest inline comment is newer than the In Review transition", async () => {
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
        type: "updated",
        fromStatus: "In Progress",
        toStatus: "In Review",
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

  it("ignores comments that predate the latest In Review transition", async () => {
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
        type: "updated",
        fromStatus: "In Progress",
        toStatus: "In Review",
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
        decision: { shouldRequeue: true },
        updateLinearStatus: async (_identifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, ["In Progress"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
    });
  });
});
