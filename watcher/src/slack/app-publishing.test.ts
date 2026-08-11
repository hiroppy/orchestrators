import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishWatcherEvent, publishWatcherStarted } from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";

describe("Slack event publishing", () => {
  it("posts one top-level channel message when the watcher starts", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

    await publishWatcherStarted(fakeClient(calls), "C123", ["service-a", "service-b", "service-c"]);

    assert.deepEqual(calls, [
      {
        method: "postMessage",
        args: {
          channel: "C123",
          text: [
            "Watcher started | monitoring 3 services",
            "- service-a",
            "- service-b",
            "- service-c",
          ].join("\n"),
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "*Watcher started*" },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Services*\n• service-a\n• service-b\n• service-c",
              },
            },
          ],
        },
      },
    ]);
  });

  it("updates one parent while suppressing routine lifecycle thread noise", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });

      const topLevelPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && !args.thread_ts,
      );
      const threadPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && args.thread_ts,
      );
      const updates = calls.filter(({ method }) => method === "update");

      assert.equal(topLevelPosts.length, 1);
      assert.equal(threadPosts.length, 1);
      assert.equal(updates.length, 2);
      assert.equal(updates[0].args.ts, "1.000");
      assert.deepEqual(
        (threadPosts[0].args.blocks as Array<{ type: string }>).map(({ type }) => type),
        ["section", "section"],
      );

      const initialActions = (topLevelPosts[0].args.blocks as Array<Record<string, unknown>>).find(
        ({ type }) => type === "actions",
      ) as {
        block_id: string;
      };
      const updatedActions = (updates[0].args.blocks as Array<Record<string, unknown>>).find(
        ({ type }) => type === "actions",
      ) as {
        block_id: string;
        elements: Array<{ initial_option: { value: string } }>;
      };
      assert.notEqual(updatedActions.block_id, initialActions.block_id);
      assert.equal(updatedActions.elements[0].initial_option.value, "In Review");
    });
  });

  it("records a status transition before Slack update failure and delivers after recovery", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let failUpdate = false;
      const client = fakeClient(calls);
      const update = client.chat.update;
      client.chat.update = async (args) => {
        if (failUpdate) throw new Error("Simulated Slack failure");
        return update(args);
      };
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
        resolvedStateType: "started",
      });

      const transitions: string[] = [];
      const deliveries: string[] = [];
      const event = {
        type: "updated" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      };
      const options = {
        onStatusTransition: async (task: { status: string }, fromStatus: string) => {
          transitions.push(`${fromStatus} -> ${task.status}`);
        },
        afterPublish: async (task: { status: string }) => {
          deliveries.push(task.status);
        },
      };

      failUpdate = true;
      await assert.rejects(publishWatcherEvent(client, store, "C123", event, undefined, options));
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "started");
      assert.deepEqual(transitions, ["In Progress -> In Review"]);
      assert.deepEqual(deliveries, []);

      failUpdate = false;
      await publishWatcherEvent(client, store, "C123", event, undefined, options);
      assert.deepEqual(transitions, ["In Progress -> In Review"]);
      assert.deepEqual(deliveries, ["In Review"]);
    });
  });

  it("delivers a transition hook after Slack omits the new parent's channel and timestamp", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const postMessage = client.chat.postMessage;
      let postFailure: "throw" | "malformed" | undefined = "throw";
      client.chat.postMessage = async (args) => {
        if (postFailure === "throw") throw new Error("Simulated Slack failure");
        if (postFailure === "malformed") return { ok: true };
        return postMessage(args);
      };

      await assert.rejects(
        publishWatcherEvent(client, store, "C123", {
          type: "started",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Progress",
          resolvedStateType: "started",
        }),
      );
      assert.equal(store.getTask("service-a:ENG-62")?.parentMessageTs, undefined);
      postFailure = "malformed";

      const transitions: string[] = [];
      const deliveries: string[] = [];
      const event = {
        type: "updated" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      };
      const options = {
        onStatusTransition: async (
          task: { status: string; parentMessageTs?: string },
          fromStatus: string,
        ) => {
          transitions.push(`${fromStatus} -> ${task.status}@${task.parentMessageTs}`);
        },
        afterPublish: async (task: { status: string }) => {
          deliveries.push(task.status);
        },
      };

      await assert.rejects(publishWatcherEvent(client, store, "C123", event, undefined, options));
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "started");
      assert.deepEqual(transitions, ["In Progress -> In Review@undefined"]);
      assert.deepEqual(deliveries, []);

      postFailure = undefined;
      await publishWatcherEvent(client, store, "C123", event, undefined, options);

      assert.deepEqual(transitions, ["In Progress -> In Review@undefined"]);
      assert.deepEqual(deliveries, ["In Review"]);
    });
  });

  it("records a transition before Slack thread failure and delivers after recovery", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
        resolvedStateType: "started",
      });

      const postMessage = client.chat.postMessage;
      let failThread = true;
      client.chat.postMessage = async (args) => {
        if (failThread && args.thread_ts) throw new Error("Simulated Slack failure");
        return postMessage(args);
      };
      const transitions: string[] = [];
      const deliveries: string[] = [];
      const event = {
        type: "updated" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      };
      const options = {
        onStatusTransition: async (task: { status: string }, fromStatus: string) => {
          transitions.push(`${fromStatus} -> ${task.status}`);
        },
        afterPublish: async (task: { status: string }) => {
          deliveries.push(task.status);
        },
      };

      await assert.rejects(publishWatcherEvent(client, store, "C123", event, undefined, options));
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "started");
      assert.deepEqual(transitions, ["In Progress -> In Review"]);
      assert.deepEqual(deliveries, []);

      failThread = false;
      await publishWatcherEvent(client, store, "C123", event, undefined, options);
      assert.deepEqual(transitions, ["In Progress -> In Review"]);
      assert.deepEqual(deliveries, ["In Review"]);
    });
  });

  it("posts an existing parent permalink once when the issue enters a terminal state", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const issueUrl = "https://linear.app/example/issue/ENG-62/example";

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        issueUrl,
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        issueUrl,
        resolvedState: "Done",
        resolvedStateType: "completed",
        relatedIssues: [
          {
            identifier: "ENG-63",
            title: "Deploy the merged change",
            url: "https://linear.app/example/issue/ENG-63/deploy",
          },
          {
            identifier: "ENG-64",
            title: "Verify production",
            url: "https://linear.app/example/issue/ENG-64/verify",
          },
        ],
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        issueUrl,
        resolvedState: "Done",
        resolvedStateType: "completed",
      });

      const topLevelPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && !args.thread_ts,
      );
      assert.equal(topLevelPosts.length, 2);
      assert.match(JSON.stringify(topLevelPosts[0].args.blocks), new RegExp(issueUrl));
      assert.deepEqual(topLevelPosts[1].args, {
        channel: "C123",
        text: "Task closed | *Done*\nhttps://example.slack.com/archives/C123/p1000",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Task closed*" } },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: "*Status*\nDone" },
              {
                type: "mrkdwn",
                text: "*Task*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
              },
            ],
          },
        ],
        unfurl_links: false,
        unfurl_media: false,
      });
      const nextTaskPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && args.thread_ts === "2.000",
      );
      assert.equal(nextTaskPosts.length, 1);
      assert.equal(
        nextTaskPosts[0].args.text,
        "Next task | <https://linear.app/example/issue/ENG-63/deploy|ENG-63: Deploy the merged change> | <https://linear.app/example/issue/ENG-64/verify|ENG-64: Verify production>",
      );
      const nextTaskBlocks = nextTaskPosts[0].args.blocks as Array<Record<string, unknown>>;
      assert.deepEqual(
        nextTaskBlocks.map(({ type }) => type),
        ["section", "section", "section"],
      );
      assert.equal(
        nextTaskBlocks.some(({ fields }) => fields !== undefined),
        false,
      );
      assert.match(JSON.stringify(nextTaskBlocks[1]), /ENG-63/);
      assert.match(JSON.stringify(nextTaskBlocks[2]), /ENG-64/);
      assert.equal(store.getTask("service-a:ENG-62")?.parentMessageTs, "1.000");
      assert.deepEqual(
        calls.filter(({ method }) => method === "update").map(({ args }) => args.ts),
        ["1.000", "1.000"],
      );
    });
  });
});
