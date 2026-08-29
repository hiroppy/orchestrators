import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequest } from "../domain/github.ts";
import { runOnce } from "./run-once.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";
import { runPullRequestMonitors } from "./pull-request-monitors.ts";

describe("pull request monitors", () => {
  it("uses the first observation as an in-memory baseline and reports later changes once", async () => {
    await withStore(async (store) => {
      const calls: Array<Record<string, unknown>> = [];
      const observed: PullRequest[] = [
        pullRequest({ labels: ["review"], checkStatus: "IN_PROGRESS" }),
        pullRequest({ labels: ["review", "ready"], checkStatus: "COMPLETED" }),
        {
          url: "https://github.com/example/repository/pull/42",
          labels: ["review", "ready"],
        },
        pullRequest({ labels: ["review", "ready"], checkStatus: "COMPLETED" }),
      ];
      let monitorRuns = 0;
      const service = {
        name: "service-a",
        url: "http://localhost:4101/api/v1/state",
        linearTeam: "workspace-a-eng",
        monitors: [
          {
            id: "review-progress",
            run: ({ pullRequest: current, previousPullRequest: previous }) => {
              monitorRuns += 1;
              const messages: string[] = [];
              if (!previous.labels?.includes("ready") && current.labels?.includes("ready")) {
                messages.push("ready label added");
              }
              const oldCheck = previous.checks?.find(({ name }) => name === "test");
              const newCheck = current.checks?.find(({ name }) => name === "test");
              if (oldCheck?.status !== "COMPLETED" && newCheck?.status === "COMPLETED") {
                messages.push("test completed");
              }
              return messages.length > 0 ? messages.join("\n") : undefined;
            },
          },
        ],
      };
      const teams = linearTeams(["Todo", "In Review", "Done"]);
      store.syncDefinitions([service], teams);
      const task = store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-42",
        issueTitle: "Monitor the pull request",
        state: "In Review",
        resolvedState: "In Review",
        pullRequest: observed[0],
      });
      store.setParentMessage(task.id, "C123", "100.001", "summary");

      const options = {
        config: runtimeConfig({ services: [service], linearTeams: teams }),
        store,
        slackClient: fakeSlackClient(calls),
        watcherChannelId: "CWATCHER",
        inReviewStatus: "In Review",
        state: new Map(),
        findPullRequestByUrl: async () => observed.shift() ?? null,
      };

      await runPullRequestMonitors(options);
      await runPullRequestMonitors(options);
      await runPullRequestMonitors(options);
      await runPullRequestMonitors(options);
      await runPullRequestMonitors(options);

      assert.equal(monitorRuns, 3);
      assert.deepEqual(calls, [
        {
          method: "postMessage",
          channel: "C123",
          thread_ts: "100.001",
          text: "ready label added\ntest completed",
        },
      ]);
    });
  });

  it("starts a fresh baseline when the observed pull request changes", async () => {
    await withStore(async (store) => {
      const observed: PullRequest[] = [
        pullRequest({ labels: ["review"], checkStatus: "COMPLETED" }),
        {
          url: "https://github.com/example/repository/pull/43",
          labels: ["review"],
        },
      ];
      const currentChecks: Array<PullRequest["checks"]> = [];
      const service = {
        name: "service-a",
        url: "http://localhost:4101/api/v1/state",
        linearTeam: "workspace-a-eng",
        monitors: [
          {
            id: "checks",
            run: ({ pullRequest: current }) => {
              currentChecks.push(current.checks);
            },
          },
        ],
      };
      const teams = linearTeams(["Todo", "In Review", "Done"]);
      store.syncDefinitions([service], teams);
      const task = store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-42",
        issueTitle: "Monitor the pull request",
        state: "In Review",
        resolvedState: "In Review",
        pullRequest: observed[0],
      });
      store.setParentMessage(task.id, "C123", "100.001", "summary");

      const options = {
        config: runtimeConfig({ services: [service], linearTeams: teams }),
        store,
        slackClient: fakeSlackClient([]),
        watcherChannelId: "CWATCHER",
        inReviewStatus: "In Review",
        state: new Map(),
        findPullRequestByUrl: async () => observed.shift() ?? null,
      };

      await runPullRequestMonitors(options);
      await runPullRequestMonitors(options);

      assert.deepEqual(currentChecks, []);
    });
  });

  it("stops monitoring outside the configured review status and resets the baseline", async () => {
    await withStore(async (store) => {
      let fetches = 0;
      let monitorRuns = 0;
      const service = {
        name: "service-a",
        url: "http://localhost:4101/api/v1/state",
        linearTeam: "workspace-a-eng",
        monitors: [
          {
            id: "checks",
            run: () => {
              monitorRuns += 1;
            },
          },
        ],
      };
      const teams = linearTeams(["In Progress", "Human Review", "Done"]);
      store.syncDefinitions([service], teams);
      const task = store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-42",
        issueTitle: "Monitor the pull request",
        state: "Human Review",
        resolvedState: "Human Review",
        pullRequest: pullRequest({ labels: ["review"], checkStatus: "IN_PROGRESS" }),
      });
      store.setParentMessage(task.id, "C123", "100.001", "summary");

      const state = new Map();
      const options = {
        config: runtimeConfig({ services: [service], linearTeams: teams }),
        store,
        slackClient: fakeSlackClient([]),
        watcherChannelId: "CWATCHER",
        inReviewStatus: "Human Review",
        state,
        findPullRequestByUrl: async () => {
          fetches += 1;
          return pullRequest({ labels: ["review"], checkStatus: "IN_PROGRESS" });
        },
      };

      await runPullRequestMonitors(options);
      store.updateTaskStatus(task.id, "In Progress");
      await runPullRequestMonitors(options);
      assert.equal(state.size, 0);
      store.updateTaskStatus(task.id, "Human Review");
      await runPullRequestMonitors(options);

      assert.equal(fetches, 2);
      assert.equal(monitorRuns, 0);
    });
  });

  it("clears the baseline outside periodic maintenance after leaving review", async () => {
    await withStore(async (store) => {
      const service = {
        name: "service-a",
        url: dataUrl({ running: [], retrying: [], blocked: [] }),
        linearTeam: "workspace-a-eng",
        monitors: [{ id: "checks", run: () => undefined }],
      };
      const teams = linearTeams(["In Progress", "Human Review", "Done"]);
      const config = runtimeConfig({
        services: [service],
        linearTeams: teams,
        reviewComment: {
          inReviewStatus: "Human Review",
          inProgressStatus: "In Progress",
        },
      });
      store.syncDefinitions([service], teams);
      const task = store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-42",
        issueTitle: "Monitor the pull request",
        state: "In Progress",
        resolvedState: "In Progress",
        pullRequest: pullRequest({ labels: ["review"], checkStatus: "IN_PROGRESS" }),
      });
      const state = new Map([[task.id, task.pullRequest!]]);

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "CWATCHER",
        runPeriodicMaintenance: false,
        pullRequestMonitorState: state,
      });

      assert.equal(state.size, 0);
    });
  });
});

function pullRequest({
  labels,
  checkStatus,
}: {
  labels: string[];
  checkStatus: string;
}): PullRequest {
  return {
    url: "https://github.com/example/repository/pull/42",
    labels,
    checks: [
      {
        name: "test",
        status: checkStatus,
        conclusion: checkStatus === "COMPLETED" ? "SUCCESS" : null,
      },
    ],
  };
}
