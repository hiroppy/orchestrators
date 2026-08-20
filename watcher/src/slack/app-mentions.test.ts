import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppMention } from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";
import { handleSlackCommand } from "./commands/slack-command.ts";

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
          "• `@Project Bot assign @user-or-group|username|me`",
          "  Add a user or user group to notifications for a tracked task. Run this in the task thread.",
          "• `@Project Bot unassign @user-or-group|username|me`",
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

  it("runs the Slack command provided by the task service", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-60",
        issueTitle: "Build a preview",
        issueUrl: "https://linear.app/example/issue/ENG-60/preview",
        resolvedState: "In Progress",
        resolvedStateType: "started",
        pullRequest: {
          url: "https://github.com/example/service-a/pull/42",
          number: 42,
          title: "Build a preview",
          labels: ["preview"],
        },
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let received: unknown;
      let monitorStart: unknown;

      await handleAppMention(
        {
          event: {
            channel: "C123",
            ts: "20.000",
            thread_ts: "10.000",
            text: "<@UBOT> preview staging now",
            user: "U456",
          },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        "UBOT",
        undefined,
        undefined,
        (serviceName) =>
          serviceName === "service-a"
            ? [
                {
                  command: "preview",
                  run: async (context, helpers) => {
                    received = context;
                    assert.equal(helpers.slack.channelId, "C123");
                    assert.equal(helpers.slack.messageTs, "20.000");
                    assert.equal(helpers.slack.threadTs, "10.000");
                    await helpers.slack.client.reactions.add({
                      channel: helpers.slack.channelId,
                      timestamp: helpers.slack.messageTs,
                      name: "eyes",
                    });
                    await helpers.slack.postMessage({ text: "Starting preview" });
                    await helpers.pullRequestMonitors.start(
                      {
                        id: "deployment",
                        run: () => ({ status: "pending" }),
                      },
                      { metadata: { environment: "staging" } },
                    );
                    return "Preview ready";
                  },
                },
              ]
            : [],
        async (startedTask, monitor, trigger) => {
          monitorStart = { taskId: startedTask.id, monitorId: monitor.id, trigger };
        },
      );

      assert.deepEqual(received, {
        service: "service-a",
        command: "preview",
        args: ["staging", "now"],
        user: "U456",
        issue: {
          identifier: "ENG-60",
          url: "https://linear.app/example/issue/ENG-60/preview",
          title: "Build a preview",
          status: "In Progress",
        },
        pullRequest: {
          url: "https://github.com/example/service-a/pull/42",
          number: 42,
          title: "Build a preview",
          labels: ["preview"],
        },
      });
      assert.deepEqual(
        calls.map(({ args }) => args),
        [
          { channel: "C123", timestamp: "20.000", name: "eyes" },
          { channel: "C123", text: "Starting preview" },
          { channel: "C123", thread_ts: "10.000", text: "Preview ready" },
        ],
      );
      assert.deepEqual(monitorStart, {
        taskId: "service-a:ENG-60",
        monitorId: "deployment",
        trigger: {
          command: "preview",
          args: ["staging", "now"],
          user: "U456",
          metadata: { environment: "staging" },
        },
      });
    });
  });

  it("exposes only public pull request fields to Slack commands", async () => {
    await withStore(async (store) => {
      let received: unknown;

      await handleSlackCommand(
        {
          command: "preview",
          run: ({ pullRequest }) => {
            received = pullRequest;
          },
        },
        {
          id: "service-a:ENG-60",
          serviceName: "service-a",
          issueIdentifier: "ENG-60",
          title: "Build a preview",
          status: "In Progress",
          updatedAt: "2026-08-19T00:00:00.000Z",
          pullRequest: {
            url: "https://github.com/example/service-a/pull/42",
            number: 42,
            title: "Build a preview",
            body: "Internal PR body",
            state: "OPEN",
            isDraft: false,
            reviewDecision: "APPROVED",
            mergeable: "MERGEABLE",
            headRefName: "feature/preview",
            headRefOid: "abc123",
            baseRefName: "main",
            repository: "example/service-a",
            labels: ["preview"],
            reactions: ["ROCKET"],
            latestReviewCommentAt: "2026-08-19T01:00:00.000Z",
          },
        },
        {
          event: {
            channel: "C123",
            ts: "20.000",
            threadTs: "10.000",
            text: "<@UBOT> preview",
            botMention: "<@UBOT>",
            botUserId: "UBOT",
          },
          client: fakeClient([]),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
          store,
          args: [],
        },
      );

      assert.deepEqual(received, {
        url: "https://github.com/example/service-a/pull/42",
        number: 42,
        title: "Build a preview",
        state: "OPEN",
        isDraft: false,
        reviewDecision: "APPROVED",
        headRefName: "feature/preview",
        headRefOid: "abc123",
        labels: ["preview"],
      });
    });
  });

  it("runs Slack commands whose names match Object prototype properties", async () => {
    await withStore(async (store) => {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-60",
        resolvedState: "In Progress",
      });
      store.setParentMessage(task.id, "C123", "10.000", "{}");
      let runs = 0;

      await handleAppMention(
        {
          event: {
            channel: "C123",
            ts: "20.000",
            thread_ts: "10.000",
            text: "<@UBOT> constructor",
          },
          client: fakeClient([]),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        "UBOT",
        undefined,
        undefined,
        () => [
          {
            command: "constructor",
            run: () => {
              runs += 1;
            },
          },
        ],
      );

      assert.equal(runs, 1);
    });
  });

  it("does not run a service Slack command outside its tracked task thread", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let runs = 0;
      const commands = () => [
        {
          command: "preview",
          run: () => {
            runs += 1;
          },
        },
      ];

      await handleAppMention(
        {
          event: { channel: "C123", ts: "20.000", text: "<@UBOT> preview" },
          client: fakeClient(calls),
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        "UBOT",
        undefined,
        undefined,
        commands,
      );

      assert.equal(runs, 0);
      assert.deepEqual(calls, []);
    });
  });
});
