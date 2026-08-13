import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileSlackStatusTransition, runOnce } from "./runner.ts";
import { collectSnapshots } from "./snapshots.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher reconciliation and snapshots", () => {
  it("announces a terminal Linear state immediately after a Slack status change", async (context) => {
    await withStore(async (store) => {
      context.mock.method(globalThis, "fetch", async () =>
        Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "Done", type: "completed" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
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
        linearTeams: linearTeams(["In Review", "Done"]),
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
        "Done",
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
        "Task closed | *Done*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
      );
    });
  });

  it("reconciles nonterminal tasks after they disappear from Symphony", async (context) => {
    await withStore(async (store) => {
      const emptySnapshot = { running: [], retrying: [], blocked: [] };
      const nativeFetch = globalThis.fetch;
      let linearFetches = 0;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        linearFetches += 1;
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "Done", type: "completed" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: {
                nodes: [{ url: "https://github.com/acme/example/pull/42" }],
              },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(emptySnapshot),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
        notifications: {
          statuses: ["In Review"],
          events: [],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        state: "In Review",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");

      const calls: Array<Record<string, unknown>> = [];
      let pullRequestLookups = 0;
      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        runLinearReconciliation: false,
      });

      assert.equal(linearFetches, 0);
      assert.equal(store.getTask(task.id)?.status, "In Review");

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        findPullRequestByUrl: async (url) => {
          pullRequestLookups += 1;
          return {
            url,
            number: 42,
            title: "Ship the reconciled pull request",
          };
        },
      });

      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *Done*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
      );
      assert.match(
        String(calls.find(({ method, thread_ts }) => method === "postMessage" && thread_ts)?.text),
        /^\*In Review\* → \*Done\*\nEvent: Updated\n<https:\/\/github\.com\/acme\/example\/pull\/42\|PR#42>$/,
      );
      assert.match(
        JSON.stringify(
          calls.find(({ method, thread_ts }) => method === "postMessage" && thread_ts)?.blocks,
        ),
        /Ship the reconciled pull request/,
      );

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        findPullRequestByUrl: async () => {
          pullRequestLookups += 1;
          throw new Error("A no-op reconciliation must not fetch PR metadata");
        },
      });
      assert.equal(linearFetches, 1);
      assert.equal(pullRequestLookups, 1);
    });
  });

  it("recovers missing Linear state metadata while a task remains in Symphony", async (context) => {
    await withStore(async (store) => {
      const activeSnapshot = {
        running: [{ issue_identifier: "ENG-62", state: "Todo" }],
        retrying: [],
        blocked: [],
      };
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Canceled task",
              state: { name: "Canceled", type: "canceled" },
              attachments: { nodes: [] },
              relations: { nodes: [] },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(activeSnapshot),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["Todo", "Canceled"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": activeSnapshot });
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Canceled task",
        resolvedState: "Canceled",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const calls: Array<Record<string, unknown>> = [];

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(store.getTask(task.id)?.linearStateType, "canceled");
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *Canceled*\n<https://example.slack.com/archives/C123/p1000|Canceled task>",
      );
    });
  });

  it("preserves active tasks through an outage and reports recovery without false transitions", async (context) => {
    await withStore(async (store) => {
      const activeSnapshot = {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [],
        blocked: [],
      };
      let unavailable = true;
      context.mock.method(globalThis, "fetch", async (url) => {
        assert.equal(String(url), "http://127.0.0.1:1/state");
        if (unavailable) throw new TypeError("fetch failed");
        return Response.json(activeSnapshot);
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: "http://127.0.0.1:1/state",
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["Backlog", "Done"]),
        defaultAssignees: ["<@UREVIEWERS>"],
        notifications: {
          statuses: [],
          events: ["retrying", "recovered"],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": activeSnapshot });
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);

      const outage = await runOnce({
        config,
        store,
        slackClient,
        slackChannelId: "C123",
      });

      assert.deepEqual(
        outage.events.map(({ type, issueIdentifier }) => [type, issueIdentifier]),
        [["retrying", "watcher:service-a"]],
      );
      assert.equal(store.getSnapshots()["service-a"]?.running[0]?.issue_identifier, "ENG-62");
      assert.match(JSON.stringify(calls), /Assignees: <@UREVIEWERS>/);

      unavailable = false;
      const recovery = await runOnce({
        config,
        store,
        slackClient,
        slackChannelId: "C123",
      });

      assert.deepEqual(
        recovery.events.map(({ type, issueIdentifier }) => [type, issueIdentifier]),
        [["recovered", "watcher:service-a"]],
      );
      assert.equal(store.getTask("service-a:watcher:service-a")?.status, "available");
      assert.deepEqual(store.getSnapshots()["service-a"], activeSnapshot);
    });
  });

  it("times out an observability endpoint without blocking collection", async () => {
    const result = await collectSnapshots(
      [{ name: "service-a", url: "https://service.test/state" }],
      {},
      {
        timeoutMs: 5,
        fetch: async (_url, options) =>
          await new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          }),
      },
    );

    assert.match(result["service-a"]!.retrying[0].error!, /timed out|aborted/i);
  });

  it("preserves the previous snapshot when the endpoint returns malformed JSON", async () => {
    const previous = {
      "service-a": {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [],
        blocked: [],
      },
    };
    const result = await collectSnapshots(
      [{ name: "service-a", url: "https://service.test/state" }],
      previous,
      {
        fetch: async () => Response.json({ status: "starting" }),
      },
    );

    assert.deepEqual(result["service-a"]?.running, previous["service-a"].running);
    assert.match(result["service-a"]!.retrying[0].error!, /Invalid observability snapshot/);
  });
});
