import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDatabase } from "../persistence/database.ts";
import { WatcherStore } from "../persistence/store.ts";
import {
  createPendingStatusHookEvent,
  deliverPendingStatusHooks,
  dispatchStatusHooks,
  queueStatusHooks,
  runStatusHooks,
  type StatusHookContext,
} from "./status-hooks.ts";

const context: StatusHookContext = {
  event: "issue.status_changed",
  service: "ios",
  issue: { identifier: "APP-42", title: "Ship preview" },
  transition: { from: "In Progress", to: "In Review" },
  pullRequest: { url: "https://github.com/example/app/pull/42", number: 42 },
};
const helpers = {
  slack: {
    postMessage: async () => {},
    postThreadMessage: async () => {},
  },
} as const;

describe("status hooks", () => {
  it("runs matching TypeScript hooks with context and returns their message", async () => {
    const results = await runStatusHooks(
      [
        {
          status: "in review",
          run: (received) => received.issue.identifier,
        },
        { status: "Done", run: () => "should-not-run" },
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
          status: "In Review",
          run: (hookContext: StatusHookContext) => {
            received.push(hookContext);
          },
        },
      ];
      queueStatusHooks(hooks, store, inReview, "In Progress", "In Review", context.pullRequest);

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

      await assert.rejects(deliverPendingStatusHooks(options), /Simulated Slack failure/);
      failPost = false;
      await deliverPendingStatusHooks(options);
      await deliverPendingStatusHooks(options);

      assert.equal(attempts, 2);
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
    });
  });
});

async function withPendingHook(
  run: (options: {
    store: WatcherStore;
    hooks: Array<{ status: string; run: () => string }>;
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
