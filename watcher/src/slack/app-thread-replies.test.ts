import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleThreadReply, publishWatcherEvent, type SlackThreadReply } from "./app.ts";
import { fakeClient, reactionClient, waitFor, withStore } from "./app.test-support.ts";

describe("Slack thread replies", () => {
  it("copies text, image, and video replies once", async () => {
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
        client: {
          ...reactionClient(reactions),
          users: {
            async info({ user }: { user: string }) {
              if (user === "U456") {
                return { ok: true, user: { profile: { display_name: "No Avatar" } } };
              }
              if (user === "U789") {
                return { ok: true, user: { real_name: "Real Name", profile: {} } };
              }
              return {
                ok: true,
                user: {
                  profile: {
                    display_name: "Hiroppy",
                    image_72: "https://avatars.slack-edge.com/hiroppy.png",
                  },
                },
              };
            },
          },
        },
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
            user: "U456",
            text: "Screenshot attached.",
            subtype: "file_share",
            files: [
              {
                name: "first screenshot.png",
                mimetype: "image/png",
                size: 2,
                url_private: "https://files.slack.com/files-pri/first",
                url_private_download: "https://files.slack.com/files-pri/first/download",
              },
              {
                name: "second screenshot.jpg",
                mimetype: "image/jpeg",
                size: 3,
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
            ts: "5.000",
            text: "",
            subtype: "file_share",
            files: [
              {
                name: "demo.mp4",
                mimetype: "video/mp4",
                size: 5,
                url_private: "https://files.slack.com/files-pri/demo-mp4",
              },
              {
                name: "demo.mov",
                mimetype: "video/quicktime",
                size: 6,
                url_private: "https://files.slack.com/files-pri/demo-mov",
              },
              {
                name: "demo.webm",
                mimetype: "video/webm",
                size: 7,
                url_private: "https://files.slack.com/files-pri/demo-webm",
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
            user: "U789",
            text: "",
            subtype: "file_share",
            files: [
              {
                name: "image only.gif",
                mimetype: "image/gif",
                size: 4,
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
            files: [],
            authorName: "Hiroppy",
          },
        },
        {
          issueIdentifier: "ENG-62",
          reply: {
            text: "Screenshot attached.",
            authorName: "No Avatar",
            files: [
              {
                filename: "first screenshot.png",
                contentType: "image/png",
                downloadUrl: "https://files.slack.com/files-pri/first/download",
                size: 2,
              },
              {
                filename: "second screenshot.jpg",
                contentType: "image/jpeg",
                downloadUrl: "https://files.slack.com/files-pri/second",
                size: 3,
              },
            ],
          },
        },
        {
          issueIdentifier: "ENG-62",
          reply: {
            text: "",
            authorName: "Hiroppy",
            files: [
              {
                filename: "demo.mp4",
                contentType: "video/mp4",
                downloadUrl: "https://files.slack.com/files-pri/demo-mp4",
                size: 5,
              },
              {
                filename: "demo.mov",
                contentType: "video/quicktime",
                downloadUrl: "https://files.slack.com/files-pri/demo-mov",
                size: 6,
              },
              {
                filename: "demo.webm",
                contentType: "video/webm",
                downloadUrl: "https://files.slack.com/files-pri/demo-webm",
                size: 7,
              },
            ],
          },
        },
        {
          issueIdentifier: "ENG-62",
          reply: {
            text: "",
            authorName: "Real Name",
            files: [
              {
                filename: "image only.gif",
                contentType: "image/gif",
                downloadUrl: "https://files.slack.com/files-pri/image-only",
                size: 4,
              },
            ],
          },
        },
      ]);
      assert.deepEqual(reactions, [
        { channel: "C123", name: "white_check_mark", timestamp: "2.000" },
        { channel: "C123", name: "white_check_mark", timestamp: "3.000" },
        { channel: "C123", name: "white_check_mark", timestamp: "5.000" },
        { channel: "C123", name: "white_check_mark", timestamp: "4.000" },
      ]);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 4);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_reply_acknowledged"), 4);
    });
  });

  it("falls back to the Slack user ID when profile lookup fails", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const replies: SlackThreadReply[] = [];
      const errors: unknown[] = [];

      await handleThreadReply(
        {
          message: {
            channel: "C123",
            thread_ts: "1.000",
            ts: "2.000",
            user: "U123",
            text: "Please retry.",
          },
          client: {
            ...reactionClient([]),
            users: {
              async info() {
                throw new Error("Slack unavailable");
              },
            },
          },
          logger: { error: (error: unknown) => errors.push(error) },
        },
        store,
        async (_task, reply) => {
          replies.push(reply);
          return true;
        },
      );

      assert.deepEqual(replies, [
        {
          text: "Please retry.",
          files: [],
          authorName: "U123",
        },
      ]);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /Failed to resolve Slack display name for U123/);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 1);
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
              size: 10,
              url_private: "https://files.slack.com/files-pri/notes",
            },
          ],
        },
        {
          channel: "C123",
          thread_ts: "1.000",
          ts: "2.750",
          user: "U123",
          text: "",
          subtype: "file_share",
          files: [
            {
              name: "script.svg",
              mimetype: "image/svg+xml",
              size: 100,
              url_private: "https://files.slack.com/files-pri/script",
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
});
