import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppMention, publishWatcherEvent } from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";

describe("Slack unassignment commands", () => {
  it("idempotently unassigns another user from the task", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTask(task.id, "U123");
      store.assignTask(task.id, "U456");
      const otherTask = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-63",
        state: "In Progress",
      });
      store.assignTask(otherTask.id, "U123");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      for (const ts of ["20.000", "21.000"]) {
        await handleAppMention(
          {
            event: {
              channel: "C123",
              thread_ts: "10.000",
              ts,
              user: "UREQUESTER",
              text: "<@UBOT> unassign <@U123>",
            },
            client: fakeClient(calls),
            logger: { error: (error: unknown) => assert.fail(String(error)) },
          },
          store,
        );
      }

      assert.deepEqual(store.getTaskAssignees(task.id), ["<@U456>"]);
      assert.deepEqual(store.getTaskAssignees(otherTask.id), ["<@U123>"]);
      assert.equal(calls[0].method, "update");
      assert.equal(calls[0].args.channel, "C123");
      assert.equal(calls[0].args.ts, "10.000");
      assert.match(JSON.stringify(calls[0].args.blocks), /Assignees.*@U456/s);
      assert.doesNotMatch(JSON.stringify(calls[0].args), /<@U456>/);
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

  it("assigns and unassigns a user group", async () => {
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

      for (const [ts, command] of [
        ["20.000", "assign"],
        ["21.000", "unassign"],
      ] as const) {
        await handleAppMention(
          {
            event: {
              channel: "C123",
              thread_ts: "10.000",
              ts,
              user: "UREQUESTER",
              text: `<@UBOT> ${command} <!subteam^SREVIEWERS|dev-team>`,
            },
            client,
            logger: { error: (error: unknown) => assert.fail(String(error)) },
          },
          store,
        );

        assert.deepEqual(
          store.getTaskAssignees(task.id),
          command === "assign" ? ["<!subteam^SREVIEWERS>"] : [],
        );
      }

      assert.equal(calls.filter(({ method }) => method === "addReaction").length, 2);
    });
  });

  it("rejects unassign outside tracked threads and with invalid users", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      for (const event of [
        {
          channel: "C123",
          ts: "20.000",
          user: "U123",
          text: "<@UBOT> unassign <@U123>",
        },
        {
          channel: "C123",
          thread_ts: "99.000",
          ts: "21.000",
          user: "U123",
          text: "<@UBOT> unassign <@U123>",
        },
        {
          channel: "C123",
          thread_ts: "10.000",
          ts: "22.000",
          user: "U123",
          text: "<@UBOT> unassign",
        },
      ]) {
        await handleAppMention(
          {
            event,
            client,
            logger: { error: (error: unknown) => assert.fail(String(error)) },
          },
          store,
        );
      }

      assert.deepEqual(store.getTaskAssignees(task.id), ["<@U123>"]);
      assert.equal(calls.length, 3);
      assert.match(String(calls[0].args.text), /tracked task thread/);
      assert.equal(calls[0].args.thread_ts, undefined);
      assert.match(String(calls[1].args.text), /tracked task thread/);
      assert.equal(calls[1].args.thread_ts, "99.000");
      assert.equal(
        calls[2].args.text,
        "[error] Usage: <@UBOT> `unassign @user-or-group|username|me`",
      );
    });
  });

  it("reports a confirmation failure without misreporting the completed unassignment", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const errors: unknown[] = [];

      await handleAppMention(
        {
          event: {
            channel: "C123",
            thread_ts: "10.000",
            ts: "20.000",
            user: "U123",
            text: "<@UBOT> unassign <@U123>",
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

      assert.deepEqual(store.getTaskAssignees(task.id), []);
      assert.equal(errors.length, 1);
      assert.deepEqual(calls, [
        {
          method: "postMessage",
          args: {
            channel: "C123",
            thread_ts: "10.000",
            text: "[error] The user was unassigned, but the confirmation reaction could not be added.",
          },
        },
      ]);
    });
  });

  it("reports an unassign-specific error when persistence fails", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const errors: unknown[] = [];
      const originalUnassign = store.unassignTask.bind(store);
      store.unassignTask = () => {
        throw new Error("database unavailable");
      };

      await handleAppMention(
        {
          event: {
            channel: "C123",
            thread_ts: "10.000",
            ts: "20.000",
            user: "U123",
            text: "<@UBOT> unassign <@U123>",
          },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => errors.push(error) },
        },
        store,
      );

      store.unassignTask = originalUnassign;
      assert.deepEqual(store.getTaskAssignees(task.id), ["<@U123>"]);
      assert.equal(errors.length, 1);
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].args.text,
        "[error] Failed to unassign the user from the task. No assignment was changed.",
      );
    });
  });
  it("keeps assignees out of the status timeline after default assignees expand", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });

      const notification = calls.find(
        ({ method, args }) => method === "postMessage" && args.thread_ts === "10.000",
      );
      assert.match(JSON.stringify(notification?.args.blocks), /\*Updated at\*/);
      assert.doesNotMatch(JSON.stringify(notification?.args.blocks), /Assignees|@U123/);
    });
  });
});
