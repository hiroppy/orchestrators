import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequest } from "../domain/github.ts";
import type { ServiceDefinition } from "../domain/service.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { cachePullRequestLookups, runOnce } from "./run-once.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";
import { runPullRequestMonitors } from "./pull-request-monitors.ts";

describe("pull request monitors", () => {
  it("upgrades cached metadata when review comment enrichment is requested", async () => {
    const calls: boolean[] = [];
    const findPullRequestByUrl = cachePullRequestLookups(async (url, options) => {
      const enriched = options?.includeLatestReviewComment === true;
      calls.push(enriched);
      return { url, ...(enriched ? { latestReviewCommentAt: "2026-08-29T00:00:00Z" } : {}) };
    });
    const url = "https://github.com/example/repository/pull/42";

    await findPullRequestByUrl(url);
    const enriched = await findPullRequestByUrl(url, { includeLatestReviewComment: true });
    await findPullRequestByUrl(url);

    assert.deepEqual(calls, [false, true]);
    assert.equal(enriched?.latestReviewCommentAt, "2026-08-29T00:00:00Z");
  });

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
      const options = setupMonitor(
        store,
        observed,
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
        { slackCalls: calls },
      );

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
      const options = setupMonitor(store, observed, {
        id: "checks",
        run: ({ pullRequest: current }) => {
          currentChecks.push(current.checks);
        },
      });

      await runPullRequestMonitors(options);
      await runPullRequestMonitors(options);

      assert.deepEqual(currentChecks, []);
    });
  });

  it("does not retain checks when the head commit changes", async () => {
    await withStore(async (store) => {
      const observed: PullRequest[] = [
        pullRequest({ labels: ["review"], checkStatus: "COMPLETED", headRefOid: "old" }),
        pullRequest({ labels: ["review"], checkStatus: "COMPLETED", headRefOid: "new" }),
      ];
      let completions = 0;
      const options = setupMonitor(store, observed, {
        id: "checks",
        run: ({ pullRequest: current, previousPullRequest: previous }) => {
          const oldCheck = previous.checks?.find(({ name }) => name === "test");
          const newCheck = current.checks?.find(({ name }) => name === "test");
          if (oldCheck?.status !== "COMPLETED" && newCheck?.status === "COMPLETED") {
            completions += 1;
          }
        },
      });

      await runPullRequestMonitors(options);
      await runPullRequestMonitors(options);

      assert.equal(completions, 1);
    });
  });

  it("stops monitoring outside the configured review status and resets the baseline", async () => {
    await withStore(async (store) => {
      let fetches = 0;
      let monitorRuns = 0;
      const observation = pullRequest({ labels: ["review"], checkStatus: "IN_PROGRESS" });
      const options = setupMonitor(
        store,
        [observation],
        {
          id: "checks",
          run: () => {
            monitorRuns += 1;
          },
        },
        { status: "Human Review", statuses: ["In Progress", "Human Review", "Done"] },
      );
      const { state } = options;
      options.findPullRequestByUrl = async () => {
        fetches += 1;
        return observation;
      };

      await runPullRequestMonitors(options);
      store.updateTaskStatus("service-a:ENG-42", "In Progress");
      await runPullRequestMonitors(options);
      assert.equal(state.size, 0);
      store.updateTaskStatus("service-a:ENG-42", "Human Review");
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
        pullRequestMonitors: [{ id: "checks", run: () => undefined }],
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

  it("reuses a pull request fetched during periodic reconciliation", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const { query } = JSON.parse(String(options?.body)) as { query: string };
        if (query.includes("OrchestratorWatcherIssueStateBatch")) {
          return Response.json({
            data: {
              issue0: { identifier: "ENG-42", state: { name: "In Review", type: "started" } },
            },
          });
        }
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-42",
              title: "Monitor the pull request",
              state: { name: "In Review", type: "started" },
              attachments: {
                nodes: [{ url: "https://github.com/example/repository/pull/42" }],
              },
              relations: { nodes: [] },
            },
          },
        });
      });
      const service = {
        name: "service-a",
        url: dataUrl({ running: [], retrying: [], blocked: [] }),
        linearTeam: "workspace-a-eng",
        pullRequestMonitors: [{ id: "checks", run: () => undefined }],
      };
      const teams = linearTeams(["In Progress", "In Review", "Done"]);
      const config = runtimeConfig({
        services: [service],
        linearTeams: teams,
        reviewComment: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
        },
      });
      store.syncDefinitions([service], teams);
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-42",
        issueTitle: "Monitor the pull request",
        state: "In Review",
        resolvedState: "In Review",
        resolvedStateType: "started",
        pullRequest: pullRequest({ labels: ["review"], checkStatus: "IN_PROGRESS" }),
      });
      let lookups = 0;

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "CWATCHER",
        findPullRequestByUrl: async (url) => {
          lookups += 1;
          return { ...pullRequest({ labels: ["review"], checkStatus: "IN_PROGRESS" }), url };
        },
      });

      assert.equal(lookups, 1);
    });
  });
});

type PullRequestMonitor = NonNullable<ServiceDefinition["pullRequestMonitors"]>[number];

function setupMonitor(
  store: WatcherStore,
  observed: PullRequest[],
  monitor: PullRequestMonitor,
  {
    status = "In Review",
    statuses = ["Todo", "In Review", "Done"],
    slackCalls = [],
  }: {
    status?: string;
    statuses?: string[];
    slackCalls?: Array<Record<string, unknown>>;
  } = {},
): Parameters<typeof runPullRequestMonitors>[0] {
  const service: ServiceDefinition = {
    name: "service-a",
    url: "http://localhost:4101/api/v1/state",
    linearTeam: "workspace-a-eng",
    pullRequestMonitors: [monitor],
  };
  const teams = linearTeams(statuses);
  store.syncDefinitions([service], teams);
  const task = store.upsertTaskFromEvent({
    type: "updated",
    service: service.name,
    issueIdentifier: "ENG-42",
    issueTitle: "Monitor the pull request",
    state: status,
    resolvedState: status,
    pullRequest: observed[0],
  });
  store.setParentMessage(task.id, "C123", "100.001", "summary");

  return {
    config: runtimeConfig({ services: [service], linearTeams: teams }),
    store,
    slackClient: fakeSlackClient(slackCalls),
    watcherChannelId: "CWATCHER",
    inReviewStatus: status,
    state: new Map(),
    findPullRequestByUrl: async () => observed.shift() ?? null,
  };
}

function pullRequest({
  labels,
  checkStatus,
  headRefOid,
}: {
  labels: string[];
  checkStatus: string;
  headRefOid?: string;
}): PullRequest {
  return {
    url: "https://github.com/example/repository/pull/42",
    headRefOid,
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
