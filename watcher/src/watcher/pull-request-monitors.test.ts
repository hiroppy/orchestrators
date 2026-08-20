import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequestMonitorConfig } from "orchestrator-config";

import type { WatcherStore } from "../persistence/store.ts";
import { PullRequestMonitorRegistry } from "./pull-request-monitors.ts";
import { fakeSlackClient, linearTeams, runtimeConfig, withStore } from "./runner.test-support.ts";

describe("pull request monitors", () => {
  it("polls until complete and posts the result once", async () => {
    await withStore(async (store) => {
      let monitorCalls = 0;
      let pullRequestCalls = 0;
      const triggers: unknown[] = [];
      const monitor: PullRequestMonitorConfig = {
        id: "app-distribution",
        maxAttempts: 3,
        run: ({ trigger }) => {
          monitorCalls += 1;
          triggers.push(trigger);
          return monitorCalls === 1
            ? { status: "pending" }
            : { status: "complete", message: { text: "Apps are ready" } };
        },
      };
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const slackCalls: Array<Record<string, unknown>> = [];
      const registry = new PullRequestMonitorRegistry(
        config,
        store,
        fakeSlackClient(slackCalls),
        async () => {
          pullRequestCalls += 1;
          return task.pullRequest!;
        },
      );

      registry.start(task, monitor, {
        command: "retry-stg",
        args: ["ios"],
        user: "U123",
        metadata: { sha: "abc123" },
      });
      await registry.poll();
      await registry.poll();
      await registry.poll();

      assert.equal(monitorCalls, 2);
      assert.equal(pullRequestCalls, 2);
      assert.equal(slackCalls.length, 1);
      assert.deepEqual(slackCalls[0], {
        method: "postMessage",
        channel: "C123",
        thread_ts: "10.000",
        text: "Apps are ready",
      });
      const trigger = triggers[0] as Record<string, unknown>;
      const { startedAt, ...triggerWithoutStart } = trigger;
      assert.match(String(startedAt), /^20/);
      assert.deepEqual(triggerWithoutStart, {
        command: "retry-stg",
        args: ["ios"],
        user: "U123",
        metadata: { sha: "abc123" },
      });
    });
  });

  it("retries only the Slack notification after the monitor completes", async () => {
    await withStore(async (store) => {
      let monitorCalls = 0;
      let postAttempts = 0;
      const monitor: PullRequestMonitorConfig = {
        id: "preview",
        run: () => {
          monitorCalls += 1;
          return { status: "complete", message: { text: "Preview ready" } };
        },
      };
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const registry = new PullRequestMonitorRegistry(
        config,
        store,
        {
          chat: {
            async postMessage() {
              postAttempts += 1;
              if (postAttempts === 1) throw new Error("temporary Slack failure");
            },
          },
        },
        async () => task.pullRequest!,
      );

      registry.start(task, monitor, { command: "retry", args: [] });
      await registry.poll();
      await registry.poll();
      await registry.poll();

      assert.equal(monitorCalls, 1);
      assert.equal(postAttempts, 2);
    });
  });

  it("replaces an activation when monitor IDs differ only by whitespace", async () => {
    await withStore(async (store) => {
      const calls: string[] = [];
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const registry = new PullRequestMonitorRegistry(
        config,
        store,
        fakeSlackClient([]),
        async () => task.pullRequest!,
      );

      registry.start(
        task,
        {
          id: " preview ",
          run: () => {
            calls.push("first");
            return { status: "pending" };
          },
        },
        { command: "retry", args: [] },
      );
      registry.start(
        task,
        {
          id: "preview",
          run: () => {
            calls.push("second");
            return { status: "pending" };
          },
        },
        { command: "retry", args: [] },
      );
      await registry.poll();

      assert.deepEqual(calls, ["second"]);
    });
  });

  it("rejects a stale task after its stored status leaves In Review", async () => {
    await withStore((store) => {
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const registry = new PullRequestMonitorRegistry(config, store, fakeSlackClient([]));
      store.updateTaskStatus(task.id, "In Progress");

      assert.throws(
        () =>
          registry.start(
            task,
            { id: "preview", run: () => ({ status: "pending" }) },
            { command: "retry", args: [] },
          ),
        /only start while .* In Review/,
      );
    });
  });

  it("rejects a stale task after its stored pull request changes", async () => {
    await withStore((store) => {
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      trackedTask(store, "https://github.com/example/service-a/pull/43");
      const registry = new PullRequestMonitorRegistry(config, store, fakeSlackClient([]));

      assert.throws(
        () =>
          registry.start(
            task,
            { id: "preview", run: () => ({ status: "pending" }) },
            { command: "retry", args: [] },
          ),
        /changed to a different pull request/,
      );
    });
  });

  it("does not notify when the task leaves In Review while the monitor runs", async () => {
    await withStore(async (store) => {
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const slackCalls: Array<Record<string, unknown>> = [];
      const registry = new PullRequestMonitorRegistry(
        config,
        store,
        fakeSlackClient(slackCalls),
        async () => task.pullRequest!,
      );

      registry.start(
        task,
        {
          id: "preview",
          run: () => {
            store.updateTaskStatus(task.id, "In Progress");
            return { status: "complete", message: { text: "Preview ready" } };
          },
        },
        { command: "retry", args: [] },
      );
      await registry.poll();

      assert.deepEqual(slackCalls, []);
    });
  });

  it("does not notify a monitor failure after the task leaves In Review", async () => {
    await withStore(async (store) => {
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const slackCalls: Array<Record<string, unknown>> = [];
      const registry = new PullRequestMonitorRegistry(
        config,
        store,
        fakeSlackClient(slackCalls),
        async () => task.pullRequest!,
      );

      registry.start(
        task,
        {
          id: "preview",
          maxAttempts: 1,
          run: () => {
            store.updateTaskStatus(task.id, "In Progress");
            throw new Error("preview lookup failed");
          },
        },
        { command: "retry", args: [] },
      );
      await registry.poll();

      assert.deepEqual(slackCalls, []);
    });
  });

  it("stops after the attempt limit or leaving In Review", async () => {
    await withStore(async (store) => {
      let monitorCalls = 0;
      const monitor: PullRequestMonitorConfig = {
        id: "build",
        maxAttempts: 2,
        run: () => {
          monitorCalls += 1;
          return { status: "pending" };
        },
      };
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const slackCalls: Array<Record<string, unknown>> = [];
      const registry = new PullRequestMonitorRegistry(
        config,
        store,
        fakeSlackClient(slackCalls),
        async () => task.pullRequest!,
      );

      registry.start(task, monitor, { command: "retry", args: [] });
      await registry.poll();
      await registry.poll();
      assert.equal(monitorCalls, 2);
      assert.match(String(slackCalls[0]?.text), /failed after 2 attempts/);

      registry.start(store.getTask(task.id)!, monitor, { command: "retry", args: [] });
      store.updateTaskStatus(task.id, "In Progress");
      await registry.poll();
      assert.equal(monitorCalls, 2);
    });
  });

  it("validates the monitor and current pull request when starting", async () => {
    await withStore((store) => {
      const monitor: PullRequestMonitorConfig = {
        id: "preview",
        run: () => ({ status: "pending" }),
      };
      const config = monitorConfig();
      store.syncDefinitions(config.services, config.linearTeams);
      const task = trackedTask(store);
      const registry = new PullRequestMonitorRegistry(config, store, fakeSlackClient([]));

      assert.throws(
        () => registry.start(task, { ...monitor, id: "" }, { command: "retry", args: [] }),
        /id must be a non-empty string/,
      );
      assert.throws(
        () => registry.start(task, { ...monitor, maxAttempts: 0 }, { command: "retry", args: [] }),
        /maxAttempts must be a positive integer/,
      );
      assert.throws(
        () =>
          registry.start({ ...task, id: "missing-task", pullRequest: undefined }, monitor, {
            command: "retry",
            args: [],
          }),
        /does not have a pull request/,
      );
    });
  });
});

function monitorConfig() {
  return runtimeConfig({
    services: [
      {
        name: "service-a",
        url: "https://service.test/state",
        linearTeam: "workspace-a-eng",
      },
    ],
    linearTeams: linearTeams(["Todo", "In Progress", "In Review", "Done"]),
    reviewComment: {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
      reviewReadyDelayMs: 1_000,
    },
    defaultAssignees: [],
  });
}

function trackedTask(
  store: WatcherStore,
  pullRequestUrl = "https://github.com/example/service-a/pull/42",
) {
  const task = store.upsertTaskFromEvent({
    type: "updated",
    service: "service-a",
    issueIdentifier: "ENG-60",
    issueTitle: "Build mobile apps",
    issueUrl: "https://linear.app/example/issue/ENG-60/build-mobile-apps",
    resolvedState: "In Review",
    resolvedStateType: "started",
    pullRequest: {
      url: pullRequestUrl,
      number: 42,
      headRefOid: "abc123",
      labels: ["stg-deploy"],
    },
  });
  return store.setParentMessage(task.id, "C123", "10.000", "{}");
}
