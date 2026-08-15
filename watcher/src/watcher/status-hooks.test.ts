import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChatPostMessageArguments } from "@slack/web-api";

import { createDatabase } from "../persistence/database.ts";
import { WatcherStore } from "../persistence/store.ts";
import {
  createPendingStatusHookEvent,
  deliverPendingStatusHooks,
  dispatchStatusHooks,
  runStatusHooks,
  type StatusHookContext,
} from "./status-hooks.ts";

const context: StatusHookContext = {
  event: "issue.status_changed",
  service: "ios",
  issue: { identifier: "APP-42", title: "Ship preview" },
  transition: { from: "In Progress", to: "In Review" },
  pullRequest: {
    url: "https://github.com/example/app/pull/42",
    number: 42,
    labels: ["stg-deploy"],
  },
};
const helpers = {
  slack: {
    postMessage: async () => {},
    postThreadMessage: async () => {},
  },
} as const;

function queueStatusHook(
  store: WatcherStore,
  hooks: Parameters<typeof createPendingStatusHookEvent>[0],
  task: Parameters<typeof createPendingStatusHookEvent>[1],
  fromStatus: string,
  toStatus: string,
  pullRequest?: Parameters<typeof createPendingStatusHookEvent>[4],
): void {
  const event = createPendingStatusHookEvent(hooks, task, fromStatus, toStatus, pullRequest);
  if (event) store.addEvent(event);
}

