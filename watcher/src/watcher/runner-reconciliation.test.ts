import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileSlackStatusTransition } from "./reconcile-slack-status.ts";
import { checkReviewReadyNotification, REVIEW_READY_DELAY_MS } from "./review-ready.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher status transition reconciliation", () => {
  it("restarts the review-ready window after manual status transitions", async (context) => {
    await withStore(async (store) => {
      let linearState = "In Progress";
      context.mock.method(globalThis, "fetch", async () =>
        Response.json({
          data: {
            issue:
              linearState === "In Progress"
                ? null
                : {
                    identifier: "ENG-62",
                    title: "Review the pull request",
                    state: { name: linearState, type: "started" },
                    url: "https://linear.app/example/issue/ENG-62/example",
                    attachments: {
                      nodes: [{ url: "https://github.com/acme/example/pull/42" }],
                    },
                    relations: { nodes: [] },
                  },
          },
        }),
      );
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Review the pull request",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);
      const transitionManually = async (status: string) => {
        linearState = status;
        const { task: updatedTask } = store.updateTaskStatusAtomically(
          task.id,
          status,
          () => undefined,
        );
        await reconcileSlackStatusTransition({
          config,
          store,
          slackClient,
          slackChannelId: "C123",
          task: updatedTask,
        });
        return updatedTask;
      };
      const pullRequest = {
        url: "https://github.com/acme/example/pull/42",
        state: "OPEN",
        isDraft: false,
        headRefOid: "abcdef123456",
      };

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      await transitionManually("In Progress");
      const backInReview = await transitionManually("In Review");
      const reenteredAt = new Date("2026-08-16T00:00:00.000Z");
      await checkReviewReadyNotification({
        store,
        slackClient,
        task: backInReview,
        inReviewStatus: "In Review",
        pullRequest,
        now: reenteredAt,
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task: backInReview,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(reenteredAt.getTime() + REVIEW_READY_DELAY_MS - 1),
      });

      assert.equal(
        calls.filter(({ text }) => String(text).startsWith("Ready for review:")).length,
        0,
      );
    });
  });

  it("announces a Symphony terminal override immediately after a Slack status change", async (context) => {
    await withStore(async (store) => {
      context.mock.method(globalThis, "fetch", async () =>
        Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "Ready for Release", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
              relations: {
                nodes: [
                  {
                    type: "blocks",
                    relatedIssue: {
                      identifier: "ENG-63",
                      title: "Already ready for release",
                      state: { name: "Ready for Release", type: "started" },
                    },
                  },
                  {
                    type: "blocks",
                    relatedIssue: {
                      identifier: "ENG-64",
                      title: "Start the follow-up",
                      state: { name: "In Review", type: "started" },
                    },
                  },
                  {
                    type: "blocks",
                    relatedIssue: {
                      identifier: "ENG-65",
                      title: "Still active by policy",
                      state: { name: "In Progress", type: "completed" },
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            activeStates: ["In Progress"],
            terminalStates: ["Done", "Ready for Release"],
          },
        ],
        linearTeams: linearTeams(["In Review", "Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const { task: closedTask } = store.updateTaskStatusAtomically(
        task.id,
        "Ready for Release",
        () => undefined,
      );
      const calls: Array<Record<string, unknown>> = [];

      await reconcileSlackStatusTransition({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        task: closedTask,
      });

      assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *Ready for Release*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
      );
      const relatedMessage = calls.find(
        ({ method, thread_ts }) => method === "postMessage" && thread_ts,
      )?.text;
      assert.match(String(relatedMessage), /ENG-64.*Start the follow-up/);
      assert.match(String(relatedMessage), /ENG-65.*Still active by policy/);
      assert.doesNotMatch(String(relatedMessage), /ENG-63|Already ready for release/);
    });
  });
});
