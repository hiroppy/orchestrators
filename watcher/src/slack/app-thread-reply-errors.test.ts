import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LinearRateLimitError } from "../integrations/linear-client.ts";
import { handleThreadReply, publishWatcherEvent } from "./app.ts";
import { fakeClient, reactionClient, withStore } from "./app.test-support.ts";

describe("Slack thread reply errors", () => {
  it("filters commands for this bot without dropping replies that mention another user", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const replies: string[] = [];
      const reactions: Array<Record<string, unknown>> = [];
      const args = (ts: string, text: string) => ({
        message: {
          channel: "C123",
          thread_ts: "1.000",
          ts,
          user: "U123",
          text,
        },
        client: reactionClient(reactions),
        logger: { error: (error: unknown) => assert.fail(String(error)) },
      });

      await handleThreadReply(
        args("2.000", "<@UBOT> assign <@U123>"),
        store,
        async (_task, reply) => {
          replies.push(reply.text);
          return true;
        },
        "UBOT",
      );
      await handleThreadReply(
        args("2.500", "<@UCOLLEAGUE> hello <@UBOT> help"),
        store,
        async (_task, reply) => {
          replies.push(reply.text);
          return true;
        },
        "UBOT",
      );
      await handleThreadReply(
        args("2.750", "<@UBOT>help"),
        store,
        async (_task, reply) => {
          replies.push(reply.text);
          return true;
        },
        "UBOT",
      );
      await handleThreadReply(
        args("2.875", "<@UBOT> take-pr https://github.com/example/repo/pull/1"),
        store,
        async (_task, reply) => {
          replies.push(reply.text);
          return true;
        },
        "UBOT",
      );
      await handleThreadReply(
        args("2.900", "<@UBOT> help me understand this failure"),
        store,
        async (_task, reply) => {
          replies.push(reply.text);
          return true;
        },
        "UBOT",
      );
      await handleThreadReply(
        args("3.000", "<@UCOLLEAGUE> status is still blocked"),
        store,
        async (_task, reply) => {
          replies.push(reply.text);
          return true;
        },
        "UBOT",
      );

      assert.deepEqual(replies, [
        "<@UBOT> help me understand this failure",
        "<@UCOLLEAGUE> status is still blocked",
      ]);
      assert.deepEqual(reactions, [
        { channel: "C123", name: "white_check_mark", timestamp: "2.900" },
        { channel: "C123", name: "white_check_mark", timestamp: "3.000" },
      ]);
    });
  });

  it("reports missing Workpads and Linear failures in the Slack thread", async () => {
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
      const messages: Array<Record<string, unknown>> = [];
      const args = {
        message: {
          channel: "C123",
          thread_ts: "1.000",
          ts: "2.000",
          user: "U123",
          text: "Please update the Workpad.",
        },
        client: {
          ...reactionClient(reactions),
          chat: {
            async postMessage(message: Record<string, unknown>) {
              messages.push(message);
              return { ok: true };
            },
          },
        },
        logger: { error: (error: unknown) => errors.push(error) },
      };

      await handleThreadReply(args, store, async () => false);
      await handleThreadReply(args, store, async () => {
        throw new Error("Linear unavailable: <!channel> secret-token");
      });
      await handleThreadReply(args, store, async () => {
        throw new LinearRateLimitError();
      });

      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 0);
      assert.deepEqual(reactions, []);
      assert.deepEqual(messages, [
        {
          channel: "C123",
          thread_ts: "1.000",
          text: "[error] Failed to copy the reply to Linear. Reason: The destination Workpad could not be found in Linear.",
        },
        {
          channel: "C123",
          thread_ts: "1.000",
          text: "[error] Failed to copy the reply to Linear. Reason: An error occurred while copying the reply to Linear.",
        },
        {
          channel: "C123",
          thread_ts: "1.000",
          text: "[error] Failed to copy the reply to Linear. Reason: The Linear API rate limit was reached. Please try again later.",
        },
      ]);
      assert.equal(errors.length, 2);
      assert.match(String(errors[0]), /Linear unavailable/);
      assert.doesNotMatch(
        messages.map(({ text }) => String(text)).join("\n"),
        /secret-token|channel/,
      );
    });
  });

  it("distinguishes persistence failures after a successful Linear reply", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await publishWatcherEvent(fakeClient(calls), store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const messages: Array<Record<string, unknown>> = [];
      const errors: unknown[] = [];
      const originalAddEvent = store.addEvent.bind(store);
      store.addEvent = (event) => {
        if (event.type === "workpad_replied") throw new Error("Database unavailable");
        return originalAddEvent(event);
      };

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
            ...reactionClient([]),
            chat: {
              async postMessage(message: Record<string, unknown>) {
                messages.push(message);
                return { ok: true };
              },
            },
          },
          logger: { error: (error: unknown) => errors.push(error) },
        },
        store,
        async () => true,
      );

      assert.deepEqual(messages, [
        {
          channel: "C123",
          thread_ts: "1.000",
          text: "[error] The reply was copied to Linear, but the result could not be recorded.",
        },
      ]);
      assert.equal(store.countEvents("service-a:ENG-62", "workpad_replied"), 0);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /Database unavailable/);
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