describe("status hooks", () => {
  it("preserves a later transition with the same statuses while the first is pending", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "updated",
        service: "ios",
        issueIdentifier: "APP-42",
        resolvedState: "In Review",
      });
      store.setParentMessage(task.id, "CTASK", "10.000", "{}");
      let runs = 0;
      const hooks = [
        {
          id: "review",
          status: "In Review",
          run: () => {
            runs += 1;
          },
        },
      ];

      queueStatusHook(store, hooks, task, "In Progress", "In Review");
      store.updateTaskStatus(task.id, "In Progress");
      const laterTransition = store.updateTaskStatus(task.id, "In Review").task;
      queueStatusHook(store, hooks, laterTransition, "In Progress", "In Review");

      assert.equal(
        store.getUncompletedEvents("status_hook_pending", "status_hook_completed", task.id).length,
        2,
      );
      await deliverPendingStatusHooks({
        hooks,
        store,
        slackClient: { chat: { postMessage: async () => {} } },
        watcherChannelId: "CWATCHER",
        taskId: task.id,
      });

      assert.equal(runs, 2);
    });
  });

  it("runs matching TypeScript hooks with context and returns their message", async () => {
    const results = await runStatusHooks(
      [
        {
          id: "app-distribution",
          status: "in review",
          run: (received) => received.issue.identifier,
        },
        { id: "done", status: "Done", run: () => "should-not-run" },
      ],
      context,
      helpers,
    );

    assert.deepEqual(results, [{ output: "APP-42" }]);
  });

  it("reports command failures without throwing", async () => {
    const [result] = await runStatusHooks(
      [
        {
          id: "failure",
          status: "In Review",
          run: () => {
            throw new Error("broken");
          },
        },
      ],
      context,
      helpers,
    );

    assert.match(String(result.error), /broken/);
  });

  it("uses enriched PR data and parent-fixed Slack destinations", async () => {
    const posts: Array<Record<string, unknown>> = [];
    await dispatchStatusHooks({
      hooks: [
        {
          id: "app-distribution",
          status: "In Review",
          run: async ({ pullRequest }, { slack }) => {
            await slack.postMessage({ text: pullRequest?.title ?? "missing" });
            await slack.postThreadMessage({ text: "thread" });
            return "returned";
          },
        },
      ],
      task: {
        id: "ios:APP-42",
        serviceName: "ios",
        issueIdentifier: "APP-42",
        title: "Ship preview",
        status: "In Review",
        parentChannelId: "COLD",
        parentMessageTs: "10.000",
        updatedAt: "2026-08-10T00:00:00Z",
      },
      fromStatus: "In Progress",
      toStatus: "In Review",
      pullRequest: {
        url: "https://github.com/example/app/pull/42",
        number: 42,
        title: "Enriched title",
        headRefName: "app-42",
      },
      slackClient: {
        chat: {
          async postMessage(args) {
            posts.push(args);
          },
        },
      },
      watcherChannelId: "CNEW",
    });

    assert.deepEqual(posts, [
      { text: "Enriched title", channel: "CNEW" },
      { text: "thread", channel: "COLD", thread_ts: "10.000" },
      { channel: "COLD", thread_ts: "10.000", text: "returned" },
    ]);
  });

  it("delivers a persisted transition after the task advances again", async () => {
    await withStore(async (store) => {
      const inProgress = store.upsertTaskFromEvent({
        type: "updated",
        service: "ios",
        issueIdentifier: "APP-42",
        issueTitle: "Ship preview",
        resolvedState: "In Progress",
      });
      store.setParentMessage(inProgress.id, "CTASK", "10.000", "{}");
      const inReview = store.upsertTaskFromEvent({
        type: "updated",
        service: "ios",
        issueIdentifier: "APP-42",
        resolvedState: "In Review",
      });
      const received: StatusHookContext[] = [];
      const hooks = [
        {
          id: "capture-context",
          status: "In Review",
          run: (hookContext: StatusHookContext) => {
            received.push(hookContext);
          },
        },
      ];
      queueStatusHook(store, hooks, inReview, "In Progress", "In Review", context.pullRequest);

      store.upsertTaskFromEvent({
        type: "updated",
        service: "ios",
        issueIdentifier: "APP-42",
        resolvedState: "Done",
      });
      const options = {
        hooks,
        store,
        slackClient: { chat: { postMessage: async () => {} } },
        watcherChannelId: "CWATCHER",
      };
      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0].transition, { from: "In Progress", to: "In Review" });
      assert.deepEqual(received[0].pullRequest, context.pullRequest);
    });
  });

  it("retries a pending hook when posting its returned output fails", async () => {
    await withPendingHook(async ({ store, hooks }) => {
      let attempts = 0;
      let failPost = true;
      const options = {
        hooks,
        store,
        slackClient: {
          chat: {
            postMessage: async () => {
              attempts += 1;
              if (failPost) throw new Error("Simulated Slack failure");
            },
          },
        },
        watcherChannelId: "CWATCHER",
      };

      await deliverPendingStatusHooks(options);
      failPost = false;
      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);

      assert.equal(attempts, 2);
    });
  });

  it("stops after maxAttempts and posts one notice to the task thread", async () => {
    await withPendingHook(async ({ store, hooks, runs }) => {
      hooks[0].maxAttempts = 2;
      hooks[0].run = () => {
        runs.value += 1;
        throw new Error("Still unavailable");
      };
      const posts: ChatPostMessageArguments[] = [];
      const options = {
        hooks,
        store,
        slackClient: {
          chat: {
            postMessage: async (args: ChatPostMessageArguments) => {
              posts.push(args);
            },
          },
        },
        watcherChannelId: "CWATCHER",
      };

      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);
      assert.equal(runs.value, 2);
      assert.deepEqual(posts, []);

      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);

      assert.equal(runs.value, 2);
      assert.deepEqual(posts, [
        {
          channel: "CTASK",
          thread_ts: "10.000",
          text: "Status hook `app-distribution` failed after 2 attempts and will not be retried.",
        },
      ]);
    });
  });

  it("retries the limit notice without running the hook again", async () => {
    await withPendingHook(async ({ store, hooks, runs }) => {
      hooks[0].maxAttempts = 1;
      hooks[0].run = () => {
        runs.value += 1;
        throw new Error("Still unavailable");
      };
      let noticeAttempts = 0;
      const options = {
        hooks,
        store,
        slackClient: {
          chat: {
            postMessage: async () => {
              noticeAttempts += 1;
              if (noticeAttempts === 1) throw new Error("Simulated Slack failure");
            },
          },
        },
        watcherChannelId: "CWATCHER",
      };

      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);

      assert.equal(runs.value, 1);
      assert.equal(noticeAttempts, 2);
    });
  });

  it("does not repeat a completed hook when another hook needs retrying", async () => {
    await withStore(async (store) => {
      const task = createPendingTask(store);
      let firstRuns = 0;
      let secondRuns = 0;
      let failSecond = true;
      const hooks = [
        {
          id: "first",
          status: "In Review",
          run: () => {
            firstRuns += 1;
            return "first";
          },
        },
        {
          id: "second",
          status: "In Review",
          run: () => {
            secondRuns += 1;
            if (failSecond) throw new Error("Simulated hook failure");
            return "second";
          },
        },
      ];
      queueStatusHook(store, hooks, task, "In Progress", "In Review");
      const posts: string[] = [];
      const options = {
        hooks,
        store,
        slackClient: {
          chat: {
            postMessage: async ({ text }: ChatPostMessageArguments) => {
              posts.push(text);
            },
          },
        },
        watcherChannelId: "CWATCHER",
      };

      await deliverPendingStatusHooks(options);
      failSecond = false;
      let insertedRuns = 0;
      options.hooks = [
        hooks[1],
        {
          id: "inserted-later",
          status: "In Review",
          run: () => {
            insertedRuns += 1;
            return "inserted";
          },
        },
        hooks[0],
      ];
      await deliverPendingStatusHooks(options);

      assert.equal(firstRuns, 1);
      assert.equal(secondRuns, 2);
      assert.equal(insertedRuns, 0);
      assert.deepEqual(posts, ["first", "second"]);
    });
  });

  it("continues with later pending events after one hook fails", async () => {
    await withStore(async (store) => {
      const first = createPendingTask(store);
      const second = store.upsertTaskFromEvent({
        type: "updated",
        service: "ios",
        issueIdentifier: "APP-43",
        resolvedState: "In Review",
      });
      store.setParentMessage(second.id, "CTASK", "11.000", "{}");
      const delivered: string[] = [];
      const hooks = [
        {
          id: "deliver-other-task",
          status: "In Review",
          run: ({ issue }: StatusHookContext) => {
            if (issue.identifier === "APP-42") throw new Error("Simulated hook failure");
            delivered.push(issue.identifier);
          },
        },
      ];
      queueStatusHook(store, hooks, first, "In Progress", "In Review");
      queueStatusHook(store, hooks, second, "In Progress", "In Review");

      await deliverPendingStatusHooks({
        hooks,
        store,
        slackClient: { chat: { postMessage: async () => {} } },
        watcherChannelId: "CWATCHER",
      });

      assert.deepEqual(delivered, ["APP-43"]);
    });
  });

  it("serializes concurrent delivery of the same pending hook", async () => {
    await withPendingHook(async ({ store, hooks, runs }) => {
      const options = {
        hooks,
        store,
        slackClient: { chat: { postMessage: async () => {} } },
        watcherChannelId: "CWATCHER",
      };

      await Promise.all([deliverPendingStatusHooks(options), deliverPendingStatusHooks(options)]);

      assert.equal(runs.value, 1);
    });
  });

  it("rolls back the task update when creating its pending event fails", async () => {
    await withStore(async (store) => {
      store.upsertTaskFromEvent({
        type: "updated",
        service: "ios",
        issueIdentifier: "APP-42",
        resolvedState: "In Progress",
      });

      assert.throws(
        () =>
          store.upsertTaskFromEventAtomically(
            {
              type: "updated",
              service: "ios",
              issueIdentifier: "APP-42",
              resolvedState: "In Review",
            },
            () => {
              throw new Error("Simulated event failure");
            },
          ),
        /Simulated event failure/,
      );
      assert.equal(store.getTask("ios:APP-42")?.status, "In Progress");

      assert.throws(
        () =>
          store.updateTaskStatusAtomically("ios:APP-42", "In Review", () => {
            throw new Error("Simulated event failure");
          }),
        /Simulated event failure/,
      );
      assert.equal(store.getTask("ios:APP-42")?.status, "In Progress");
    });
  });
});

