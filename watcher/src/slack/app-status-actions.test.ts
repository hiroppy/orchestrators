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
        pullRequest: {
          url: "https://github.com/example/app/pull/42",
          number: 42,
          labels: ["stg-deploy"],
        },
      });
      store.assignTask("service-a:ENG-62", "U123");
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
        (task) => {
          assert.deepEqual(task.pullRequest?.labels, ["stg-deploy"]);
          return undefined;
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
      assert.match(
        JSON.stringify(calls.find(({ method }) => method === "postMessage")?.args.blocks),
        /\*Updated at\*\\n`\d{2}:\d{2}`/,
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

  it("reports a Linear status update failure in the task thread", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      calls.length = 0;
      const errors: unknown[] = [];

      await handleStatusAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "Rework" } },
          body: {
            user: { id: "U123" },
            message: {
              metadata: {
                event_payload: { task_id: "service-a:ENG-62" },
              },
            },
          },
          client,
          logger: { error: (error) => errors.push(error) },
        },
        store,
        async () => {
          throw new Error("Linear returned HTTP 400.");
        },
      );

      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(calls.filter(({ method }) => method === "update").length, 0);
      const failure = calls.find(({ method }) => method === "postMessage");
      assert.equal(failure?.args.thread_ts, "1.000");
      assert.equal(
        failure?.args.text,
        "[error] Failed to confirm the Linear status update to Rework. The watcher still shows In Review; the Linear status may have changed. Error: Linear returned HTTP 400. Please check Linear before trying again.",
      );
      assert.equal(errors.length, 1);
    });
  });

  it("keeps unsafe Linear error details out of the task thread", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      calls.length = 0;

      await handleStatusAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "Rework" } },
          body: {
            user: { id: "U123" },
            message: { metadata: { event_payload: { task_id: "service-a:ENG-62" } } },
          },
          client,
          logger: { error: () => {} },
        },
        store,
        async () => {
          throw new Error("Linear unavailable: <!channel> secret-token");
        },
      );

      const text = String(calls.find(({ method }) => method === "postMessage")?.args.text);
      assert.doesNotMatch(text, /<!channel>|secret-token/);
      assert.match(text, /See the watcher logs for error details\./);
    });
  });

  it("escapes unsafe status markup in the failure notice", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = fakeClient(calls);
      await publishWatcherEvent(client, store, "C123", {
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "<!channel> In Review",
      });
      calls.length = 0;

      await handleStatusAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "Rework" } },
          body: {
            user: { id: "U123" },
            message: { metadata: { event_payload: { task_id: "service-a:ENG-62" } } },
          },
          client,
          logger: { error: () => {} },
        },
        store,
        async () => {
          throw new Error("Linear returned HTTP 400.");
        },
      );

      const text = String(calls.find(({ method }) => method === "postMessage")?.args.text);
      assert.doesNotMatch(text, /<!channel>/);
      assert.match(text, /&lt;!channel&gt; In Review/);
    });
  });

  it("allows status transition handling to publish the same task without deadlocking", async () => {
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

      await handleStatusAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "Done" } },
          body: {
            user: { id: "U123" },
            message: {
              metadata: { event_payload: { task_id: "service-a:ENG-62" } },
            },
          },
          client,
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        async () => {},
        async (task) => {
          await publishWatcherEvent(client, store, "C123", {
            type: "updated",
            service: task.serviceName,
            issueIdentifier: task.issueIdentifier,
            resolvedState: "Done",
            resolvedStateType: "completed",
          });
        },
      );

      assert.equal(store.getTask("service-a:ENG-62")?.linearStateType, "completed");
      assert.equal(
        calls.filter(({ method, args }) => method === "postMessage" && !args.thread_ts).length,
        2,
      );
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
