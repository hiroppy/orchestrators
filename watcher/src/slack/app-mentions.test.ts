import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppMention, publishWatcherEvent } from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";
import { buildTaskCard } from "./views.ts";

describe("Slack mention commands", () => {
  it("replies to an exact help mention with the available commands", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await handleAppMention(
        {
          event: { channel: "C999", ts: "20.000", text: "<@U123> help" },
          client: fakeClient(calls, { U123: "Project Bot" }),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
      );

      assert.deepEqual(calls[0], { method: "usersInfo", args: { user: "U123" } });
      assert.equal(calls.length, 2);
      assert.equal(calls[1].method, "postMessage");
      assert.equal(calls[1].args.channel, "C999");
      assert.equal(
        calls[1].args.text,
        [
          "*Available commands*",
          "• `@Project Bot status`",
          "  Show tracked Todo, In Progress, and In Review tasks.",
          "• `@Project Bot assign @user-or-group`",
          "  Add a user or user group to notifications for a tracked task. Run this in the task thread.",
          "• `@Project Bot unassign @user-or-group`",
          "  Remove a user or user group from notifications for a tracked task. Run this in the task thread.",
          "• `@Project Bot take-pr <GitHub PR URL>`",
          "  Create a Linear issue for an existing open pull request.",
          "• `@Project Bot help`",
          "  Show this help message.",
        ].join("\n"),
      );
      assert.match(
        JSON.stringify(calls[1].args.blocks),
        /Available commands.*Project Bot.*assign/s,
      );
    });
  });

  it("parses the command after the configured bot mention", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await handleAppMention(
        {
          event: {
            channel: "C999",
            ts: "20.000",
            text: "<@UCOLLEAGUE> hello <@UBOT> help",
          },
          client: fakeClient(calls, { UBOT: "Project Bot" }),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        "UBOT",
      );

      assert.deepEqual(calls[0], { method: "usersInfo", args: { user: "UBOT" } });
      assert.equal(calls[1].method, "postMessage");
      assert.match(String(calls[1].args.text), /@Project Bot help/);
    });
  });

  it("reports a help-specific error when the help response cannot be posted", async () => {
    await withStore(async (store) => {
      const messages: Array<Record<string, unknown>> = [];
      let postAttempts = 0;

      await handleAppMention(
        {
          event: { channel: "C999", ts: "20.000", text: "<@UBOT> help" },
          client: {
            users: {
              info: async () => ({
                ok: true,
                user: { profile: { display_name: "Project Bot" } },
              }),
            },
            chat: {
              postMessage: async (message: Record<string, unknown>) => {
                postAttempts += 1;
                if (postAttempts === 1) throw new Error("help unavailable");
                messages.push(message);
                return { ok: true };
              },
            },
          } as never,
          logger: { error: () => {} },
        },
        store,
      );

      assert.equal(messages.length, 1);
      assert.equal(messages[0].text, "[error] Failed to show the available commands.");
      assert.doesNotMatch(String(messages[0].text), /current task status/);
    });
  });

  it("replies to an exact status mention with tracked tasks grouped by status", async () => {
    await withStore(async (store) => {
      const todo = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-60",
        issueTitle: "Plan the change",
        issueUrl: "https://linear.app/example/issue/ENG-60/plan",
        resolvedState: "Todo",
        resolvedStateType: "unstarted",
      });
      store.setParentMessage(todo.id, "C123", "10.000", "{}");
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-61",
        issueTitle: "Build the change",
        issueUrl: "https://linear.app/example/issue/ENG-61/build",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-99",
        issueTitle: "Already shipped",
        resolvedState: "Done",
        resolvedStateType: "completed",
      });
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await handleAppMention(
        {
          event: { channel: "C999", ts: "20.000", text: "<@U123> status" },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        undefined,
        undefined,
        {
          serviceNames: ["service-a", "service-b"],
          startedAt: new Date(2026, 7, 12, 11, 0),
        },
      );

      assert.deepEqual(calls[0], {
        method: "getPermalink",
        args: { channel: "C123", message_ts: "10.000" },
      });
      assert.equal(calls[1].method, "postMessage");
      assert.equal(calls[1].args.channel, "C999");
      assert.equal(calls[1].args.unfurl_links, false);
      assert.equal(calls[1].args.unfurl_media, false);
      assert.equal(
        calls[1].args.text,
        [
          "*Running services (Started at 08/12 11:00)*",
          "• service-a",
          "• service-b",
          "",
          "*Todo (1)*",
          "• [service-a] ENG-60: Plan the change",
          "  <https://example.slack.com/archives/C123/p10000|Slack> | <https://linear.app/example/issue/ENG-60/plan|Linear>",
          "",
          "*In Progress (1)*",
          "• [service-a] ENG-61: Build the change",
          "  <https://linear.app/example/issue/ENG-61/build|Linear>",
          "",
          "*In Review (0)*",
          "• None",
        ].join("\n"),
      );
      const blocks = calls[1].args.blocks as Array<{ type: string }>;
      assert.deepEqual(
        blocks.map(({ type }) => type),
        ["section", "section", "section", "section"],
      );
      assert.match(JSON.stringify(blocks), /Slack.*Linear.*ENG-61/s);
    });
  });

  it("ignores unknown commands and arguments unsupported by status or help", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await handleAppMention(
        {
          event: { channel: "C999", ts: "20.000", text: "<@U123> status please" },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
      );
      await handleAppMention(
        {
          event: { channel: "C999", ts: "20.500", text: "<@U123> help please" },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
      );
      await handleAppMention(
        {
          event: { channel: "C999", ts: "21.000", text: "<@U123> unknown" },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
      );

      assert.deepEqual(calls, []);
    });
  });

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
        assert.equal(call.args.text, "[error] Usage: <@UBOT> `assign @user-or-group`");
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
      assert.equal(calls[2].args.text, "[error] Usage: <@UBOT> `unassign @user-or-group`");
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
