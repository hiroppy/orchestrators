import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSlackPreviewMessage,
  postSlackPreview,
  resolveSlackPreviewCase,
  resolveSlackPreviewConfig,
  SLACK_PREVIEW_CATEGORIES,
  SLACK_PREVIEW_EVENT_TYPES,
  SLACK_PREVIEW_TYPES,
  type SlackPreviewClient,
} from "./slack-preview.ts";

describe("Slack preview", () => {
  it("builds a representative watcher card for every event case", () => {
    const messages = SLACK_PREVIEW_EVENT_TYPES.map((type) =>
      buildSlackPreviewMessage({ category: "post", type }, new Date("2026-07-29T00:00:00.000Z")),
    );
    const expectedEventLabels = ["Started", "Updated", "Retrying", "Blocked", "Ended", "Recovered"];
    const blocks = messages.map((message) => JSON.stringify(message.blocks));

    for (const [index, message] of messages.entries()) {
      assert.ok("metadata" in message);
      assert.match(blocks[index], new RegExp(`\\*Event\\*\\\\n${expectedEventLabels[index]}`));
      assert.equal(
        message.blocks.some((block) => block.type === "actions"),
        false,
      );
    }
    assert.equal(messages[0].text, "🔥 Preview [preview-service] Confirm the watcher Slack output");
    assert.equal(messages[0].metadata.event_payload.task_id, "preview-service:PREVIEW-123");
    assert.match(blocks[0], /PR#123/);
    assert.match(blocks[1], /\*Event\*\\nUpdated/);
    assert.doesNotMatch(blocks[1], /Turns:|Tokens:/);
    assert.match(blocks[2], /Retrying \(attempt 2\)/);
    assert.doesNotMatch(blocks[2], /Attempt: 2/);
    assert.match(blocks[2], /Temporary orchestrator failure/);
    assert.match(blocks[3], /Waiting for required credentials/);
    for (const blockText of blocks) {
      assert.doesNotMatch(blockText, /<!date\^/);
    }
    for (const blockText of blocks) {
      assert.doesNotMatch(blockText, /UpdatedAt:/);
    }
    assert.doesNotMatch(blocks[4], /Turns:|Tokens:/);
    assert.equal(messages[5].text, "🔥 Preview [preview-service] Symphony connection");
    assert.match(blocks[5], /\*Status\*\\nAvailable/);
    assert.equal(
      messages[5].metadata.event_payload.task_id,
      "preview-service:watcher:preview-service",
    );
  });

  it("builds every thread event as a parent post", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: SlackPreviewClient = {
      chat: {
        async postMessage(args) {
          calls.push(args);
          return { ok: true, channel: args.channel, ts: "1.000" };
        },
      },
    };

    for (const type of SLACK_PREVIEW_EVENT_TYPES) {
      await postSlackPreview(
        client,
        "C123",
        { category: "thread", type },
        new Date("2026-07-29T00:00:00.000Z"),
      );
    }

    assert.equal(calls.length, SLACK_PREVIEW_EVENT_TYPES.length);
    for (const call of calls) {
      assert.equal(call.channel, "C123");
      assert.equal("thread_ts" in call, false);
    }
    assert.equal("blocks" in calls[0], false);
    for (const call of calls.slice(1)) {
      assert.ok(Array.isArray(call.blocks));
    }
    assert.equal(
      calls[0].text,
      "*PR created* | <https://github.com/example/preview/pull/123|PR#123>",
    );
    assert.match(
      String(calls[1].text),
      /^\*In Progress\* → \*In Review\*\nEvent: Updated\nTurns: 12 \| Tokens: 12\.3k$/,
    );
    assert.match(JSON.stringify(calls[1].blocks), /In Progress.*In Review/);
    assert.match(String(calls[5].text), /^\*unavailable\* → \*available\*\nEvent: Recovered$/);
  });

  it("previews a manual status change with the actor display name", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: SlackPreviewClient = {
      chat: {
        async postMessage(args) {
          calls.push(args);
          return { ok: true, channel: args.channel, ts: "1.000" };
        },
      },
    };

    await postSlackPreview(client, "C123", { category: "thread", type: "manual" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "*In Review* → *Rework* by Hiroppy");
    assert.equal("blocks" in calls[0], false);
  });

  it("previews the configured attention target in parent and thread messages", () => {
    const options = {
      mentionTarget: "<@UCREATOR>",
      mentions: ["<!subteam^SREVIEWERS>"],
    };
    const parent = buildSlackPreviewMessage(
      { category: "post", type: "attention" },
      new Date("2026-07-29T00:00:00.000Z"),
      options,
    );
    const thread = buildSlackPreviewMessage(
      { category: "thread", type: "attention" },
      new Date("2026-07-29T00:00:00.000Z"),
      options,
    );

    assert.match(JSON.stringify(parent.blocks), /\*Creator\*\\n<@UCREATOR>/);
    assert.doesNotMatch(JSON.stringify(parent.blocks), /Mentions/);
    assert.match(JSON.stringify(parent.blocks), /PR#123/);
    assert.match(JSON.stringify(parent.blocks), /Improve the watcher Slack preview/);
    assert.equal(
      thread.text,
      "*PR created* | Creator: <@UCREATOR> | Mentions: <!subteam^SREVIEWERS> | <https://github.com/example/preview/pull/123|PR#123>",
    );
    assert.doesNotMatch(JSON.stringify(parent.blocks), /Waiting for required credentials/);
    assert.doesNotMatch(thread.text, /Waiting for required credentials/);

    const blocked = buildSlackPreviewMessage(
      { category: "post", type: "block" },
      new Date("2026-07-29T00:00:00.000Z"),
      options,
    );
    assert.match(JSON.stringify(blocked.blocks), /\*Creator\*\\n<@UCREATOR>/);
    assert.doesNotMatch(JSON.stringify(blocked.blocks), /Mentions/);

    const defaults = buildSlackPreviewMessage(
      { category: "post", type: "attention" },
      new Date("2026-07-29T00:00:00.000Z"),
    );
    assert.doesNotMatch(JSON.stringify(defaults.blocks), /Mentions/);
  });

  it("requires a supported category and event type", () => {
    assert.deepEqual(resolveSlackPreviewCase("post", "start"), {
      category: "post",
      type: "start",
    });
    assert.deepEqual(resolveSlackPreviewCase("thread", "update"), {
      category: "thread",
      type: "update",
    });
    assert.deepEqual(SLACK_PREVIEW_CATEGORIES, ["post", "thread"]);
    assert.deepEqual(SLACK_PREVIEW_TYPES, [
      "start",
      "update",
      "retry",
      "block",
      "end",
      "recover",
      "manual",
      "attention",
    ]);
    assert.throws(
      () => resolveSlackPreviewCase(),
      /Missing Slack preview category.*Usage: pnpm slack:preview <post\|thread> <type>/s,
    );
    assert.throws(
      () => resolveSlackPreviewCase("unknown", "start"),
      /Unknown Slack preview category: unknown.*Available categories: post, thread/s,
    );
    assert.throws(
      () => resolveSlackPreviewCase("post"),
      /Missing Slack preview type.*Available types: start, update, retry, block, end, recover/s,
    );
    assert.throws(
      () => resolveSlackPreviewCase("post", "unknown"),
      /Unknown Slack preview type: unknown.*Usage: pnpm slack:preview <post\|thread> <type>/s,
    );
    assert.throws(
      () => resolveSlackPreviewCase("post", "start", "extra"),
      /Unexpected Slack preview argument: extra/,
    );
    assert.throws(
      () => resolveSlackPreviewCase("post", "start", ""),
      /Unexpected Slack preview argument:/,
    );
    assert.throws(
      () => resolveSlackPreviewCase("post", "manual"),
      /manual is only available for thread previews/,
    );
  });

  it("requires only the bot token and destination channel", () => {
    assert.deepEqual(
      resolveSlackPreviewConfig({
        SLACK_BOT_TOKEN: " xoxb-test ",
        SLACK_CHANNEL_ID: " C123 ",
      }),
      {
        botToken: "xoxb-test",
        channelId: "C123",
      },
    );

    assert.throws(
      () =>
        resolveSlackPreviewConfig({
          SLACK_BOT_TOKEN: " ",
        }),
      /SLACK_BOT_TOKEN, SLACK_CHANNEL_ID/,
    );
  });

  it("posts the representative card to the configured channel", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: SlackPreviewClient = {
      chat: {
        async postMessage(args) {
          calls.push(args);
          return { ok: true, channel: args.channel, ts: "1.000" };
        },
      },
    };

    const response = await postSlackPreview(
      client,
      "C123",
      { category: "post", type: "block" },
      new Date("2026-07-29T00:00:00.000Z"),
    );

    assert.equal(response.ts, "1.000");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "C123");
    assert.equal(calls[0].text, "🔥 Preview [preview-service] Confirm the watcher Slack output");
    assert.match(JSON.stringify(calls[0].blocks), /Waiting for required credentials/);
  });
});
