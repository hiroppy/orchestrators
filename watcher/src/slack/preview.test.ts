import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSlackPreviewMessage,
  postSlackPreview,
  resolveSlackPreviewCase,
  resolveSlackPreviewConfig,
  SLACK_PREVIEW_CASES,
  type SlackPreviewClient,
} from "./preview.ts";

describe("Slack preview", () => {
  it("builds a representative watcher card for every event case", () => {
    const messages = SLACK_PREVIEW_CASES.map((previewCase) =>
      buildSlackPreviewMessage(previewCase, new Date("2026-07-29T00:00:00.000Z")),
    );
    const expectedEventLabels = ["Started", "Updated", "Retrying", "Blocked", "Ended", "Recovered"];

    for (const [index, message] of messages.entries()) {
      assert.equal(message.text, "[preview-service] Confirm the watcher Slack output");
      assert.equal(message.metadata.event_payload.task_id, "preview-service:PREVIEW-123");
      assert.match(
        JSON.stringify(message.blocks),
        new RegExp(`Event: ${expectedEventLabels[index]}`),
      );
    }
    assert.match(JSON.stringify(messages[0].blocks), /PR#123/);
    assert.match(JSON.stringify(messages[1].blocks), /Event: Updated/);
    assert.match(JSON.stringify(messages[1].blocks), /Turns: 12/);
    assert.match(JSON.stringify(messages[1].blocks), /Tokens: 12\.3k/);
    assert.match(JSON.stringify(messages[2].blocks), /Attempt: 2/);
    assert.match(JSON.stringify(messages[2].blocks), /Temporary orchestrator failure/);
    assert.match(JSON.stringify(messages[3].blocks), /Waiting for required credentials/);
    assert.match(JSON.stringify(messages[4].blocks), /Tokens: 98\.8k/);
  });

  it("requires a supported event case", () => {
    assert.equal(resolveSlackPreviewCase("blocked"), "blocked");
    assert.throws(() => resolveSlackPreviewCase(), /Missing Slack preview case.*Available cases/s);
    assert.throws(
      () => resolveSlackPreviewCase("unknown"),
      /Unknown Slack preview case: unknown.*Usage: pnpm slack:preview <case>/s,
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
      "blocked",
      new Date("2026-07-29T00:00:00.000Z"),
    );

    assert.equal(response.ts, "1.000");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "C123");
    assert.equal(calls[0].text, "[preview-service] Confirm the watcher Slack output");
    assert.match(JSON.stringify(calls[0].blocks), /Waiting for required credentials/);
  });
});
