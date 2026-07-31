import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDatabase } from "../persistence/database.ts";
import {
  handleStatusAction,
  handleThreadReply,
  publishWatcherStarted,
  publishWatcherEvent,
  type SlackThreadReply,
} from "./app.ts";
import { WatcherStore } from "../persistence/store.ts";

describe("Slack app behavior", () => {
  it("posts one top-level channel message when the watcher starts", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

    await publishWatcherStarted(fakeClient(calls), "C123", ["service-a", "service-b", "service-c"]);

    assert.deepEqual(calls, [
      {
        method: "postMessage",
        args: {
          channel: "C123",
          text: [
            "Watcher started | monitoring 3 services",
            "- service-a",
            "- service-b",
            "- service-c",
          ].join("\n"),
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "Watcher started | monitoring 3 services",
                    },
                  ],
                },
                {
                  type: "rich_text_list",
                  style: "bullet",
                  elements: [
                    {
                      type: "rich_text_section",
                      elements: [{ type: "text", text: "service-a" }],
                    },
                    {
                      type: "rich_text_section",
                      elements: [{ type: "text", text: "service-b" }],
                    },
                    {
                      type: "rich_text_section",
                      elements: [{ type: "text", text: "service-c" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("updates one parent while suppressing routine lifecycle thread noise", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });

      const topLevelPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && !args.thread_ts,
      );
      const threadPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && args.thread_ts,
      );
      const updates = calls.filter(({ method }) => method === "update");

      assert.equal(topLevelPosts.length, 1);
      assert.equal(threadPosts.length, 1);
      assert.equal(updates.length, 2);
      assert.equal(updates[0].args.ts, "1.000");
      assert.deepEqual(
        (threadPosts[0].args.blocks as Array<{ type: string }>).map(({ type }) => type),
        ["section", "context"],
      );

      const initialActions = (topLevelPosts[0].args.blocks as Array<Record<string, unknown>>).find(
        ({ type }) => type === "actions",
      ) as {
        block_id: string;
      };
      const updatedActions = (updates[0].args.blocks as Array<Record<string, unknown>>).find(
        ({ type }) => type === "actions",
      ) as {
        block_id: string;
        elements: Array<{ initial_option: { value: string } }>;
      };
      assert.notEqual(updatedActions.block_id, initialActions.block_id);
      assert.equal(updatedActions.elements[0].initial_option.value, "In Review");
    });
  });

  it("posts an existing parent permalink once when the issue enters a terminal state", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const issueUrl = "https://linear.app/example/issue/ENG-62/example";

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        issueUrl,
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        issueUrl,
        resolvedState: "Done",
        resolvedStateType: "completed",
        relatedIssues: [
          {
            identifier: "ENG-63",
            title: "Deploy the merged change",
            url: "https://linear.app/example/issue/ENG-63/deploy",
          },
          {
            identifier: "ENG-64",
            title: "Verify production",
            url: "https://linear.app/example/issue/ENG-64/verify",
          },
        ],
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        issueUrl,
        resolvedState: "Done",
        resolvedStateType: "completed",
      });

      const topLevelPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && !args.thread_ts,
      );
      assert.equal(topLevelPosts.length, 2);
      assert.match(JSON.stringify(topLevelPosts[0].args.blocks), new RegExp(issueUrl));
      assert.deepEqual(topLevelPosts[1].args, {
        channel: "C123",
        text: "Task closed | *Done*\nhttps://example.slack.com/archives/C123/p1000",
      });
      assert.deepEqual(
        calls
          .filter(({ method, args }) => method === "postMessage" && args.thread_ts === "2.000")
          .map(({ args }) => args.text),
        [
          "Next task | <https://linear.app/example/issue/ENG-63/deploy|ENG-63: Deploy the merged change>",
          "Next task | <https://linear.app/example/issue/ENG-64/verify|ENG-64: Verify production>",
        ],
      );
      assert.equal(store.getTask("service-a:ENG-62")?.parentMessageTs, "1.000");
      assert.deepEqual(
        calls.filter(({ method }) => method === "update").map(({ args }) => args.ts),
        ["1.000", "1.000"],
      );
    });
  });

  it("continues without repeating a closed notification when a related reply fails", async (context) => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const errors: unknown[][] = [];
      context.mock.method(console, "error", (...args) => errors.push(args));
      const postMessage = client.chat.postMessage;
      client.chat.postMessage = async (args) => {
        if (String(args.text).includes("ENG-64")) {
          throw new Error("Slack related issue post failed");
        }
        return postMessage(args);
      };

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      const terminalEvent = {
        type: "updated" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "Done",
        resolvedStateType: "completed",
        relatedIssues: [
          {
            identifier: "ENG-63",
            title: "First next task",
            url: "https://linear.app/example/issue/ENG-63/first",
          },
          {
            identifier: "ENG-64",
            title: "Second next task",
            url: "https://linear.app/example/issue/ENG-64/second",
          },
          {
            identifier: "ENG-65",
            title: "Third next task",
            url: "https://linear.app/example/issue/ENG-65/third",
          },
        ],
      };

      await publishWatcherEvent(client, store, "C123", terminalEvent);
      await publishWatcherEvent(client, store, "C123", terminalEvent);

      assert.equal(
        calls.filter(
          ({ method, args }) =>
            method === "postMessage" && String(args.text).startsWith("Task closed"),
        ).length,
        1,
      );
      assert.equal(
        calls.filter(
          ({ method, args }) => method === "postMessage" && String(args.text).includes("ENG-63"),
        ).length,
        1,
      );
      assert.equal(
        calls.filter(
          ({ method, args }) => method === "postMessage" && String(args.text).includes("ENG-65"),
        ).length,
        1,
      );
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "completed");
      assert.equal(errors.length, 1);
      assert.match(String(errors[0][0]), /Failed to post related issue ENG-64/);
    });
  });

  it("mentions on configured status entry and configured events without repeating otherwise", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const mention = {
        target: "<!subteam^S123>",
        statuses: ["In Review"],
        events: ["blocked"] as const,
      };

      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "started",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Progress",
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
          type: "blocked",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Review",
        },
        mention,
      );

      const threadTexts = calls
        .filter(({ method, args }) => method === "postMessage" && args.thread_ts)
        .map(({ args }) => String(args.text));
      assert.equal(threadTexts.length, 2);
      assert.match(threadTexts[0], /\| Attention: <!subteam\^S123>/);
      assert.match(threadTexts[1], /\| <!subteam\^S123>/);
    });
  });

  it("posts only status transitions and pull request links to the thread", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Build the Slack control plane",
        issueUrl: "https://linear.app/acme/issue/ENG-62/example",
        state: "running",
        resolvedState: "Todo",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        activity: "item started: reasoning",
        state: "running",
        resolvedState: "Todo",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "running",
        resolvedState: "In Progress",
      });
      store.addEvent({
        taskId: "service-a:ENG-62",
        type: "workpad_replied",
        actor: "U123",
        body: "Please review https://github.com/acme/example/pull/42",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "running",
        resolvedState: "In Progress",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          number: 42,
        },
      });
      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "running",
          resolvedState: "In Review",
          pullRequest: {
            url: "https://github.com/acme/example/pull/42",
            number: 42,
          },
        },
        {
          target: "<@UHIROPPY>",
          statuses: ["In Review"],
          events: [],
        },
      );

      const threadTexts = calls
        .filter(({ method, args }) => method === "postMessage" && args.thread_ts)
        .map(({ args }) => String(args.text));
      assert.equal(threadTexts.length, 3);
      assert.match(
        threadTexts[0],
        /^\*Todo\* → \*In Progress\*\nEvent: Updated \| UpdatedAt: <!date[^\n]+>$/,
      );
      assert.equal(
        threadTexts[1],
        "*PR created* | <https://github.com/acme/example/pull/42|PR#42>",
      );
      assert.match(
        threadTexts[2],
        /^\*In Progress\* → \*In Review\*\nEvent: Updated \| UpdatedAt: <!date[^\n]+>\n<https:\/\/github\.com\/acme\/example\/pull\/42\|PR#42>$/,
      );
      const statusTransitionBlocks = calls.filter(
        ({ method, args }) => method === "postMessage" && args.thread_ts,
      )[2].args.blocks as Array<Record<string, unknown>>;
      assert.deepEqual(
        statusTransitionBlocks.map(({ type }) => type),
        ["section", "context"],
      );
      assert.equal(
        (statusTransitionBlocks[0].text as { text: string }).text,
        "*In Progress* → *In Review*",
      );
      assert.match(
        (statusTransitionBlocks[1].elements as Array<{ text: string }>)[0].text,
        /^Event: Updated \| UpdatedAt: <!date[^\n]+>\n<https:\/\/github\.com\/acme\/example\/pull\/42\|PR#42>$/,
      );
      assert.equal(
        store.getTask("service-a:ENG-62")?.linkUrl,
        "https://linear.app/acme/issue/ENG-62/example",
      );
      const latestCardUpdate = calls.findLast(({ method }) => method === "update");
      assert.match(JSON.stringify(latestCardUpdate?.args.blocks), /github\.com/);
    });
  });

  it("acks first, accepts backward transitions, updates the card, and writes thread history", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueUrl: "https://linear.app/example/issue/ENG-62/title",
        state: "In Review",
      });
      calls.length = 0;
      let acknowledged = false;
      const linearUpdates: string[] = [];

      await handleStatusAction(
        {
          ack: async () => {
            acknowledged = true;
          },
          action: { selected_option: { value: "Rework" } },
          body: {
            user: { id: "U123" },
            message: {
              metadata: {
                event_payload: { task_id: "service-a:ENG-62" },
              },
            },
          },
          client: {
            chat: {
              postMessage: async (args) => {
                assert.equal(acknowledged, true);
                return client.chat.postMessage(args);
              },
              update: async (args) => {
                assert.equal(acknowledged, true);
                return client.chat.update(args);
              },
            },
            users: {
              info: async ({ user }) => ({
                ok: true,
                user: {
                  id: user,
                  profile: { display_name: "Example User" },
                },
              }),
            },
          },
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        async (task, status) => {
          assert.equal(task.issueIdentifier, "ENG-62");
          linearUpdates.push(status);
        },
      );

      assert.deepEqual(linearUpdates, ["Rework"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "Rework");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      assert.match(
        JSON.stringify(calls.find(({ method }) => method === "update")?.args.blocks),
        /linear\.app/,
      );
      assert.match(
        String(calls.find(({ method }) => method === "postMessage")?.args.text),
        /\*In Review\* → \*Rework\* \| Example User/,
      );
    });
  });

  it("keeps the database unchanged when the Slack card update fails", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const errors: unknown[] = [];
      let linearUpdated = false;

      await handleStatusAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "Done" } },
          body: {
            user: { id: "U123" },
            message: {
              metadata: {
                event_payload: { task_id: "service-a:ENG-62" },
              },
            },
          },
          client: {
            chat: {
              postMessage: client.chat.postMessage,
              update: async () => {
                throw new Error("Slack update failed");
              },
            },
          },
          logger: { error: (error) => errors.push(error) },
        },
        store,
        async () => {
          linearUpdated = true;
        },
      );

      assert.equal(linearUpdated, true);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
      assert.equal(errors.length, 1);
    });
  });

  it("serializes concurrent status changes for the same task", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      calls.length = 0;

      let releaseFirst!: () => void;
      const firstUpdate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const linearUpdates: string[] = [];
      const updateLinearStatus = async (_task: unknown, status: string) => {
        linearUpdates.push(status);
        if (status === "Rework") await firstUpdate;
      };
      const action = (status: string) =>
        handleStatusAction(
          {
            ack: async () => {},
            action: { selected_option: { value: status } },
            body: {
              user: { id: "U123" },
              message: {
                metadata: {
                  event_payload: { task_id: "service-a:ENG-62" },
                },
              },
            },
            client,
            logger: { error: (error) => assert.fail(String(error)) },
          },
          store,
          updateLinearStatus,
        );

      const first = action("Rework");
      const second = action("Done");
      await waitFor(() => linearUpdates.length === 1);
      assert.deepEqual(linearUpdates, ["Rework"]);

      releaseFirst();
      await Promise.all([first, second]);

      assert.deepEqual(linearUpdates, ["Rework", "Done"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "Done");
    });
  });

  it("copies text, image-with-text, and image-only replies once", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const replies: Array<{ issueIdentifier: string; reply: SlackThreadReply }> = [];
      const reactions: Array<Record<string, unknown>> = [];
      const args = {
        message: {
          channel: "C123",
          thread_ts: "1.000",
          ts: "2.000",
          user: "U123",
          text: "Please cover the retry path.",
          subtype: "thread_broadcast",
        },
        client: reactionClient(reactions),
        logger: { error: (error: unknown) => assert.fail(String(error)) },
      };
      const reply = async (task: { issueIdentifier: string }, reply: SlackThreadReply) => {
        replies.push({ issueIdentifier: task.issueIdentifier, reply });
        return true;
      };

      await Promise.all([
        handleThreadReply(args, store, reply),
        handleThreadReply(args, store, reply),
      ]);
      await handleThreadReply(
        {
          ...args,
          message: {
            ...args.message,
            ts: "3.000",
            text: "Screenshot attached.",
            subtype: "file_share",
            files: [
              {
                name: "first screenshot.png",
                mimetype: "image/png",
                url_private: "https://files.slack.com/files-pri/first",
                url_private_download: "https://files.slack.com/files-pri/first/download",
              },
              {
                name: "second screenshot.jpg",
                mimetype: "image/jpeg",
                url_private: "https://files.slack.com/files-pri/second",
              },
            ],
          },
        },
        store,
        reply,
      );
      await handleThreadReply(
        {
          ...args,
          message: {
            ...args.message,
            ts: "4.000",
            text: "",
            subtype: "file_share",
            files: [
              {
                name: "image only.gif",
                mimetype: "image/gif",
                url_private: "https://files.slack.com/files-pri/image-only",
              },
            ],
          },
        },
        store,
        reply,
      );

      assert.deepEqual(replies, [
        {
          issueIdentifier: "ENG-62",
          reply: {
            text: "Please cover the retry path.",
            images: [],
          },
        },
        {
          issueIdentifier: "ENG-62",
          reply: {
            text: "Screenshot attached.",
            images: [
              {
                filename: "first screenshot.png",
                contentType: "image/png",
                downloadUrl: "https://files.slack.com/files-pri/first/download",
              },
              {
                filename: "second screenshot.jpg",
                contentType: "image/jpeg",
                downloadUrl: "https://files.slack.com/files-pri/second",
              },
            ],
          },
        },
        {
          issueIdentifier: "ENG-62",
          reply: {
            text: "",
            images: [
              {
                filename: "image only.gif",
                contentType: "image/gif",
                downloadUrl: "https://files.slack.com/files-pri/image-only",
              },
            ],
          },
        },
      ]);
      assert.deepEqual(reactions, [
        { channel: "C123", name: "white_check_mark", timestamp: "2.000" },
        { channel: "C123", name: "white_check_mark", timestamp: "3.000" },
        { channel: "C123", name: "white_check_mark", timestamp: "4.000" },
      ]);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 3);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_reply_acknowledged"), 3);
    });
  });

  it("preserves the order of concurrent replies in the same thread", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      let releaseFirst!: () => void;
      const firstReply = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstPending = true;
      const replies: string[] = [];
      const reply = async (_task: unknown, reply: { text: string }) => {
        if (reply.text === "second") assert.equal(firstPending, false);
        replies.push(reply.text);
        if (reply.text === "first") await firstReply;
        return true;
      };
      const args = (ts: string, text: string) => ({
        message: {
          channel: "C123",
          thread_ts: "1.000",
          ts,
          user: "U123",
          text,
        },
        client: reactionClient([]),
        logger: { error: (error: unknown) => assert.fail(String(error)) },
      });

      const first = handleThreadReply(args("2.000", "first"), store, reply);
      await waitFor(() => replies.length === 1);
      const second = handleThreadReply(args("3.000", "second"), store, reply);

      firstPending = false;
      releaseFirst();
      await Promise.all([first, second]);

      assert.deepEqual(replies, ["first", "second"]);
    });
  });

  it("ignores non-user, empty, and unrelated thread messages", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const messages = [
        { channel: "C123", thread_ts: "1.000", ts: "2.000", user: "U123", text: " " },
        {
          channel: "C123",
          thread_ts: "1.000",
          ts: "2.500",
          user: "U123",
          text: "",
          subtype: "file_share",
          files: [
            {
              name: "notes.pdf",
              mimetype: "application/pdf",
              url_private: "https://files.slack.com/files-pri/notes",
            },
          ],
        },
        {
          channel: "C123",
          thread_ts: "1.000",
          ts: "3.000",
          user: "U123",
          text: "edited",
          subtype: "message_changed",
        },
        {
          channel: "C123",
          thread_ts: "1.000",
          ts: "4.000",
          user: "U123",
          text: "bot",
          bot_id: "B123",
        },
        {
          channel: "C123",
          thread_ts: "999.000",
          ts: "5.000",
          user: "U123",
          text: "unrelated",
        },
        { channel: "C123", ts: "6.000", user: "U123", text: "top-level" },
      ];
      let replyCount = 0;

      for (const message of messages) {
        await handleThreadReply(
          {
            message,
            client: reactionClient([]),
            logger: { error: (error) => assert.fail(String(error)) },
          },
          store,
          async () => {
            replyCount += 1;
            return true;
          },
        );
      }

      assert.equal(replyCount, 0);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 0);
    });
  });

  it("leaves missing Workpads and Linear failures unrecorded", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const errors: unknown[] = [];
      const reactions: Array<Record<string, unknown>> = [];
      const args = {
        message: {
          channel: "C123",
          thread_ts: "1.000",
          ts: "2.000",
          user: "U123",
          text: "Please update the Workpad.",
        },
        client: reactionClient(reactions),
        logger: { error: (error: unknown) => errors.push(error) },
      };

      await handleThreadReply(args, store, async () => false);
      await handleThreadReply(args, store, async () => {
        throw new Error("Linear unavailable");
      });

      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 0);
      assert.deepEqual(reactions, []);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /Linear unavailable/);
    });
  });

  it("retries an unacknowledged copied reply on redelivery without calling Linear again", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const errors: unknown[] = [];
      let reactionAttempts = 0;
      const args = {
        message: {
          channel: "C123",
          thread_ts: "1.000",
          ts: "2.000",
          user: "U123",
          text: "Please update the Workpad.",
        },
        client: {
          reactions: {
            async add() {
              reactionAttempts += 1;
              if (reactionAttempts === 1) {
                throw new Error("Slack unavailable");
              }
            },
          },
        },
        logger: { error: (error: unknown) => errors.push(error) },
      };
      let replyCount = 0;
      const reply = async () => {
        replyCount += 1;
        return true;
      };

      await handleThreadReply(args, store, reply);
      await handleThreadReply(args, store, reply);

      assert.equal(replyCount, 1);
      assert.equal(reactionAttempts, 2);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 1);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_reply_acknowledged"), 1);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /Slack unavailable/);
    });
  });

  it("retries transient failures while adding the copied-reply reaction", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      let reactionAttempts = 0;
      const args = {
        message: {
          channel: "C123",
          thread_ts: "1.000",
          ts: "2.000",
          user: "U123",
          text: "Please update the Workpad.",
        },
        client: {
          reactions: {
            async add() {
              reactionAttempts += 1;
              if (reactionAttempts < 3) {
                throw Object.assign(new Error("Slack unavailable"), {
                  code: "slack_webapi_request_error",
                });
              }
            },
          },
        },
        logger: { error: (error: unknown) => assert.fail(String(error)) },
      };
      let replyCount = 0;

      await handleThreadReply(args, store, async () => {
        replyCount += 1;
        return true;
      });

      assert.equal(replyCount, 1);
      assert.equal(reactionAttempts, 3);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 1);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_reply_acknowledged"), 1);
    });
  });

  it("honors Slack retry-after guidance while adding the copied-reply reaction", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      let reactionAttempts = 0;

      await handleThreadReply(
        {
          message: {
            channel: "C123",
            thread_ts: "1.000",
            ts: "2.000",
            user: "U123",
            text: "Please update the Workpad.",
          },
          client: {
            reactions: {
              async add() {
                reactionAttempts += 1;
                if (reactionAttempts === 1) {
                  throw Object.assign(new Error("Slack rate limited"), {
                    code: "slack_webapi_rate_limited_error",
                    retryAfter: 0,
                  });
                }
              },
            },
          },
          logger: { error: (error: unknown) => assert.fail(String(error)) },
        },
        store,
        async () => true,
      );

      assert.equal(reactionAttempts, 2);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_reply_acknowledged"), 1);
    });
  });
});

