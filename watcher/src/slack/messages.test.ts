import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStatusChangedMessage,
  buildTaskCard,
  buildThreadMessage,
  TASK_STATUS_ACTION_ID,
  taskIdFromBlockId,
} from "./messages.ts";

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
      turnCount: 1,
      tokens: { total: 74_400 },
      pullRequest: {
        url: "https://github.com/acme/example/pull/42",
        number: 42,
      },
    });
    const actions = card.blocks.find((block) => block.type === "actions") as {
      block_id: string;
      elements: Array<{
        action_id: string;
        options: Array<{ value: string }>;
        initial_option: { value: string };
      }>;
    };

    assert.equal(card.text, "[service-a] Build the Slack control plane");
    assert.equal(
      (card.blocks[0].text as { text: string }).text,
      "*<https://linear.app/acme/issue/ENG-62/example|[service-a] Build the Slack control plane>*",
    );
    assert.doesNotMatch(JSON.stringify(card.blocks), /🚧|In Progress.*service-a/);
    assert.deepEqual(
      card.blocks.map(({ type }) => type),
      ["section", "actions", "context"],
    );
    const context = card.blocks.find((block) => block.type === "context") as {
      elements: Array<{ text: string }>;
    };
    assert.match(
      context.elements[0].text,
      /^Event: Started \| UpdatedAt: <!date\^\d+\^\{date_short_pretty\} \{time\}\|[^>]+>\n<https:\/\/github\.com\/acme\/example\/pull\/42\|PR#42> \| Turns: 1 \| Tokens: 74\.4k$/,
    );
    assert.equal(actions.elements.length, 1);
    assert.equal(card.metadata.event_payload.task_id, task.id);
    assert.equal(
      new Set(card.blocks.map((block) => block.block_id).filter(Boolean)).size,
      card.blocks.filter((block) => block.block_id).length,
    );
    assert.equal(actions.elements[0].action_id, TASK_STATUS_ACTION_ID);
    assert.deepEqual(
      actions.elements[0].options.map(({ value }) => value),
      ["Todo", "In Progress", "QA", "Done"],
    );
    assert.equal(actions.elements[0].initial_option.value, "In Progress");
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
    const context = card.blocks.find((block) => block.type === "context") as {
      elements: Array<{ text: string }>;
    };
    assert.match(
      context.elements[0].text,
      /^Status: Unavailable \| Event: Retrying \| UpdatedAt: /,
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
    const context = card.blocks.find((block) => block.type === "context") as {
      elements: Array<{ text: string }>;
    };

    assert.equal(card.text, "[service-a] Symphony connection");
    assert.match(
      context.elements[0].text,
      /^Status: Available \| Event: Recovered \| UpdatedAt: /,
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
      "*In Review* → *Rework* | Example User",
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

  it("renders a precomputed attention mention in cards and threads", () => {
    const mention = "<!subteam^SXXXXXXXX>";
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
      mention,
    );
    const thread = buildThreadMessage(
      {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
      },
      mention,
    );

    assert.match(card.text, /Attention: <!subteam\^SXXXXXXXX>/);
    const context = card.blocks.find((block) => block.type === "context") as {
      elements: Array<{ text: string }>;
    };
    assert.match(
      context.elements[0].text,
      /^Event: Ended \| UpdatedAt: <!date[^\n]+> \| Attention: <!subteam\^SXXXXXXXX>\nTurns: 1 \| Tokens: 1\.4m$/,
    );
    assert.match(thread, /\*Updated\* \| <!subteam\^SXXXXXXXX>/);
    assert.match(
      buildStatusChangedMessage("Example User", "Rework", "In Review"),
      /\*Rework\* → \*In Review\* \| Example User/,
    );
    assert.doesNotMatch(
      buildStatusChangedMessage("Example User", "In Review", "Done"),
      /SXXXXXXXX/,
    );
  });
});
