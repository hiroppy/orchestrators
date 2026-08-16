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
    assert.equal(calls[0].text, "*Started*");
    assert.match(JSON.stringify(calls[1].blocks), /In Progress.*In Review/);
    assert.doesNotMatch(JSON.stringify(calls[1].blocks), /Usage|turns|tokens/i);
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
    assert.match(JSON.stringify(calls[0].blocks), /\*Event\*\\nChanged by Hiroppy/);
    assert.match(JSON.stringify(calls[0].blocks), /\*Updated at\*\\n`\d{2}:\d{2}`/);
  });

  it("previews the consolidated status timeline card", () => {
    const message = buildSlackPreviewMessage({ category: "thread", type: "timeline" });
    const blocks = JSON.stringify(message.blocks);
    const expectedUpdatedAt = new Date("2026-08-15T02:00:00.000Z").toTimeString().slice(0, 5);

    assert.match(blocks, /\*In Review → Done\*/);
    assert.match(blocks, /\*Event\*\\nUpdated/);
    assert.match(blocks, new RegExp(`\\*Updated at\\*\\\\n\`${expectedUpdatedAt}\``));
    assert.doesNotMatch(blocks, /Assignees/);
    assert.match(blocks, /\*Error\*\\nTemporary orchestrator failure/);
    assert.match(blocks, /\*PR#123\*/);
    assert.match(blocks, /Consolidate Slack status updates/);
    assert.ok(blocks.indexOf("PR#123") < blocks.indexOf("Error"));
    assert.match(blocks, /\*Timeline\*/);
    assert.match(blocks, /\d{2}:\d{2} In Review → Done/);
    assert.match(blocks, /\d{2}:\d{2} Todo → In Progress/);
    assert.match(blocks, /\d{2}:\d{2} In Progress → In Review by Reviewer/);
    assert.ok(blocks.indexOf("In Review → Done") < blocks.indexOf("In Progress → In Review"));
    assert.ok(blocks.indexOf("In Progress → In Review") < blocks.indexOf("Todo → In Progress"));
  });

  it("previews current Symphony activity and a bounded Git diff", () => {
    const message = buildSlackPreviewMessage(
      { category: "thread", type: "activity" },
      new Date("2026-08-16T01:00:12.000Z"),
    );
    const blocks = JSON.stringify(message.blocks);

    assert.match(blocks, /\*Current activity\*\\nitem started: command execution/);
    assert.match(blocks, /status-timeline\.ts.*runner\.ts.*task-activity\.ts.*\+2 more/);
    assert.match(blocks, /\+42/);
    assert.match(blocks, /−8/);
  });

  it("previews every standalone notification with blocks", () => {
    const cases = [
      { category: "thread", type: "review-comment" },
      { category: "post", type: "closed" },
      { category: "thread", type: "next" },
      { category: "assignees", type: "status" },
    ] as const;
    const messages = cases.map((previewCase) => buildSlackPreviewMessage(previewCase));

    for (const message of messages.slice(0, 3)) {
      assert.ok(message.blocks.length >= 2);
    }
    assert.match(JSON.stringify(messages[0].blocks), /Inline review comment detected/);
    assert.match(JSON.stringify(messages[1].blocks), /\*Task closed\*/);
    assert.match(JSON.stringify(messages[2].blocks), /\*Next task\*/);
    assert.deepEqual(
      messages[2].blocks.map(({ type }) => type),
      ["section", "section", "section", "section"],
    );
    assert.equal(
      messages[3].blocks.some(({ fields }) => fields !== undefined),
      false,
    );
    assert.match(JSON.stringify(messages[3].blocks), /PREVIEW-124.*PREVIEW-125/);
    assert.equal(
      messages[3].text,
      [
        "*Running services (Started at 08/12 11:00)*",
        "• service-a",
        "• service-b",
        "",
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
      messages[3].blocks?.map(({ type }) => type),
      ["section", "section", "section", "section"],
    );
  });

  it("previews the configured attention target in parent and thread messages", () => {
    const options = {
      assignee: "<@UCREATOR>",
      assignees: ["<!subteam^SREVIEWERS>"],
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

    assert.match(JSON.stringify(parent.blocks), /\*Assignees\*\\n@UCREATOR/);
    assert.match(JSON.stringify(parent.blocks), /@SREVIEWERS/);
    assert.doesNotMatch(JSON.stringify(parent.blocks), /Mentions/);
    assert.match(JSON.stringify(parent.blocks), /PR#123/);
    assert.match(JSON.stringify(parent.blocks), /Improve the watcher Slack preview/);
    assert.equal(thread.text, "*Started* | Assignees: <@UCREATOR> <!subteam^SREVIEWERS>");
    assert.doesNotMatch(JSON.stringify(parent.blocks), /Waiting for required credentials/);
    assert.doesNotMatch(thread.text, /Waiting for required credentials/);

    const blocked = buildSlackPreviewMessage(
      { category: "post", type: "block" },
      new Date("2026-07-29T00:00:00.000Z"),
      options,
    );
    assert.match(JSON.stringify(blocked.blocks), /\*Assignees\*\\n@UCREATOR/);
    assert.match(JSON.stringify(blocked.blocks), /@SREVIEWERS/);
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
    assert.deepEqual(resolveSlackPreviewCase("assignees", "status"), {
      category: "assignees",
      type: "status",
    });
    assert.deepEqual(SLACK_PREVIEW_CATEGORIES, ["post", "thread", "assignees"]);
    assert.deepEqual(SLACK_PREVIEW_TYPES, [
      "start",
      "update",
      "retry",
      "block",
      "end",
      "recover",
      "manual",
      "timeline",
      "activity",
      "attention",
      "review-comment",
      "closed",
      "next",
      "status",
    ]);
    assert.throws(
      () => resolveSlackPreviewCase(),
      /Missing Slack preview category.*Usage: pnpm slack:preview <post\|thread\|assignees> <type>/s,
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
      /Unknown Slack preview type: unknown.*Usage: pnpm slack:preview <post\|thread\|assignees> <type>/s,
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
