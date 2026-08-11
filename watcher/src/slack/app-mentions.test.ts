import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  handleAppMention,
  notificationTargetsForWatcherEvent,
  publishWatcherEvent,
} from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";

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
          "• `@Project Bot assign @user`",
          "  Add yourself to notifications for a tracked task. Run this in the task thread.",
          "• `@Project Bot unassign @user`",
          "  Remove yourself from notifications for a tracked task. Run this in the task thread.",
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
        [],
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
        ["section", "section", "section"],
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

  it("assigns one user to task notifications without affecting another task", async () => {
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
      store.setParentMessage(task.id, "C123", "10.000", "{}");
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
              user: "UHIROPPY",
              text: "<@UBOT> assign <@UHIROPPY>",
            },
            client,
            logger: { error: (error: unknown) => assert.fail(String(error)) },
          },
          store,
        );
      }

      assert.deepEqual(store.getTaskNotificationMentions(task.id), ["<@UHIROPPY>"]);
      assert.deepEqual(store.getTaskNotificationMentions(otherTask.id), []);
      assert.deepEqual(calls, [
        {
          method: "addReaction",
          args: { channel: "C123", name: "white_check_mark", timestamp: "20.000" },
        },
        {
          method: "addReaction",
          args: { channel: "C123", name: "white_check_mark", timestamp: "21.000" },
        },
      ]);

      const mention = {
        targets: ["<!subteam^SREVIEWERS>"],
        statuses: ["In Review"],
        events: [] as const,
      };
      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Review",
        },
        mention,
      );
      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-63",
          state: "In Review",
        },
        mention,
      );

      const notificationTexts = calls
        .filter(({ method, args }) => method === "postMessage" && args.thread_ts)
        .map(({ args }) => String(args.text));
      assert.equal(notificationTexts.length, 2);
      assert.equal(notificationTexts[0].match(/<@UHIROPPY>/g)?.length, 1);
      assert.match(notificationTexts[0], /<!subteam\^SREVIEWERS>/);
      assert.doesNotMatch(notificationTexts[1], /<@UHIROPPY>/);

      assert.deepEqual(
        notificationTargetsForWatcherEvent(
          { ...mention, targets: ["<@UHIROPPY>"] },
          "In Progress",
          "In Review",
          "updated",
          undefined,
          false,
          ["<@UHIROPPY>"],
        )?.mentions,
        ["<@UHIROPPY>"],
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
        {
          channel: "C123",
          thread_ts: "10.000",
          ts: "25.000",
          user: "U999",
          text: "<@UBOT> assign <@U123>",
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

      assert.deepEqual(store.getTaskNotificationMentions(task.id), []);
      assert.equal(calls.length, events.length - 1);
      assert.match(String(calls[0].args.text), /tracked task thread/);
      for (const call of calls.slice(1, -1)) {
        assert.equal(call.args.text, "[error] Usage: <@UBOT> `assign @user`");
        assert.equal(call.args.thread_ts, "10.000");
      }
      assert.equal(
        calls.at(-1)?.args.text,
        "[error] You can only assign yourself to task notifications.",
      );
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
        [`<!subteam^${"X".repeat(1_975)}>`],
      );

      assert.deepEqual(store.getTaskNotificationMentions(task.id), []);
      assert.match(String(calls[0].args.text), /reached Slack's text limit/);
    });
  });

  it("unassigns the requesting user from task notifications", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTaskNotificationMention(task.id, "U123");
      store.assignTaskNotificationMention(task.id, "U456");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

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
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
      );

      assert.deepEqual(store.getTaskNotificationMentions(task.id), ["<@U456>"]);
      assert.deepEqual(calls, [
        {
          method: "addReaction",
          args: { channel: "C123", name: "white_check_mark", timestamp: "20.000" },
        },
      ]);
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
      store.assignTaskNotificationMention(task.id, "U123");
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
        {
          channel: "C123",
          thread_ts: "10.000",
          ts: "23.000",
          user: "U123",
          text: "<@UBOT> unassign <@U456>",
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

      assert.deepEqual(store.getTaskNotificationMentions(task.id), ["<@U123>"]);
      assert.equal(calls.length, 3);
      assert.match(String(calls[0].args.text), /tracked task thread/);
      assert.equal(calls[1].args.text, "[error] Usage: <@UBOT> `unassign @user`");
      assert.equal(
        calls[2].args.text,
        "[error] You can only unassign yourself from task notifications.",
      );
    });
  });

  it("keeps persisted task mentions visible after configured targets expand", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      store.assignTaskNotificationMention(task.id, "U123");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await publishWatcherEvent(
        fakeClient(calls),
        store,
        "C123",
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Review",
        },
        {
          targets: [`<!subteam^${"X".repeat(1_975)}>`],
          statuses: ["In Review"],
          events: [],
        },
      );

      const notification = calls.find(
        ({ method, args }) => method === "postMessage" && args.thread_ts === "10.000",
      );
      assert.match(JSON.stringify(notification?.args.blocks), /<@U123>/);
    });
  });
});
