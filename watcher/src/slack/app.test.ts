import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDatabase } from "../persistence/database.ts";
import { handleStatusAction, publishWatcherStarted, publishWatcherEvent } from "./app.ts";
import { WatcherStore } from "../persistence/store.ts";

describe("Slack app behavior", () => {
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
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "Watcher started | monitoring 3 services",
                    },
                  ],
                },
                {
                  type: "rich_text_list",
                  style: "bullet",
                  elements: [
                    {
                      type: "rich_text_section",
                      elements: [{ type: "text", text: "service-a" }],
                    },
                    {
                      type: "rich_text_section",
                      elements: [{ type: "text", text: "service-b" }],
                    },
                    {
                      type: "rich_text_section",
                      elements: [{ type: "text", text: "service-c" }],
                    },
                  ],
                },
              ],
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
      });
      assert.equal(store.getTask("service-a:ENG-62")?.parentMessageTs, "1.000");
      assert.deepEqual(
        calls.filter(({ method }) => method === "update").map(({ args }) => args.ts),
        ["1.000", "1.000"],
      );
    });
  });

  it("mentions on configured status entry and configured events without repeating otherwise", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      const mention = {
        target: "<!subteam^S123>",
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
        },
        mention,
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
        },
        mention,
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
        },
        mention,
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
        },
        mention,
      );

      const threadTexts = calls
        .filter(({ method, args }) => method === "postMessage" && args.thread_ts)
        .map(({ args }) => String(args.text));
      assert.equal(threadTexts.length, 2);
      assert.match(threadTexts[0], /\| <!subteam\^S123>/);
      assert.match(threadTexts[1], /\| <!subteam\^S123>/);
    });
  });

  it("posts only status transitions and pull request links to the thread", async () => {
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
      await publishWatcherEvent(client, store, "C123", {
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "running",
        resolvedState: "In Progress",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          number: 42,
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
          pullRequest: {
            url: "https://github.com/acme/example/pull/42",
            number: 42,
          },
        },
        {
          target: "<@UHIROPPY>",
          statuses: ["In Review"],
          events: [],
        },
      );

      const threadTexts = calls
        .filter(({ method, args }) => method === "postMessage" && args.thread_ts)
        .map(({ args }) => String(args.text));
      assert.deepEqual(threadTexts, [
        "*Todo* → *In Progress*",
        "*PR created* | <https://github.com/acme/example/pull/42|PR#42>",
        "*In Progress* → *In Review* | <@UHIROPPY> | <https://github.com/acme/example/pull/42|PR#42>",
      ]);
      assert.equal(
        store.getTask("service-a:ENG-62")?.linkUrl,
        "https://linear.app/acme/issue/ENG-62/example",
      );
      const latestCardUpdate = calls.findLast(({ method }) => method === "update");
      assert.match(JSON.stringify(latestCardUpdate?.args.blocks), /github\.com/);
    });
  });

  it("acks first, accepts backward transitions, updates the card, and writes thread history", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueUrl: "https://linear.app/example/issue/ENG-62/title",
        state: "In Review",
      });
      calls.length = 0;
      let acknowledged = false;
      const linearUpdates: string[] = [];

      await handleStatusAction(
        {
          ack: async () => {
            acknowledged = true;
          },
          action: { selected_option: { value: "Rework" } },
          body: {
            user: { id: "U123" },
            message: {
              metadata: {
                event_payload: { task_id: "service-a:ENG-62" },
              },
            },
          },
          client: {
            chat: {
              postMessage: async (args) => {
                assert.equal(acknowledged, true);
                return client.chat.postMessage(args);
              },
              update: async (args) => {
                assert.equal(acknowledged, true);
                return client.chat.update(args);
              },
            },
            users: {
              info: async ({ user }) => ({
                ok: true,
                user: {
                  id: user,
                  profile: { display_name: "Example User" },
                },
              }),
            },
          },
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        async (task, status) => {
          assert.equal(task.issueIdentifier, "ENG-62");
          linearUpdates.push(status);
        },
      );

      assert.deepEqual(linearUpdates, ["Rework"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "Rework");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      assert.match(
        JSON.stringify(calls.find(({ method }) => method === "update")?.args.blocks),
        /linear\.app/,
      );
      assert.match(
        String(calls.find(({ method }) => method === "postMessage")?.args.text),
        /\*In Review\* → \*Rework\* \| Example User/,
      );
    });
  });

  it("keeps the database unchanged when the Slack card update fails", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      const errors: unknown[] = [];
      let linearUpdated = false;

      await handleStatusAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "Done" } },
          body: {
            user: { id: "U123" },
            message: {
              metadata: {
                event_payload: { task_id: "service-a:ENG-62" },
              },
            },
          },
          client: {
            chat: {
              postMessage: client.chat.postMessage,
              update: async () => {
                throw new Error("Slack update failed");
              },
            },
          },
          logger: { error: (error) => errors.push(error) },
        },
        store,
        async () => {
          linearUpdated = true;
        },
      );

      assert.equal(linearUpdated, true);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
      assert.equal(errors.length, 1);
    });
  });

  it("serializes concurrent status changes for the same task", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      calls.length = 0;

      let releaseFirst!: () => void;
      const firstUpdate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const linearUpdates: string[] = [];
      const updateLinearStatus = async (_task: unknown, status: string) => {
        linearUpdates.push(status);
        if (status === "Rework") await firstUpdate;
      };
      const action = (status: string) =>
        handleStatusAction(
          {
            ack: async () => {},
            action: { selected_option: { value: status } },
            body: {
              user: { id: "U123" },
              message: {
                metadata: {
                  event_payload: { task_id: "service-a:ENG-62" },
                },
              },
            },
            client,
            logger: { error: (error) => assert.fail(String(error)) },
          },
          store,
          updateLinearStatus,
        );

      const first = action("Rework");
      const second = action("Done");
      await waitFor(() => linearUpdates.length === 1);
      assert.deepEqual(linearUpdates, ["Rework"]);

      releaseFirst();
      await Promise.all([first, second]);

      assert.deepEqual(linearUpdates, ["Rework", "Done"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "Done");
    });
  });
});

function fakeClient(calls: Array<{ method: string; args: Record<string, unknown> }>) {
  let timestamp = 0;
  return {
    chat: {
      async getPermalink(args: Record<string, unknown>) {
        calls.push({ method: "getPermalink", args });
        const messageTs = String(args.message_ts).replace(".", "");
        return {
          ok: true,
          channel: String(args.channel),
          permalink: `https://example.slack.com/archives/${args.channel}/p${messageTs}`,
        };
      },
      async postMessage(args: Record<string, unknown>) {
        timestamp += 1;
        calls.push({ method: "postMessage", args });
        return { ok: true, channel: String(args.channel), ts: `${timestamp}.000` };
      },
      async update(args: Record<string, unknown>) {
        calls.push({ method: "update", args });
        return { ok: true, channel: String(args.channel), ts: String(args.ts) };
      },
    },
  } as never;
}

async function withStore(run: (store: WatcherStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "watcher-slack-app-"));
  const database = createDatabase(join(directory, "watcher.db"));
  const store = new WatcherStore(database.db);
  store.syncDefinitions(
    [
      {
        name: "service-a",
        url: "https://service.test/state",
        linearTeam: "workspace-a-eng",
      },
    ],
    {
      "workspace-a-eng": {
        apiKey: "lin_test",
        teamId: "team-a",
        statuses: ["Todo", "In Progress", "Rework", "In Review", "Done"],
      },
    },
  );

  try {
    await run(store);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Condition was not met.");
}
