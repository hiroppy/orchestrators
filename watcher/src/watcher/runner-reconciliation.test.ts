import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileSlackStatusTransition, runOnce } from "./runner.ts";
import { collectSnapshots } from "./snapshots.ts";
import { createPendingStatusHookEvent } from "./status-hooks.ts";
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

  it("announces an overridden terminal state after a Slack status change", async (context) => {
    await withStore(async (store) => {
      context.mock.method(globalThis, "fetch", async () =>
        Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "In Staging Check", type: "started" },
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
        linearTeams: linearTeams(["In Review", "In Staging Check"]),
        statusTypeOverrides: { "in staging check": "completed" as const },
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
      const previousTask = store.getTask(task.id)!;
      const { task: closedTask } = store.updateTaskStatusAtomically(
        task.id,
        "In Staging Check",
        () => undefined,
      );
      const calls: Array<Record<string, unknown>> = [];

      await reconcileSlackStatusTransition({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        task: closedTask,
        previousTask,
      });

      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *In Staging Check*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
      );
    });
  });

  it("retries a terminal-to-terminal action after the Linear read fails", async (context) => {
    await withStore(async (store) => {
      let linearFetches = 0;
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        linearFetches += 1;
        if (linearFetches === 1) return new Response("temporary failure", { status: 500 });
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "In Staging Check", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
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
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["Done", "In Staging Check"]),
        statusHooks: [
          {
            id: "notify-staging",
            status: "In Staging Check",
            run: () => {},
          },
        ],
        statusTypeOverrides: { "in staging check": "completed" as const },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "Done",
        resolvedStateType: "completed",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const previousTask = store.getTask(task.id)!;
      const { task: closedTask, transitionEvent } = store.updateTaskStatusAtomically(
        task.id,
        "In Staging Check",
        (updatedTask, fromStatus) =>
          createPendingStatusHookEvent(
            config.statusHooks,
            updatedTask,
            fromStatus,
            updatedTask.status,
          ),
      );
      const calls: Array<Record<string, unknown>> = [];

      await reconcileSlackStatusTransition({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        task: closedTask,
        previousTask,
        transitionEventId: transitionEvent?.id,
      });

      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(store.countEvents(task.id, "status_hook_pending"), 0);
      assert.equal(store.countEvents(task.id, "linear_reconciliation_pending"), 1);

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(store.getTask(task.id)?.status, "In Staging Check");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      assert.equal(
        calls.some(({ method, thread_ts }) => method === "postMessage" && thread_ts === undefined),
        false,
      );
      assert.equal(store.countEvents(task.id, "linear_reconciliation_completed"), 1);
    });
  });

  it("retries publication after Linear advances to a terminal state", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const { query } = JSON.parse(String(options?.body)) as { query: string };
        const issue = {
          identifier: "ENG-62",
          title: "Merge the pull request",
          state: { name: "Done", type: "completed" },
          url: "https://linear.app/example/issue/ENG-62/example",
          attachments: { nodes: [] },
          relations: { nodes: [] },
        };
        return Response.json({
          data: query.includes("OrchestratorWatcherIssueStateBatch")
            ? { issue0: issue }
            : { issue },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
        statusTypeOverrides: {},
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const previousTask = store.getTask(task.id)!;
      const { task: actionTask } = store.updateTaskStatusAtomically(
        task.id,
        "In Review",
        () => undefined,
      );
      let rejectClosure = true;
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls, {
        rejectPostMessage: ({ text }) => {
          if (!rejectClosure || !String(text).startsWith("Task closed")) return false;
          rejectClosure = false;
          return true;
        },
      });

      await assert.rejects(
        reconcileSlackStatusTransition({
          config,
          store,
          slackClient,
          slackChannelId: "C123",
          task: actionTask,
          previousTask,
        }),
        /Simulated Slack failure/,
      );

      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(store.countEvents(task.id, "linear_reconciliation_pending"), 1);

      await runOnce({ config, store, slackClient, slackChannelId: "C123" });

      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(
        calls.filter(
          ({ method, text }) => method === "postMessage" && String(text).startsWith("Task closed"),
        ).length,
        1,
      );
      assert.equal(store.countEvents(task.id, "linear_reconciliation_completed"), 1);
    });
  });

  it("completes an obsolete retry after a newer status action succeeds", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const { query } = JSON.parse(String(options?.body)) as { query: string };
        const issue = {
          identifier: "ENG-62",
          title: "Merge the pull request",
          state: { name: "Done", type: "completed" },
          url: "https://linear.app/example/issue/ENG-62/example",
          attachments: { nodes: [] },
          relations: { nodes: [] },
        };
        return Response.json({
          data: query.includes("OrchestratorWatcherIssueStateBatch")
            ? { issue0: issue }
            : { issue },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const obsoleteReconciliation = store.addEvent({
        taskId: task.id,
        type: "linear_reconciliation_pending",
        fromStatus: "In Progress",
        toStatus: "In Review",
        body: "started",
      });
      const previousTask = store.getTask(task.id)!;
      const { task: newerActionTask, transitionEvents } = store.updateTaskStatusAtomically(
        task.id,
        "Done",
        (updatedTask) => [
          {
            taskId: task.id,
            type: "linear_reconciliation_completed",
            body: String(obsoleteReconciliation.id),
          },
          {
            taskId: task.id,
            type: "linear_reconciliation_pending",
            fromStatus: previousTask.status,
            toStatus: updatedTask.status,
            body: previousTask.linearStateType,
          },
        ],
      );
      const currentReconciliation = transitionEvents.find(
        ({ type }) => type === "linear_reconciliation_pending",
      );
      assert.ok(currentReconciliation);
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);

      await reconcileSlackStatusTransition({
        config,
        store,
        slackClient,
        slackChannelId: "C123",
        task: newerActionTask,
        previousTask,
        reconciliationEventId: currentReconciliation.id,
      });

      assert.equal(store.countEvents(task.id, "linear_reconciliation_completed"), 2);

      await runOnce({ config, store, slackClient, slackChannelId: "C123" });

      assert.equal(
        calls.filter(
          ({ method, text }) => method === "postMessage" && String(text).startsWith("Task closed"),
        ).length,
        1,
      );
    });
  });

  it("does not publish a stale Linear read after a newer Slack status action", async (context) => {
    await withStore(async (store) => {
      const fetchStarted = Promise.withResolvers<void>();
      const releaseFetch = Promise.withResolvers<void>();
      context.mock.method(globalThis, "fetch", async () => {
        fetchStarted.resolve();
        await releaseFetch.promise;
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "In Staging Check", type: "started" },
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
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Staging Check", "Done"]),
        statusHooks: [
          {
            id: "notify-staging",
            status: "In Staging Check",
            run: () => {},
          },
        ],
        statusTypeOverrides: { "in staging check": "completed" as const },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const previousTask = store.getTask(task.id)!;
      const { task: firstActionTask, transitionEvent } = store.updateTaskStatusAtomically(
        task.id,
        "In Staging Check",
        (updatedTask, fromStatus) =>
          createPendingStatusHookEvent(
            config.statusHooks,
            updatedTask,
            fromStatus,
            updatedTask.status,
          ),
      );

      const firstReconciliation = reconcileSlackStatusTransition({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        task: firstActionTask,
        previousTask,
        transitionEventId: transitionEvent?.id,
      });
      await fetchStarted.promise;
      store.updateTaskStatusAtomically(task.id, "Done", () => undefined);
      releaseFetch.resolve();
      await firstReconciliation;

      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(store.countEvents(task.id, "status_hook_pending"), 1);
    });
  });

  it("does not let a stale periodic fetch complete a newer action", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      const detailedFetchStarted = Promise.withResolvers<void>();
      const releaseDetailedFetch = Promise.withResolvers<void>();
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const { query } = JSON.parse(String(options?.body)) as { query: string };
        const issue = {
          identifier: "ENG-62",
          title: "Merge the pull request",
          state: { name: "Done", type: "completed" },
          attachments: { nodes: [] },
          relations: { nodes: [] },
        };
        if (query.includes("OrchestratorWatcherIssueStateBatch")) {
          return Response.json({ data: { issue0: issue } });
        }
        detailedFetchStarted.resolve();
        await releaseDetailedFetch.promise;
        return Response.json({ data: { issue } });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Rework", "Done"]),
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
      const staleReconciliation = store.addEvent({
        taskId: task.id,
        type: "linear_reconciliation_pending",
        fromStatus: "In Progress",
        toStatus: "In Review",
        body: "started",
      });

      const reconciliation = runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
      });
      await detailedFetchStarted.promise;
      const previousTask = store.getTask(task.id)!;
      store.updateTaskStatusAtomically(task.id, "Rework", (updatedTask) => [
        {
          taskId: task.id,
          type: "linear_reconciliation_completed",
          body: String(staleReconciliation.id),
        },
        {
          taskId: task.id,
          type: "linear_reconciliation_pending",
          fromStatus: previousTask.status,
          toStatus: updatedTask.status,
          body: previousTask.linearStateType,
        },
      ]);
      releaseDetailedFetch.resolve();
      await reconciliation;

      assert.equal(store.getTask(task.id)?.status, "Rework");
      assert.equal(
        store.getUncompletedEvents(
          "linear_reconciliation_pending",
          "linear_reconciliation_completed",
          task.id,
        ).length,
        1,
      );
    });
  });

  it("does not retry a closure after only the later thread publication fails", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const issue = {
          identifier: "ENG-62",
          title: "Merge the pull request",
          state: { name: "Done", type: "completed" },
          attachments: { nodes: [] },
          relations: { nodes: [] },
        };
        const { query } = JSON.parse(String(options?.body)) as { query: string };
        return Response.json({
          data: query.includes("OrchestratorWatcherIssueStateBatch")
            ? { issue0: issue }
            : { issue },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const previousTask = store.getTask(task.id)!;
      const { task: actionTask } = store.updateTaskStatusAtomically(
        task.id,
        "In Review",
        () => undefined,
      );
      let rejectThread = true;
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls, {
        rejectPostMessage: ({ thread_ts }) => {
          if (!rejectThread || thread_ts === undefined) return false;
          rejectThread = false;
          return true;
        },
      });

      await assert.rejects(
        reconcileSlackStatusTransition({
          config,
          store,
          slackClient,
          slackChannelId: "C123",
          task: actionTask,
          previousTask,
        }),
        /Simulated Slack failure/,
      );
      await runOnce({ config, store, slackClient, slackChannelId: "C123" });

      assert.equal(
        calls.filter(
          ({ method, text }) => method === "postMessage" && String(text).startsWith("Task closed"),
        ).length,
        1,
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
      let hookAttempts = 0;
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
        statusHooks: [
          {
            id: "capture-attempt",
            status: "In Review",
            run: () => {
              hookAttempts += 1;
            },
          },
        ],
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
      const pendingHook = createPendingStatusHookEvent(
        config.statusHooks,
        task,
        "In Progress",
        "In Review",
      );
      assert.ok(pendingHook);
      store.addEvent(pendingHook);

      const calls: Array<Record<string, unknown>> = [];
      let pullRequestLookups = 0;
      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        runPeriodicMaintenance: false,
      });

      assert.equal(linearFetches, 0);
      assert.equal(hookAttempts, 0);
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

      assert.equal(hookAttempts, 1);
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
      assert.equal(linearFetches, 2);
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

  it("recovers an overridden terminal action after restarting before reconciliation", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "In Staging Check", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
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
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Staging Check"]),
        statusTypeOverrides: { "in staging check": "completed" as const },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      store.updateTaskStatus(task.id, "In Staging Check");
      store.addEvent({
        taskId: task.id,
        type: "linear_reconciliation_pending",
        fromStatus: "In Progress",
        toStatus: "In Staging Check",
        body: "started",
      });
      const calls: Array<Record<string, unknown>> = [];

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(store.getTask(task.id)?.linearStateType, "started");
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *In Staging Check*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
      );
    });
  });

  it("uses detailed state when Linear changes after the batch summary", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const { query } = JSON.parse(String(options?.body)) as { query: string };
        if (query.includes("OrchestratorWatcherIssueStateBatch")) {
          return Response.json({
            data: {
              issue0: {
                identifier: "ENG-62",
                state: { name: "In Review", type: "started" },
              },
            },
          });
        }
        return Response.json({
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
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
        reviewComment: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const calls: Array<Record<string, unknown>> = [];

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
    });
  });

  for (const batchFailure of ["request failure", "partial response"] as const) {
    it(`falls back to detailed reconciliation after a batch ${batchFailure}`, async (context) => {
      await withStore(async (store) => {
        const nativeFetch = globalThis.fetch;
        let linearFetches = 0;
        context.mock.method(globalThis, "fetch", async (url, options) => {
          if (String(url).startsWith("data:")) return nativeFetch(url, options);
          linearFetches += 1;
          const { query } = JSON.parse(String(options?.body)) as { query: string };
          if (query.includes("OrchestratorWatcherIssueStateBatch")) {
            return batchFailure === "request failure"
              ? new Response("temporary failure", { status: 500 })
              : Response.json({ data: {} });
          }
          return Response.json({
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
          });
        });
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
          type: "ended",
          service: "service-a",
          issueIdentifier: "ENG-62",
          resolvedState: "In Review",
          resolvedStateType: "started",
        });
        store.setParentMessage(task.id, "C123", "1.000", "{}");

        await runOnce({
          config,
          store,
          slackClient: fakeSlackClient([]),
          slackChannelId: "C123",
        });

        assert.equal(linearFetches, 2);
        assert.equal(store.getTask(task.id)?.status, "Done");
        assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      });
    });
  }

  it("defers a rate-limited team without issuing per-task fallback requests", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      let linearFetches = 0;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        linearFetches += 1;
        return Response.json(
          { errors: [{ extensions: { code: "RATELIMITED" } }] },
          { status: 400 },
        );
      });
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
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const secondTask = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-63",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(secondTask.id, "C123", "2.000", "{}");

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
      });

      assert.equal(linearFetches, 1);
      assert.equal(store.getTask(task.id)?.status, "In Review");
      assert.equal(store.getTask(secondTask.id)?.status, "In Review");
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
