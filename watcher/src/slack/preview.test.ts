import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSlackPreviewMessage,
  postSlackPreview,
  resolveSlackPreviewCase,
  resolveSlackPreviewConfig,
  SLACK_PREVIEW_CATEGORIES,
  SLACK_PREVIEW_TYPES,
  type SlackPreviewClient,
} from "./preview.ts";

describe("Slack preview", () => {
  it("builds a representative watcher card for every event case", () => {
    const messages = SLACK_PREVIEW_TYPES.map((type) =>
      buildSlackPreviewMessage({ category: "post", type }, new Date("2026-07-29T00:00:00.000Z")),
    );
    const expectedEventLabels = ["Started", "Updated", "Retrying", "Blocked", "Ended", "Recovered"];

    for (const [index, message] of messages.entries()) {
      assert.ok("metadata" in message);
      assert.match(
        JSON.stringify(message.blocks),
        new RegExp(`Event: ${expectedEventLabels[index]}`),
      );
      assert.equal(
        message.blocks.some((block) => block.type === "actions"),
        false,
      );
    }
    assert.equal(messages[0].text, "[preview-service] Confirm the watcher Slack output");
    assert.equal(messages[0].metadata.event_payload.task_id, "preview-service:PREVIEW-123");
    assert.match(JSON.stringify(messages[0].blocks), /PR#123/);
    assert.match(JSON.stringify(messages[1].blocks), /Event: Updated/);
    assert.match(JSON.stringify(messages[1].blocks), /Turns: 12/);
    assert.match(JSON.stringify(messages[1].blocks), /Tokens: 12\.3k/);
    assert.match(JSON.stringify(messages[2].blocks), /Attempt: 2/);
    assert.match(JSON.stringify(messages[2].blocks), /Temporary orchestrator failure/);
    assert.match(JSON.stringify(messages[3].blocks), /Waiting for required credentials/);
    assert.match(JSON.stringify(messages[4].blocks), /Tokens: 98\.8k/);
    assert.equal(messages[5].text, "[preview-service] Symphony connection");
    assert.match(JSON.stringify(messages[5].blocks), /Status: Available/);
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

    for (const type of SLACK_PREVIEW_TYPES) {
      await postSlackPreview(
        client,
        "C123",
        { category: "thread", type },
        new Date("2026-07-29T00:00:00.000Z"),
      );
    }

    assert.equal(calls.length, SLACK_PREVIEW_TYPES.length);
    for (const call of calls) {
      assert.equal(call.channel, "C123");
      assert.equal("thread_ts" in call, false);
      assert.ok(Array.isArray(call.blocks));
    }
    assert.match(
      String(calls[1].text),
      /^\*In Progress\* → \*In Review\*\nEvent: Updated \| UpdatedAt: <!date\^\d+\^\{date_short_pretty\} \{time\}\|[^>]+>\nTurns: 12 \| Tokens: 12\.3k$/,
    );
    assert.match(JSON.stringify(calls[1].blocks), /In Progress.*In Review/);
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
    assert.equal(calls[0].text, "[preview-service] Confirm the watcher Slack output");
    assert.match(JSON.stringify(calls[0].blocks), /Waiting for required credentials/);
  });
});