function fakeClient(calls: Array<{ method: string; args: Record<string, unknown> }>) {
  let timestamp = 0;
  return {
    chat: {
      async getPermalink(args: Record<string, unknown>) {
        calls.push({ method: "getPermalink", args });
        const messageTs = String(args.message_ts).replace(".", "");
        return {
          ok: true,
          channel: String(args.channel),
          permalink: `https://example.slack.com/archives/${args.channel}/p${messageTs}`,
        };
      },
      async postMessage(args: Record<string, unknown>) {
        timestamp += 1;
        calls.push({ method: "postMessage", args });
        return { ok: true, channel: String(args.channel), ts: `${timestamp}.000` };
      },
      async update(args: Record<string, unknown>) {
        calls.push({ method: "update", args });
        return { ok: true, channel: String(args.channel), ts: String(args.ts) };
      },
    },
  } as never;
}

function reactionClient(calls: Array<Record<string, unknown>>) {
  return {
    reactions: {
      async add(args: Record<string, unknown>) {
        calls.push(args);
        return { ok: true };
      },
    },
  };
}

async function withStore(run: (store: WatcherStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "watcher-slack-app-"));
  const database = createDatabase(join(directory, "watcher.db"));
  const store = new WatcherStore(database.db);
  store.syncDefinitions(
    [
      {
        name: "service-a",
        url: "https://service.test/state",
        linearTeam: "workspace-a-eng",
      },
    ],
    {
      "workspace-a-eng": {
        apiKey: "lin_test",
        teamId: "team-a",
        statuses: ["Todo", "In Progress", "Rework", "In Review", "Done"],
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Condition was not met.");
}
