import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TASK_STATUS_ACTION_ID, taskIdFromBlockId } from "./interactions.ts";
import {
  buildStatusChangedMessage,
  buildStatusChangedMessageBlocks,
  buildStatusSummary,
  buildStatusSummaryBlocks,
  buildTaskCard,
  buildThreadMessage,
  buildThreadMessageBlocks,
  STATUS_SUMMARY_STATUSES,
} from "./views.ts";

describe("Slack rendering", () => {
  const task = {
    id: "service-a:ENG-62",
    serviceName: "service-a",
    issueIdentifier: "ENG-62",
    title: "Build the Slack control plane",
    status: "In Progress",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };

  it("renders one accessible task card with metadata and a service-specific status select", () => {
    const card = buildTaskCard(task, ["Todo", "In Progress", "QA", "Done"], {
      type: "started",
      service: "service-a",
      issueIdentifier: "ENG-62",
      issueUrl: "https://linear.app/acme/issue/ENG-62/example",
      state: "In Progress",
      activity: "Running tests",
      turnCount: 1,
      tokens: { total: 74_400 },
      pullRequest: {
        url: "https://github.com/acme/example/pull/42",
        number: 42,
        title: "Improve the Slack card",
      },
    });
    const actions = card.blocks.find((block) => block.type === "actions") as {
      block_id: string;
      elements: Array<{
        type: string;
        action_id: string;
        options?: Array<{ value: string }>;
        initial_option?: { value: string };
      }>;
    };

    assert.equal(card.text, "[service-a] Build the Slack control plane");
    assert.equal(
      (card.blocks[0].text as { text: string }).text,
      "*<https://linear.app/acme/issue/ENG-62/example|[service-a] Build the Slack control plane>*",
    );
    assert.deepEqual(
      card.blocks.map(({ type }) => type),
      ["section", "actions", "section", "section"],
    );
    const overview = card.blocks.filter(
      (block) => block.type === "section" && "fields" in block,
    ) as Array<{ fields: Array<{ text: string }> }>;
    assert.deepEqual(overview, []);
    assert.deepEqual(card.blocks[2], {
      type: "section",
      text: { type: "mrkdwn", text: "*Event*\nStarted" },
    });
    assert.deepEqual(card.blocks[3], {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*PR#42*\n<https://github.com/acme/example/pull/42|Improve the Slack card>",
      },
    });
    assert.doesNotMatch(JSON.stringify(card.blocks), /Turns:|Tokens:/);
    assert.equal(actions.elements.length, 1);
    assert.equal(card.metadata.event_payload.task_id, task.id);
    assert.equal(
      new Set(card.blocks.map((block) => block.block_id).filter(Boolean)).size,
      card.blocks.filter((block) => block.block_id).length,
    );
    assert.equal(actions.elements[0].action_id, TASK_STATUS_ACTION_ID);
    assert.deepEqual(
      actions.elements[0].options?.map(({ value }) => value),
      ["Todo", "In Progress", "QA", "Done"],
    );
    assert.equal(actions.elements[0].initial_option?.value, "In Progress");
    assert.equal(taskIdFromBlockId(actions.block_id), task.id);

    const updatedCard = buildTaskCard({ ...task, status: "In Review" }, [
      "Todo",
      "In Progress",
      "In Review",
      "Done",
    ]);
    const updatedActions = updatedCard.blocks.find((block) => block.type === "actions") as {
      block_id: string;
    };
    assert.notEqual(updatedActions.block_id, actions.block_id);
    assert.equal(taskIdFromBlockId(updatedActions.block_id), task.id);
  });

  it("does not pretend an externally observed status is a configured select option", () => {
    const card = buildTaskCard({ ...task, status: "Awaiting Customer" }, [
      "Todo",
      "In Progress",
      "Done",
    ]);
    const select = (
      card.blocks.find((block) => block.type === "actions") as {
        elements: Array<Record<string, unknown>>;
      }
    ).elements[0];

    assert.equal(select.initial_option, undefined);
    assert.doesNotMatch(card.text, /Awaiting Customer/);
  });

  it("does not render activity", () => {
    const card = buildTaskCard(task, ["In Progress"], {
      type: "updated",
      service: "service-a",
      issueIdentifier: "ENG-62",
      activity: `<unsafe> & ${"x".repeat(200)}`,
    });
    assert.doesNotMatch(JSON.stringify(card.blocks), /Activity|unsafe/);
  });

  it("keeps an error visible while omitting activity", () => {
    const event = {
      type: "blocked" as const,
      service: "service-a",
      issueIdentifier: "ENG-62",
      activity: `Running tests ${"x".repeat(200)}`,
      error: "Test command failed",
    };
    const card = buildTaskCard(task, ["In Progress"], event);
    const blocks = buildThreadMessageBlocks(event);

    assert.doesNotMatch(JSON.stringify(card.blocks), /Running tests/);
    assert.doesNotMatch(JSON.stringify(blocks), /Running tests/);
    assert.match(JSON.stringify(card.blocks), /\*Error\*\\nTest command failed/);
    assert.match(JSON.stringify(blocks), /\*Error\*\\nTest command failed/);
  });

  it("does not render a status select for watcher fetch errors", () => {
    const card = buildTaskCard(
      {
        ...task,
        id: "service-a:watcher:service-a",
        issueIdentifier: "watcher:service-a",
        title: "watcher:service-a",
        status: "unavailable",
      },
      ["Todo", "In Progress", "Done"],
      {
        type: "retrying",
        service: "service-a",
        issueIdentifier: "watcher:service-a",
        state: "unavailable",
        error: "fetch failed",
      },
    );

    assert.equal(
      card.blocks.some((block) => block.type === "actions"),
      false,
    );
    assert.equal(card.text, "[service-a] Symphony connection");
    assert.equal(
      (card.blocks[0].text as { text: string }).text,
      "*[service-a] Symphony connection*",
    );
    const overview = card.blocks.find((block) => block.type === "section" && "fields" in block) as {
      fields: Array<{ text: string }>;
    };
    assert.deepEqual(
      overview.fields.map(({ text }) => text),
      ["*Status*\nUnavailable", "*Event*\nRetrying"],
    );
    assert.match(JSON.stringify(card.blocks), /\*Error\*\\nfetch failed/);
    assert.equal(
      card.blocks.some((block) => block.type === "context"),
      false,
    );
  });

  it("makes a recovered Symphony connection understandable without opening its thread", () => {
    const card = buildTaskCard(
      {
        ...task,
        id: "service-a:watcher:service-a",
        issueIdentifier: "watcher:service-a",
        title: "watcher:service-a",
        status: "available",
      },
      ["Todo", "In Progress", "Done"],
      {
        type: "recovered",
        service: "service-a",
        issueIdentifier: "watcher:service-a",
        state: "available",
      },
    );
    const overview = card.blocks.find((block) => block.type === "section" && "fields" in block) as {
      fields: Array<{ text: string }>;
    };

    assert.equal(card.text, "[service-a] Symphony connection");
    assert.deepEqual(
      overview.fields.map(({ text }) => text),
      ["*Status*\nAvailable", "*Event*\nRecovered"],
    );
  });

  it("keeps thread output bounded and records Slack status actors", () => {
    const body = buildThreadMessage({
      type: "blocked",
      service: "service-a",
      issueIdentifier: "ENG-62",
      error: "x".repeat(4_000),
    });

    assert.ok(body.length <= 2_500);
    assert.equal(
      buildStatusChangedMessage("Example User", "In Review", "Rework"),
      "*In Review* → *Rework* by Example User",
    );

    const pullRequestBody = buildThreadMessage({
      type: "updated",
      service: "service-a",
      issueIdentifier: "ENG-62",
      pullRequest: { url: "https://github.com/acme/example/pull/42" },
      error: "x".repeat(4_000),
    });
    assert.match(pullRequestBody, /github\.com\/acme\/example\/pull\/42/);
  });

  it("renders watcher status changes like the parent event summary", () => {
    const body = buildThreadMessage(
      {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        startedAt: "2026-07-29T05:00:00.000Z",
        pullRequest: {
          url: "https://github.com/acme/example/pull/4",
          number: 4,
        },
        turnCount: 1,
        attempt: 1,
        dueAt: "2026-07-29T05:14:49Z",
      },
      {
        fromStatus: "In Progress",
        toStatus: "In Review",
        assignees: ["<@UHIROPPY>"],
      },
    );

    assert.match(
      body,
      /^\*In Progress\* → \*In Review\*\nEvent: Started \| Assignees: <@UHIROPPY>\n<https:\/\/github\.com\/acme\/example\/pull\/4\|PR#4>$/,
    );
    assert.doesNotMatch(body, /Attempt:|Due:/);

    assert.deepEqual(
      buildThreadMessageBlocks(
        {
          type: "started",
          service: "service-a",
          issueIdentifier: "ENG-62",
          pullRequest: {
            url: "https://github.com/acme/example/pull/4",
            number: 4,
          },
          turnCount: 1,
        },
        {
          fromStatus: "In Progress",
          assignees: ["<@UHIROPPY>"],
          toStatus: "In Review",
        },
      )?.map(({ type }) => type),
      ["section", "section", "section"],
    );
  });

  it("renders a precomputed attention mention in cards and threads", () => {
    const creator = "<@UCREATOR>";
    const mentions = ["<!subteam^SXXXXXXXX>"];
    const card = buildTaskCard(
      { ...task, status: "In Review" },
      ["In Progress", "In Review", "Done"],
      {
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        turnCount: 1,
        tokens: { total: 1_400_000 },
      },
      [creator, ...mentions],
    );
    const thread = buildThreadMessage(
      {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
      },
      { assignees: [creator, ...mentions] },
    );

    assert.equal(
      card.text,
      "[service-a] Build the Slack control plane. Assigned to @UCREATOR @SXXXXXXXX",
    );
    assert.deepEqual(card.blocks.slice(2), [
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "*Event*\nEnded" },
          { type: "mrkdwn", text: "*Assignees*\n@UCREATOR @SXXXXXXXX" },
        ],
      },
    ]);
    assert.doesNotMatch(JSON.stringify(card.blocks), /Mentions/);
    assert.doesNotMatch(JSON.stringify(card.blocks), /Turns:|Tokens:/);
    assert.match(thread, /\*Updated\* \| Assignees: <@UCREATOR> <!subteam\^SXXXXXXXX>/);

    assert.match(
      buildStatusChangedMessage("Example User", "Rework", "In Review"),
      /\*Rework\* → \*In Review\* by Example User/,
    );
    assert.deepEqual(buildStatusChangedMessageBlocks("Example User", "Rework", "In Review"), [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Rework* → *In Review*" },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Changed by*\nExample User" },
      },
    ]);
    assert.doesNotMatch(
      buildStatusChangedMessage("Example User", "In Review", "Done"),
      /SXXXXXXXX/,
    );
  });

  it("keeps the assignees field within Slack's text limit", () => {
    const mentions = Array.from(
      { length: 300 },
      (_, index) => `<@U${String(index).padStart(8, "0")}>`,
    );
    const blocks = buildThreadMessageBlocks(
      {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
      },
      { assignees: mentions },
    );
    const assigneesField = blocks
      .flatMap((block) => {
        if ("fields" in block) return block.fields as Array<{ text: string }>;
        return "text" in block ? [block.text as { text: string }] : [];
      })
      .find(({ text }) => text.startsWith("*Assignees*\n"));

    assert.ok(assigneesField);
    assert.ok(assigneesField.text.length <= 2_000);
    assert.match(assigneesField.text, />$/);

    const card = buildTaskCard(task, ["In Progress"], undefined, mentions);
    const cardAssigneesField = card.blocks
      .flatMap((block) => {
        if ("fields" in block) return block.fields as Array<{ text: string }>;
        return "text" in block ? [block.text as { text: string }] : [];
      })
      .find(({ text }) => text.startsWith("*Assignees*\n"));
    assert.ok(cardAssigneesField);
    assert.ok(cardAssigneesField.text.length <= 2_000);
    assert.doesNotMatch(JSON.stringify(card), /<@U/);
  });

  it("shows an empty running service list with the watcher start time", () => {
    const summary = buildStatusSummary([], new Map(), {
      serviceNames: [],
      startedAt: new Date("2026-08-12T02:00:00.000Z"),
    });

    assert.match(summary, /^\*Running services \(0\)\*\n• None/);
    assert.match(summary, /\*Started at\*\n<!date\^1786500000\^/);
    assert.match(summary, /\*Todo \(0\)\*\n• None/);
  });

  it("keeps large service lists and names within Slack's section limit", () => {
    const blocks = buildStatusSummaryBlocks([], new Map(), {
      serviceNames: [
        ...Array.from({ length: 100 }, (_, index) => `service-${index}-${"x".repeat(40)}`),
        "<&>".repeat(2_000),
      ],
      startedAt: new Date("2026-08-12T02:00:00.000Z"),
    });
    const serviceBlocks = blocks.slice(0, -STATUS_SUMMARY_STATUSES.length);
    const serviceText = serviceBlocks.map((block) => block.text?.text ?? "").join("\n");

    assert.ok(serviceBlocks.length > 1);
    assert.equal(
      serviceBlocks.every((block) => (block.text?.text.length ?? 0) <= 3_000),
      true,
    );
    assert.match(serviceText, /^\*Running services \(101\)\*/);
    assert.match(serviceText, /…/);
    assert.match(serviceText, /\*Started at\*\n<!date\^1786500000\^/);
  });
});
