import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppMention, publishWatcherEvent } from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";
import { buildTaskCard } from "./views.ts";

describe("Slack assignment commands", () => {
  it("assigns one user to the task without affecting another task", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const otherTask = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-63",
        state: "In Progress",
      });
      store.setParentMessage(
        task.id,
        "C123",
        "10.000",
        JSON.stringify(
          buildTaskCard(task, ["In Progress"], {
            type: "started",
            service: "service-a",
            issueIdentifier: "ENG-62",
          }),
        ),
      );
      store.setParentMessage(otherTask.id, "C123", "11.000", "{}");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      for (const ts of ["20.000", "21.000"]) {
        await handleAppMention(
          {
            event: {
              channel: "C123",
              thread_ts: "10.000",
              ts,
              user: "UREQUESTER",
              text: "<@UBOT> assign <@UHIROPPY>",
            },
            client,
            logger: { error: (error: unknown) => assert.fail(String(error)) },
          },
          store,
        );
      }

      assert.deepEqual(store.getTaskAssignees(task.id), ["<@UHIROPPY>"]);
      assert.deepEqual(store.getTaskAssignees(otherTask.id), []);
      assert.equal(calls[0].method, "update");
      assert.equal(calls[0].args.channel, "C123");
      assert.equal(calls[0].args.ts, "10.000");
      assert.match(JSON.stringify(calls[0].args.blocks), /Assignees.*@UHIROPPY/s);
      assert.match(JSON.stringify(calls[0].args.blocks), /Event.*Started/s);
      assert.doesNotMatch(JSON.stringify(calls[0].args), /<@UHIROPPY>/);
      assert.match(String(calls[0].args.text), /Assigned to @UHIROPPY/);
      assert.equal(calls.filter(({ method }) => method === "update").length, 2);
      assert.deepEqual(
        calls.filter(({ method }) => method === "addReaction"),
        [
          {
            method: "addReaction",
            args: { channel: "C123", name: "white_check_mark", timestamp: "20.000" },
          },
          {
            method: "addReaction",
            args: { channel: "C123", name: "white_check_mark", timestamp: "21.000" },
          },
        ],
      );
    });
  });

  it("assigns and unassigns by bare username and me", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls, {
        UHIROPPY: "hiroppy",
        UREQUESTER: "requester",
      });

      for (const [ts, command, assignee, expected] of [
        ["20.000", "assign", "Hiroppy", ["<@UHIROPPY>"]],
        ["21.000", "assign", "me", ["<@UHIROPPY>", "<@UREQUESTER>"]],
        ["22.000", "unassign", "hiroppy", ["<@UREQUESTER>"]],
        ["23.000", "unassign", "ME", []],
      ] as const) {
        await handleAppMention(
          {
            event: {
              channel: "C123",
              thread_ts: "10.000",
              ts,
              user: "UREQUESTER",
              text: `<@UBOT> ${command} ${assignee}`,
            },
            client,
            logger: { error: (error: unknown) => assert.fail(String(error)) },
          },
          store,
          "UBOT",
        );

        assert.deepEqual(store.getTaskAssignees(task.id), expected);
      }

      assert.equal(calls.filter(({ method }) => method === "usersList").length, 2);
      assert.equal(calls.filter(({ method }) => method === "addReaction").length, 4);
    });
  });

  it("serializes assignment refreshes behind watcher card updates", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(
        task.id,
        "C123",
        "10.000",
        JSON.stringify(buildTaskCard(task, ["In Progress", "In Review"])),
      );
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const firstUpdateStarted = Promise.withResolvers<void>();
      const releaseFirstUpdate = Promise.withResolvers<void>();
      const update = client.chat.update;
      let updateCount = 0;
      client.chat.update = async (args) => {
        updateCount += 1;
        if (updateCount === 1) {
          firstUpdateStarted.resolve();
          await releaseFirstUpdate.promise;
        }
        return update(args);
      };

      const publish = publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      await firstUpdateStarted.promise;
      const assign = handleAppMention(
        {
          event: {
            channel: "C123",
            thread_ts: "10.000",
            ts: "20.000",
            user: "U123",
            text: "<@UBOT> assign <@U123>",
          },
          client,
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        "UBOT",
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(updateCount, 1);

      releaseFirstUpdate.resolve();
      await Promise.all([publish, assign]);

      const lastUpdate = calls.filter(({ method }) => method === "update").at(-1);
      assert.match(JSON.stringify(lastUpdate?.args), /In Review/);
      assert.equal(
        calls.some(({ method, args }) => method === "update" && /@U123/.test(JSON.stringify(args))),
        true,
      );
    });
  });

  it("rejects assign commands outside tracked threads and with invalid arguments", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const events = [
        { channel: "C123", ts: "20.000", text: "<@UBOT> assign <@U123>" },
        {
          channel: "C123",
          thread_ts: "99.000",
          ts: "21.000",
          text: "<@UBOT> assign <@U123>",
        },
        { channel: "C123", thread_ts: "10.000", ts: "22.000", text: "<@UBOT> assign" },
        {
          channel: "C123",
          thread_ts: "10.000",
          ts: "23.000",
          text: "<@UBOT> assign hiroppy",
        },
        {
          channel: "C123",
          thread_ts: "10.000",
          ts: "24.000",
          text: "<@UBOT> assign <@U123> <@U456>",
        },
      ];

      for (const event of events) {
        await handleAppMention(
          {
            event,
            client,
            logger: { error: (error: unknown) => assert.fail(String(error)) },
          },
          store,
        );
      }

      assert.deepEqual(store.getTaskAssignees(task.id), []);
      assert.equal(calls.length, events.length - 1);
      assert.match(String(calls[0].args.text), /tracked task thread/);
      for (const call of calls.slice(1)) {
        assert.equal(call.args.text, "[error] Usage: <@UBOT> `assign @user-or-group|username|me`");
        assert.equal(call.args.thread_ts, "10.000");
      }
    });
  });

  it("rejects an assignment that would exceed Slack's mention field limit", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTask(task.id, `U${"X".repeat(1_990)}`);
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await handleAppMention(
        {
          event: {
            channel: "C123",
            thread_ts: "10.000",
            ts: "20.000",
            user: "U123",
            text: "<@UBOT> assign <@U123>",
          },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        "UBOT",
      );

      assert.equal(store.getTaskAssignees(task.id).length, 1);
      assert.match(String(calls[0].args.text), /reached Slack's text limit/);
    });
  });

  it("reports an assign-specific error when persistence fails", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const errors: unknown[] = [];
      const originalAssign = store.assignTask.bind(store);
      store.assignTask = () => {
        throw new Error("database unavailable");
      };

      await handleAppMention(
        {
          event: {
            channel: "C123",
            thread_ts: "10.000",
            ts: "20.000",
            user: "U123",
            text: "<@UBOT> assign <@U123>",
          },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => errors.push(error) },
        },
        store,
        "UBOT",
      );

      store.assignTask = originalAssign;
      assert.deepEqual(store.getTaskAssignees(task.id), []);
      assert.equal(errors.length, 1);
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].args.text,
        "[error] Failed to assign the user to the task. No assignment was changed.",
      );
    });
  });

  it("reports an assign-specific error when user lookup fails", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const errors: unknown[] = [];
      const client = fakeClient(calls, { UHIROPPY: "hiroppy" });
      client.users.list = async () => {
        throw new Error("users.list unavailable");
      };

      await handleAppMention(
        {
          event: {
            channel: "C123",
            thread_ts: "10.000",
            ts: "20.000",
            user: "UREQUESTER",
            text: "<@UBOT> assign hiroppy",
          },
          client,
          logger: { error: (error: unknown) => errors.push(error) },
        },
        store,
        "UBOT",
      );

      assert.deepEqual(store.getTaskAssignees(task.id), []);
      assert.equal(errors.length, 1);
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].args.text,
        "[error] Failed to assign the user to the task. No assignment was changed.",
      );
    });
  });

  it("reports a confirmation failure without misreporting the completed assignment", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const errors: unknown[] = [];

      await handleAppMention(
        {
          event: {
            channel: "C123",
            thread_ts: "10.000",
            ts: "20.000",
            user: "U123",
            text: "<@UBOT> assign <@U123>",
          },
          client: {
            reactions: {
              add: async () => {
                throw new Error("reaction unavailable");
              },
            },
            chat: {
              update: async () => ({ ok: true }),
              postMessage: async (args: Record<string, unknown>) => {
                calls.push({ method: "postMessage", args });
                return { ok: true };
              },
            },
          } as never,
          logger: { error: (error: unknown) => errors.push(error) },
        },
        store,
      );

      assert.deepEqual(store.getTaskAssignees(task.id), ["<@U123>"]);
      assert.equal(errors.length, 1);
      assert.deepEqual(calls, [
        {
          method: "postMessage",
          args: {
            channel: "C123",
            thread_ts: "10.000",
            text: "[error] The user was assigned, but the confirmation reaction could not be added.",
          },
        },
      ]);
    });
  });
});
