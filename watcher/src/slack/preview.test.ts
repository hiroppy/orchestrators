import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSlackPreviewMessage,
  postSlackPreview,
  resolveSlackPreviewConfig,
  type SlackPreviewClient,
} from "./preview.ts";

describe("Slack preview", () => {
  it("builds a representative watcher card", () => {
    const message = buildSlackPreviewMessage(new Date("2026-07-29T00:00:00.000Z"));

    assert.equal(message.text, "[preview-service] Confirm the watcher Slack output");
    assert.equal(message.metadata.event_payload.task_id, "preview-service:PREVIEW-123");
    assert.match(JSON.stringify(message.blocks), /In Review/);
    assert.match(JSON.stringify(message.blocks), /Turns: 12/);
    assert.match(JSON.stringify(message.blocks), /Tokens: 12\.3k/);
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

    const response = await postSlackPreview(client, "C123", new Date("2026-07-29T00:00:00.000Z"));

    assert.equal(response.ts, "1.000");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "C123");
    assert.equal(calls[0].text, "[preview-service] Confirm the watcher Slack output");
  });
});
