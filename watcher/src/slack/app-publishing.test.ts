import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishTaskActivities } from "../watcher/task-activity.ts";
import { publishWatcherEvent } from "./app.ts";
import { fakeClient, withStore } from "./app.test-support.ts";

describe("Slack event publishing", () => {
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
      assert.equal(updates.length, 3);
      assert.equal(updates[0].args.ts, "1.000");
      assert.deepEqual(
        (threadPosts[0].args.blocks as Array<{ type: string }>).map(({ type }) => type),
        ["section", "section", "divider", "section"],
      );
      assert.doesNotMatch(
        JSON.stringify(threadPosts[0].args.blocks),
        /\*Timeline\*.*In Progress → In Progress/,
      );
      assert.match(JSON.stringify(updates[1].args.blocks), /\*Timeline\*.*In Progress → In Review/);

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

  it("creates an initial Timeline anchor and removes stopped activity from it", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      await publishTaskActivities(
        client,
        store,
        {
          "service-a": {
            running: [{ issue_identifier: "ENG-62", last_message: "Running tests" }],
            retrying: [],
            blocked: [],
          },
        },
        new Date(0),
      );
      const publishedAt = store.getTask("service-a:ENG-62")?.activityPublishedAt;
      assert.ok(publishedAt);
      assert.ok(Date.parse(publishedAt) > 0);
      await publishWatcherEvent(client, store, "C123", {
        type: "blocked",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });

      const threadPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && args.thread_ts,
      );
      const timelineUpdates = calls.filter(
        ({ method, args }) => method === "update" && args.ts === "2.000",
      );
      const task = store.getTask("service-a:ENG-62");

      assert.equal(threadPosts.length, 2);
      assert.equal(timelineUpdates.length, 2);
      assert.match(
        JSON.stringify(timelineUpdates[0].args.blocks),
        /Current activity.*Running tests/,
      );
      assert.doesNotMatch(JSON.stringify(timelineUpdates[1].args.blocks), /Current activity/);
      assert.equal(task?.currentActivity, undefined);
      assert.equal(task?.activityPublishedAt, undefined);
    });
  });

  it("backfills a missing Timeline anchor for an existing running task", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const { task } = store.upsertTaskFromEventAtomically(
        {
          type: "started",
          service: "service-a",
          issueIdentifier: "ENG-62",
          state: "In Progress",
        },
        () => undefined,
      );
      store.setParentMessage(task.id, "C123", "1.000", "existing parent");

      await publishTaskActivities(
        client,
        store,
        {
          "service-a": {
            running: [{ issue_identifier: "ENG-62", last_message: "Running tests" }],
            retrying: [],
            blocked: [],
          },
        },
        new Date("2026-08-16T01:00:00.000Z"),
      );

      const timelinePosts = calls.filter(
        ({ method, args }) => method === "postMessage" && args.thread_ts === "1.000",
      );
      assert.equal(timelinePosts.length, 1);
      assert.match(
        JSON.stringify(timelinePosts[0]?.args.blocks),
        /Current activity.*Running tests/,
      );
      assert.ok(store.getTask(task.id)?.activityPublishedAt);
    });
  });

  it("retries clearing stopped activity after a Timeline update fails", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setTaskActivity("service-a:ENG-62", {
        message: "Running tests",
        changedFiles: [],
        changedFileCount: 0,
        additions: 0,
        deletions: 0,
      });
      store.markTaskActivityPublished("service-a:ENG-62", new Date("2026-08-16T01:00:00.000Z"));

      const update = client.chat.update;
      let failTimelineUpdate = true;
      client.chat.update = async (args) => {
        if (failTimelineUpdate && args.ts === "2.000") {
          throw new Error("Simulated Timeline failure");
        }
        return update(args);
      };
      const blocked = {
        type: "blocked" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      };

      await assert.rejects(publishWatcherEvent(client, store, "C123", blocked));
      assert.equal(store.getTask("service-a:ENG-62")?.currentActivity?.message, "Running tests");
      assert.equal(
        store.getTask("service-a:ENG-62")?.activityPublishedAt,
        "2026-08-16T01:00:00.000Z",
      );

      failTimelineUpdate = false;
      await publishWatcherEvent(client, store, "C123", blocked);
      assert.equal(store.getTask("service-a:ENG-62")?.currentActivity, undefined);
      assert.equal(store.getTask("service-a:ENG-62")?.activityPublishedAt, undefined);
    });
  });

  it("preserves the last activity during a synthetic observability outage", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);

      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.setTaskActivity("service-a:ENG-62", {
        message: "Useful activity before outage",
        changedFiles: [],
        changedFileCount: 0,
        additions: 0,
        deletions: 0,
      });
      store.markTaskActivityPublished("service-a:ENG-62", new Date(0));
      calls.length = 0;

      await publishTaskActivities(client, store, {
        "service-a": {
          running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
          retrying: [
            {
              issue_identifier: "watcher:service-a",
              state: "unavailable",
              error: "connection failed",
            },
          ],
          blocked: [],
        },
      });

      assert.equal(
        store.getTask("service-a:ENG-62")?.currentActivity?.message,
        "Useful activity before outage",
      );
      assert.equal(calls.length, 0);
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
      await assert.rejects(publishWatcherEvent(client, store, "C123", event, options));
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "started");
      assert.deepEqual(transitions, ["In Progress -> In Review"]);
      assert.deepEqual(deliveries, []);

      failUpdate = false;
      await publishWatcherEvent(client, store, "C123", event, options);
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

      await assert.rejects(publishWatcherEvent(client, store, "C123", event, options));
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "started");
      assert.deepEqual(transitions, ["In Progress -> In Review@undefined"]);
      assert.deepEqual(deliveries, []);

      postFailure = undefined;
      await publishWatcherEvent(client, store, "C123", event, options);

      assert.deepEqual(transitions, ["In Progress -> In Review@undefined"]);
      assert.deepEqual(deliveries, ["In Review"]);
    });
  });

  it("records a transition before Slack Timeline failure and delivers after recovery", async () => {
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

      const update = client.chat.update;
      let failTimeline = true;
      client.chat.update = async (args) => {
        if (failTimeline && args.ts === "2.000") throw new Error("Simulated Slack failure");
        return update(args);
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

      await assert.rejects(publishWatcherEvent(client, store, "C123", event, options));
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "started");
      assert.deepEqual(transitions, ["In Progress -> In Review"]);
      assert.deepEqual(deliveries, []);

      failTimeline = false;
      await publishWatcherEvent(client, store, "C123", event, options);
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
        issueTitle: "Merge | <deploy> & _verify_",
        issueUrl,
        resolvedState: "In Progress",
        resolvedStateType: "started",
      });
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge | <deploy> & _verify_",
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
        text: "Task closed | *Done*\n<https://example.slack.com/archives/C123/p1000|Merge ｜ &lt;deploy&gt; &amp; _verify_>",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Task closed*" } },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: "*Status*\nDone" },
              {
                type: "mrkdwn",
                text: "*Task*\n<https://example.slack.com/archives/C123/p1000|Merge ｜ &lt;deploy&gt; &amp; _verify_>",
              },
            ],
          },
        ],
        unfurl_links: false,
        unfurl_media: false,
      });
      const nextTaskPosts = calls.filter(
        ({ method, args }) => method === "postMessage" && String(args.text).startsWith("Next task"),
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
        ["1.000", "2.000", "1.000"],
      );
    });
  });
});
