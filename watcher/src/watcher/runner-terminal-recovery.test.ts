import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runOnce } from "./run-once.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher terminal recovery", () => {
  it("reclassifies a persisted terminal row before reconciling an active override", async (context) => {
    await withStore(async (store) => {
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
              state: { name: "Ready for Release", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
              relations: { nodes: [] },
            },
            issue0: {
              identifier: "ENG-62",
              state: { name: "Ready for Release", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            activeStates: ["In Review"],
            terminalStates: ["Done", "Ready for Release"],
          },
        ],
        linearTeams: linearTeams(["In Review", "Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Review",
        resolvedStateType: "completed",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const calls: Array<Record<string, unknown>> = [];
      const reconcile = () =>
        runOnce({
          config,
          store,
          slackClient: fakeSlackClient(calls),
          slackChannelId: "C123",
        });

      await reconcile();

      assert.equal(store.getTask(task.id)?.status, "Ready for Release");
      assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
      assert.equal(linearFetches, 2);

      await reconcile();

      assert.equal(linearFetches, 2);
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
    });
  });

  it("recovers a persisted terminal row after its workflow override is removed", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        return Response.json({
          data: {
            issue0: {
              identifier: "ENG-62",
              state: { name: "Ready for Release", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            activeStates: ["In Review"],
            terminalStates: ["Done"],
          },
        ],
        linearTeams: linearTeams(["In Review", "Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "Ready for Release",
        resolvedStateType: "completed",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        persistedTerminalTaskIds: new Set([task.id]),
      });

      assert.equal(store.getTask(task.id)?.linearStateType, "started");
    });
  });

  it("retries persisted terminal recovery after a startup rate limit", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      let rateLimited = true;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        if (rateLimited) {
          return Response.json(
            { errors: [{ extensions: { code: "RATELIMITED" } }] },
            { status: 400 },
          );
        }
        return Response.json({
          data: {
            issue0: {
              identifier: "ENG-62",
              state: { name: "Ready for Release", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            terminalStates: ["Done"],
          },
        ],
        linearTeams: linearTeams(["Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "Ready for Release",
        resolvedStateType: "completed",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");

      const firstRun = await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        persistedTerminalTaskIds: new Set([task.id]),
      });

      assert.equal(firstRun.persistedTerminalReconciliationComplete, false);
      assert.equal(store.getTask(task.id)?.linearStateType, "completed");

      rateLimited = false;
      const secondRun = await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        persistedTerminalTaskIds: firstRun.pendingPersistedTerminalTaskIds,
      });

      assert.equal(secondRun.persistedTerminalReconciliationComplete, true);
      assert.equal(store.getTask(task.id)?.linearStateType, "started");
    });
  });

  it("retains only unresolved terminal rows across startup recovery retries", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      const batchRequests: string[][] = [];
      let recoverMissingIssue = false;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const request = JSON.parse(String(options?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (!request.query.includes("OrchestratorWatcherIssueStateBatch")) {
          return Response.json({ data: { issue: null } });
        }
        const identifiers = Object.values(request.variables);
        batchRequests.push(identifiers);
        const data = Object.fromEntries(
          identifiers.flatMap((identifier, index) =>
            identifier === "ENG-63" && !recoverMissingIssue
              ? []
              : [
                  [
                    `issue${index}`,
                    {
                      identifier,
                      state: { name: "Ready for Release", type: "started" },
                    },
                  ],
                ],
          ),
        );
        return Response.json({ data });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            terminalStates: ["Done"],
          },
        ],
        linearTeams: linearTeams(["Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const tasks = ["ENG-62", "ENG-63"].map((issueIdentifier) =>
        store.upsertTaskFromEvent({
          type: "ended",
          service: "service-a",
          issueIdentifier,
          resolvedState: "Ready for Release",
          resolvedStateType: "completed",
        }),
      );

      const firstRun = await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        persistedTerminalTaskIds: new Set(tasks.map(({ id }) => id)),
      });

      assert.deepEqual([...firstRun.pendingPersistedTerminalTaskIds], [tasks[1]!.id]);
      assert.equal(store.getTask(tasks[0]!.id)?.linearStateType, "started");
      assert.equal(store.getTask(tasks[1]!.id)?.linearStateType, "completed");

      recoverMissingIssue = true;
      const secondRun = await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        persistedTerminalTaskIds: firstRun.pendingPersistedTerminalTaskIds,
      });

      assert.deepEqual(batchRequests, [["ENG-62", "ENG-63"], ["ENG-63"]]);
      assert.equal(secondRun.persistedTerminalReconciliationComplete, true);
      assert.equal(store.getTask(tasks[1]!.id)?.linearStateType, "started");
    });
  });

  it("recovers a persisted terminal row that is in the current snapshot without Slack metadata", async (context) => {
    await withStore(async (store) => {
      const snapshot = {
        running: [{ issue_identifier: "ENG-62", state: "Ready for Release" }],
        retrying: [],
        blocked: [],
      };
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        return Response.json({
          data: {
            issue0: {
              identifier: "ENG-62",
              state: { name: "Ready for Release", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(snapshot),
            linearTeam: "workspace-a-eng",
            terminalStates: ["Done"],
          },
        ],
        linearTeams: linearTeams(["Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": snapshot });
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "Ready for Release",
        resolvedStateType: "completed",
      });

      const result = await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        persistedTerminalTaskIds: new Set([task.id]),
      });

      assert.equal(result.persistedTerminalReconciliationComplete, true);
      assert.equal(store.getTask(task.id)?.linearStateType, "started");
    });
  });

  it("processes a status change before completing snapshot terminal recovery", async (context) => {
    await withStore(async (store) => {
      const snapshot = {
        running: [{ issue_identifier: "ENG-62", state: "Ready for Release" }],
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
              title: "Merge the pull request",
              state: { name: "In Progress", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
              relations: { nodes: [] },
            },
            issue0: {
              identifier: "ENG-62",
              state: { name: "In Progress", type: "started" },
            },
          },
        });
      });
      let hookAttempts = 0;
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(snapshot),
            linearTeam: "workspace-a-eng",
            terminalStates: ["Done"],
            statusHooks: [
              {
                id: "capture-recovered-transition",
                status: "In Progress",
                run: () => {
                  hookAttempts += 1;
                },
              },
            ],
          },
        ],
        linearTeams: linearTeams(["In Progress", "Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": snapshot });
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "Ready for Release",
        resolvedStateType: "completed",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const calls: Array<Record<string, unknown>> = [];

      const result = await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        persistedTerminalTaskIds: new Set([task.id]),
      });

      assert.equal(result.persistedTerminalReconciliationComplete, true);
      assert.equal(store.getTask(task.id)?.status, "In Progress");
      assert.equal(store.getTask(task.id)?.linearStateType, "started");
      assert.ok(calls.some(({ method }) => method === "update"));
      assert.equal(hookAttempts, 1);
    });
  });

  it("announces an existing task when its status becomes a terminal override", async (context) => {
    await withStore(async (store) => {
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
              state: { name: "Ready for Release", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
              relations: { nodes: [] },
            },
            issue0: {
              identifier: "ENG-62",
              state: { name: "Ready for Release", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            terminalStates: ["Done", "Ready for Release"],
          },
        ],
        linearTeams: linearTeams(["Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "Ready for Release",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const calls: Array<Record<string, unknown>> = [];
      const reconcile = () =>
        runOnce({
          config,
          store,
          slackClient: fakeSlackClient(calls),
          slackChannelId: "C123",
        });

      await reconcile();

      assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
      assert.equal(linearFetches, 2);

      await reconcile();

      assert.equal(linearFetches, 2);
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
    });
  });
});