async function withPendingHook(
  run: (options: {
    store: WatcherStore;
    hooks: Array<{ id: string; status: string; maxAttempts?: number; run: () => string }>;
    runs: { value: number };
  }) => void | Promise<void>,
): Promise<void> {
  await withStore(async (store) => {
    const inProgress = store.upsertTaskFromEvent({
      type: "updated",
      service: "ios",
      issueIdentifier: "APP-42",
      issueTitle: "Ship preview",
      resolvedState: "In Progress",
    });
    store.setParentMessage(inProgress.id, "CTASK", "10.000", "{}");
    const runs = { value: 0 };
    const hooks = [
      {
        id: "app-distribution",
        status: "In Review",
        run: () => {
          runs.value += 1;
          return "distributed";
        },
      },
    ];
    store.upsertTaskFromEventAtomically(
      {
        type: "updated",
        service: "ios",
        issueIdentifier: "APP-42",
        resolvedState: "In Review",
      },
      (task, previous) => createPendingStatusHookEvent(hooks, task, previous!.status, task.status),
    );
    await run({ store, hooks, runs });
  });
}

function createPendingTask(store: WatcherStore) {
  const task = store.upsertTaskFromEvent({
    type: "updated",
    service: "ios",
    issueIdentifier: "APP-42",
    issueTitle: "Ship preview",
    resolvedState: "In Review",
  });
  return store.setParentMessage(task.id, "CTASK", "10.000", "{}");
}

async function withStore(run: (store: WatcherStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "watcher-status-hooks-"));
  const database = createDatabase(join(directory, "watcher.db"));
  const store = new WatcherStore(database.db);
  store.syncDefinitions(
    [{ name: "ios", url: "https://service.test/state", linearTeam: "workspace-ios" }],
    {
      "workspace-ios": {
        apiKey: "lin_test",
        teamId: "team-ios",
        statuses: ["In Progress", "In Review", "Done"],
      },
    },
  );

  try {
    await run(store);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
