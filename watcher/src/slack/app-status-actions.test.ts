import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleStatusAction, publishWatcherEvent } from "./app.ts";
import { fakeClient, waitFor, withStore } from "./app.test-support.ts";

describe("Slack status actions", () => {
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
      const hookTransitions: string[] = [];

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
        async (task, fromStatus, toStatus) => {
          assert.equal(task.status, "Rework");
          hookTransitions.push(`${fromStatus} -> ${toStatus}`);
        },
      );

      assert.deepEqual(linearUpdates, ["Rework"]);
      assert.deepEqual(hookTransitions, ["In Review -> Rework"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "Rework");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      assert.match(
        JSON.stringify(calls.find(({ method }) => method === "update")?.args.blocks),
        /linear\.app/,
      );
      assert.match(
        String(calls.find(({ method }) => method === "postMessage")?.args.text),
        /\*In Review\* → \*Rework\* by Example User/,
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
