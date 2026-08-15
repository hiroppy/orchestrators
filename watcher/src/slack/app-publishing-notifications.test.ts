import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishWatcherEvent } from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";

describe("Slack event notifications", () => {
  it("continues without repeating a closed notification when a related reply fails", async (context) => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const errors: unknown[][] = [];
      context.mock.method(console, "error", (...args) => errors.push(args));
      const postMessage = client.chat.postMessage;
      client.chat.postMessage = async (args) => {
        if (String(args.text).startsWith("Next task")) {
          throw new Error("Slack related issue post failed");
        }
        return postMessage(args);
      };

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      const terminalEvent = {
        type: "updated" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "Done",
        resolvedStateType: "completed",
        relatedIssues: [
          {
            identifier: "ENG-63",
            title: "First next task",
            url: "https://linear.app/example/issue/ENG-63/first",
          },
          {
            identifier: "ENG-64",
            title: "Second next task",
            url: "https://linear.app/example/issue/ENG-64/second",
          },
          {
            identifier: "ENG-65",
            title: "Third next task",
            url: "https://linear.app/example/issue/ENG-65/third",
          },
        ],
      };

      await publishWatcherEvent(client, store, "C123", terminalEvent);
      await publishWatcherEvent(client, store, "C123", terminalEvent);

      assert.equal(
        calls.filter(
          ({ method, args }) =>
            method === "postMessage" && String(args.text).startsWith("Task closed"),
        ).length,
        1,
      );
      assert.equal(
        calls.filter(
          ({ method, args }) => method === "postMessage" && String(args.text).includes("ENG-63"),
        ).length,
        0,
      );
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "completed");
      assert.equal(errors.length, 1);
      assert.match(String(errors[0][0]), /Failed to post related issues/);
    });
  });

  it("mentions on configured status entry and configured events without repeating otherwise", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const notification = {
        statuses: ["In Review"],
        events: ["blocked"] as const,
      };

      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "started",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Progress",
          creatorMention: "<@UCREATOR>",
        },
        notification,
        { defaultAssignees: ["<!SUBTEAM^SREVIEWERS|reviewers>"] },
      );
      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Review",
          creatorMention: "<@UCREATOR>",
        },
        notification,
      );
      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Review",
          creatorMention: "<@UCREATOR>",
        },
        notification,
      );
      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "blocked",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Review",
          creatorMention: "<@UCREATOR>",
        },
        notification,
      );

      const threadTexts = calls
        .filter(({ method, args }) => method === "postMessage" && args.thread_ts)
        .map(({ args }) => String(args.text));
      assert.equal(threadTexts.length, 2);
      for (const text of threadTexts) {
        assert.match(text, /Assignees: .*<!subteam\^SREVIEWERS>/);
        assert.match(text, /Assignees: .*<@UCREATOR>/);
      }
    });
  });

  it("treats the first publication of a pre-seeded take-pr task as a status entry", async () => {
    await withStore(async (store) => {
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.assignTask("service-a:ENG-62", "UREQUESTER");
      store.assignTask("service-a:ENG-62", "UDEFAULT");
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

      await publishWatcherEvent(
        fakeClient(calls),
        store,
        "C123",
        {
          type: "started",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Progress",
        },
        { statuses: ["In Progress"], events: [] },
      );

      const notification = calls.find(
        ({ method, args }) => method === "postMessage" && args.thread_ts,
      );
      assert.match(String(notification?.args.text), /<@UREQUESTER>/);
      assert.match(String(notification?.args.text), /<@UDEFAULT>/);
    });
  });

  it("keeps pull requests in cards without posting duplicate thread notifications", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Build the Slack control plane",
        issueUrl: "https://linear.app/acme/issue/ENG-62/example",
        state: "running",
        resolvedState: "Todo",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        activity: "item started: reasoning",
        state: "running",
        resolvedState: "Todo",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "running",
        resolvedState: "In Progress",
      });
      store.addEvent({
        taskId: "service-a:ENG-62",
        type: "workpad_replied",
        actor: "U123",
        body: "Please review https://github.com/acme/example/pull/42",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "running",
        resolvedState: "In Progress",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          number: 42,
          title: "Keep pull request facts in the status card",
        },
      });
      await publishWatcherEvent(
        client,
        store,
        "C123",
        {
          type: "updated",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "running",
          resolvedState: "In Review",
          creatorMention: "<@UHIROPPY>",
          pullRequest: {
            url: "https://github.com/acme/example/pull/42",
            number: 42,
            title: "Keep pull request facts in the status card",
          },
        },
        {
          statuses: ["In Review"],
          events: [],
        },
      );

      const threadTexts = calls
        .filter(({ method, args }) => method === "postMessage" && args.thread_ts)
        .map(({ args }) => String(args.text));
      assert.equal(threadTexts.length, 1);
      assert.match(threadTexts[0], /^\*Todo\* → \*In Progress\*\nEvent: Updated$/);
      const timelineUpdates = calls.filter(
        ({ method, args }) => method === "update" && args.ts === "2.000",
      );
      assert.equal(timelineUpdates.length, 2);
      assert.match(JSON.stringify(timelineUpdates[0]?.args.blocks), /PR#42/);
      const timelineUpdate = timelineUpdates.at(-1);
      assert.match(
        String(timelineUpdate?.args.text),
        /^\*In Progress\* → \*In Review\*\nEvent: Updated/,
      );
      const statusTransitionBlocks = timelineUpdate?.args.blocks;
      assert.match(
        JSON.stringify(statusTransitionBlocks),
        /Keep pull request facts in the status card/,
      );
      assert.match(JSON.stringify(statusTransitionBlocks), /\*Timeline\*/);
      assert.match(JSON.stringify(statusTransitionBlocks), /Todo → In Progress/);
      assert.equal(
        store.getTask("service-a:ENG-62")?.linkUrl,
        "https://linear.app/acme/issue/ENG-62/example",
      );
      const latestCardUpdate = calls.findLast(
        ({ method, args }) => method === "update" && args.ts === "1.000",
      );
      assert.match(JSON.stringify(latestCardUpdate?.args.blocks), /github\.com/);
    });
  });
});
