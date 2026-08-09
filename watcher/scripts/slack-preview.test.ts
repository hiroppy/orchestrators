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

  it("uses stored task presentation without exposing its persisted identity or state", () => {
    const storedTask = {
      id: "service-a:ENG-62",
      serviceName: "service-a",
      issueIdentifier: "ENG-62",
      title: "Build the Slack control plane",
      status: "In Progress",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const options = {
      task: storedTask,
      configuredStatuses: ["In Progress", "Done"],
      interactive: true,
    };
    const started = buildSlackPreviewMessage(
      { category: "post", type: "start" },
      new Date("2026-07-29T00:00:00.000Z"),
      options,
    );
    const recovered = buildSlackPreviewMessage(
      { category: "post", type: "recover" },
      new Date("2026-07-29T00:00:00.000Z"),
      options,
    );

    assert.equal(started.metadata.event_payload.task_id, "preview:service-a:ENG-62");
    assert.notEqual(started.metadata.event_payload.task_id, storedTask.id);
    assert.match(JSON.stringify(started.blocks), /Build the Slack control plane/);
    assert.equal(recovered.metadata.event_payload.task_id, "preview:service-a:watcher:service-a");
    assert.match(JSON.stringify(recovered.blocks), /Symphony connection/);
    assert.match(JSON.stringify(recovered.blocks), /\*Status\*\\nAvailable/);
    assert.equal(
      recovered.blocks.some((block) => block.type === "actions"),
      false,
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
    for (const call of calls) {
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
    assert.match(JSON.stringify(calls[1].blocks), /\*Usage\*\\n12 turns \| 12\.3k tokens/);
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
    assert.match(JSON.stringify(calls[0].blocks), /\*Changed by\*\\nHiroppy/);
  });

  it("previews every standalone notification with blocks", () => {
    const cases = [
      { category: "thread", type: "reaction" },
      { category: "thread", type: "reaction-limit" },
      { category: "post", type: "closed" },
      { category: "thread", type: "next" },
      { category: "post", type: "watcher-started" },
      { category: "mentions", type: "status" },
    ] as const;
    const messages = cases.map((previewCase) => buildSlackPreviewMessage(previewCase));

    for (const message of messages.slice(0, 3)) {
      assert.ok(message.blocks.length >= 2);
      assert.deepEqual(
        message.blocks.map(({ type }) => type),
        ["section", "section"],
      );
    }
    assert.match(JSON.stringify(messages[0].blocks), /Review reaction detected/);
    assert.match(JSON.stringify(messages[1].blocks), /Review requeue limit reached/);
    assert.match(JSON.stringify(messages[1].blocks), /\*Requeues\*\\n3\/3/);
    assert.match(JSON.stringify(messages[2].blocks), /\*Task closed\*/);
    assert.match(JSON.stringify(messages[3].blocks), /\*Next task\*/);
    assert.deepEqual(
      messages[3].blocks.map(({ type }) => type),
      ["section", "section", "section", "section"],
    );
    assert.equal(
      messages[3].blocks.some(({ fields }) => fields !== undefined),
      false,
    );
    assert.match(JSON.stringify(messages[3].blocks), /PREVIEW-124.*PREVIEW-125.*PREVIEW-126/);
    assert.deepEqual(
      messages[4].blocks.map(({ type }) => type),
      ["section", "section"],
    );
    assert.doesNotMatch(JSON.stringify(messages[4].blocks), /Monitoring/);
    assert.match(JSON.stringify(messages[4].blocks), /Services.*mf-dashboard/s);
    assert.equal(
      messages[5].text,
      [
        "*Todo (2)*",
        "• [preview-service] PREVIEW-120: Plan the Slack status command",
        "  <https://example.slack.com/archives/C123/p120|Slack> | <https://linear.app/example/issue/PREVIEW-120/plan-the-slack-status-command|Linear>",
        "• [preview-service] PREVIEW-123: Define the status response accessibility requirements",
        "  <https://example.slack.com/archives/C123/p123|Slack> | <https://linear.app/example/issue/PREVIEW-123/define-the-status-response-accessibility-requirements|Linear>",
        "",
        "*In Progress (2)*",
        "• [preview-service] PREVIEW-121: Implement the Slack status command",
        "  <https://example.slack.com/archives/C123/p121|Slack> | <https://linear.app/example/issue/PREVIEW-121/implement-the-slack-status-command|Linear> | <https://github.com/example/preview/pull/121|PR#121>",
        "• [preview-service] PREVIEW-124: Add destination links to every active task",
        "  <https://example.slack.com/archives/C123/p124|Slack> | <https://linear.app/example/issue/PREVIEW-124/add-destination-links-to-every-active-task|Linear>",
        "",
        "*In Review (2)*",
        "• [preview-service] PREVIEW-122: Review the Slack status command",
        "  <https://example.slack.com/archives/C123/p122|Slack> | <https://linear.app/example/issue/PREVIEW-122/review-the-slack-status-command|Linear> | <https://github.com/example/preview/pull/122|PR#122>",
        "• [preview-service] PREVIEW-125: Verify the compact layout with several pull requests",
        "  <https://example.slack.com/archives/C123/p125|Slack> | <https://linear.app/example/issue/PREVIEW-125/verify-the-compact-layout-with-several-pull-requests|Linear> | <https://github.com/example/preview/pull/125|PR#125>",
      ].join("\n"),
    );
    assert.deepEqual(
      messages[5].blocks?.map(({ type }) => type),
      ["section", "section", "section"],
    );
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
    assert.deepEqual(resolveSlackPreviewCase("mentions", "status"), {
      category: "mentions",
      type: "status",
    });
    assert.deepEqual(SLACK_PREVIEW_CATEGORIES, ["post", "thread", "mentions"]);
    assert.deepEqual(SLACK_PREVIEW_TYPES, [
      "start",
      "update",
      "retry",
      "block",
      "end",
      "recover",
      "manual",
      "attention",
      "reaction",
      "reaction-limit",
      "closed",
      "next",
      "watcher-started",
      "status",
    ]);
    assert.throws(
      () => resolveSlackPreviewCase(),
      /Missing Slack preview category.*Usage: pnpm slack:preview <post\|thread\|mentions> <type>/s,
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
      /Unknown Slack preview type: unknown.*Usage: pnpm slack:preview <post\|thread\|mentions> <type>/s,
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
    assert.throws(
      () => resolveSlackPreviewCase("thread", "closed"),
      /closed is only available for post previews/,
    );
    assert.throws(
      () => resolveSlackPreviewCase("thread", "watcher-started"),
      /watcher-started is only available for post previews/,
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

    assert.deepEqual(
      resolveSlackPreviewConfig(
        {},
        {
          botToken: " xoxb-config ",
          channelId: " C456 ",
        },
      ),
      {
        botToken: "xoxb-config",
        channelId: "C456",
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
