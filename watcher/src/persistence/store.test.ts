import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDatabase } from "./database.ts";
import { WatcherStore } from "./store.ts";

describe("WatcherStore", () => {
  it("scopes dynamic statuses to each service instead of using a global enum", async () => {
    await withStore((store) => {
      store.syncDefinitions(
        [
          {
            name: "workspace-a",
            url: "https://a.test/state",
            linearTeam: "workspace-a-eng",
          },
          {
            name: "workspace-b",
            url: "https://b.test/state",
            linearTeam: "workspace-b-eng",
          },
        ],
        {
          "workspace-a-eng": {
            apiKey: "lin_a",
            teamId: "team-a",
            statuses: ["Todo", "In Progress", "QA", "Done"],
          },
          "workspace-b-eng": {
            apiKey: "lin_b",
            teamId: "team-b",
            statuses: ["Triage", "Building", "Shipped"],
          },
        },
      );

      assert.deepEqual(store.getSelectableStatuses("workspace-a"), [
        "Todo",
        "In Progress",
        "QA",
        "Done",
      ]);
      assert.deepEqual(store.getSelectableStatuses("workspace-b"), [
        "Triage",
        "Building",
        "Shipped",
      ]);
    });
  });

  it("hides removed services and restores their history when reconfigured", async () => {
    await withStore((store) => {
      const linearTeams = {
        "workspace-a-eng": {
          apiKey: "lin_test",
          teamId: "team-a",
          statuses: ["Todo", "Done"],
        },
      };
      store.syncDefinitions(
        [{ name: "service-a", url: "https://old.test/state", linearTeam: "workspace-a-eng" }],
        linearTeams,
      );
      store.replaceSnapshots({
        "service-a": {
          running: [{ issue_identifier: "ENG-62", state: "Todo" }],
          retrying: [],
          blocked: [],
        },
      });
      store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });
      store.addEvent({ taskId: "service-a:ENG-62", type: "status_hook_pending" });

      store.syncDefinitions([], linearTeams);
      store.replaceSnapshots({});

      assert.equal(store.getSnapshots()["service-a"], undefined);
      assert.deepEqual(store.getSelectableStatuses("service-a"), []);
      assert.deepEqual(store.getTasksForLinearSync(), []);
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent("status_hook_pending", "status_hook_completed"),
        [],
      );
      assert.deepEqual(
        store.getUncompletedEvents("status_hook_pending", "status_hook_completed"),
        [],
      );
      assert.equal(store.getTask("service-a:ENG-62")?.issueIdentifier, "ENG-62");
      assert.equal(store.countEvents("service-a:ENG-62", "review_requeued"), 1);

      store.syncDefinitions(
        [{ name: "service-a", url: "https://new.test/state", linearTeam: "workspace-a-eng" }],
        linearTeams,
      );

      assert.deepEqual(store.getSnapshots()["service-a"]?.running, [
        { issue_identifier: "ENG-62", state: "Todo" },
      ]);
      assert.deepEqual(store.getSelectableStatuses("service-a"), ["Todo", "Done"]);
      assert.equal(store.getTasksForLinearSync()[0]?.id, "service-a:ENG-62");
      assert.equal(
        store.getTaskIdsWithIncompleteEvent("status_hook_pending", "status_hook_completed")[0],
        "service-a:ENG-62",
      );
      assert.equal(
        store.getUncompletedEvents("status_hook_pending", "status_hook_completed")[0]?.taskId,
        "service-a:ENG-62",
      );
      assert.equal(store.countEvents("service-a:ENG-62", "review_requeued"), 1);
    });
  });

  it("round-trips normalized observations and removes tasks no longer observed", async () => {
    await withStore((store) => {
      store.syncDefinitions(
        [
          {
            name: "service-a",
            url: "https://a.test/state",
            linearTeam: "workspace-a-eng",
          },
        ],
        {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
            statuses: ["Todo", "In Progress", "Done"],
          },
        },
      );
      store.replaceSnapshots({
        "service-a": {
          running: [
            {
              issue_identifier: "ENG-62",
              state: "Custom Workflow State",
              last_message: "working",
              tokens: { total_tokens: 123 },
            },
          ],
          retrying: [],
          blocked: [],
        },
      });

      assert.deepEqual(store.getSnapshots()["service-a"]?.running, [
        {
          issue_identifier: "ENG-62",
          state: "Custom Workflow State",
        },
      ]);
      assert.deepEqual(store.getSelectableStatuses("service-a"), ["Todo", "In Progress", "Done"]);

      store.replaceSnapshots({
        "service-a": { running: [], retrying: [], blocked: [] },
      });
      assert.deepEqual(store.getSnapshots()["service-a"], {
        running: [],
        retrying: [],
        blocked: [],
      });
    });
  });

  it("allows free-form transitions only to statuses configured for that service", async () => {
    await withStore((store) => {
      store.syncDefinitions(
        [
          {
            name: "service-a",
            url: "https://a.test/state",
            linearTeam: "workspace-a-eng",
          },
        ],
        {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
            statuses: ["Todo", "QA", "Done"],
          },
        },
      );
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "Todo",
      });

      assert.equal(store.updateTaskStatus("service-a:ENG-62", "Done").task.status, "Done");
      assert.equal(store.updateTaskStatus("service-a:ENG-62", "Todo").task.status, "Todo");
      assert.throws(() => store.updateTaskStatus("service-a:ENG-62", "Shipped"), /not configured/);
    });
  });

  it("stores unique assignees per task", async () => {
    await withStore((store) => {
      store.syncDefinitions(
        [{ name: "service-a", url: "https://a.test/state", linearTeam: "workspace-a-eng" }],
        {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
            statuses: ["In Progress"],
          },
        },
      );
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-63",
        state: "In Progress",
      });

      assert.equal(store.assignTask("service-a:ENG-62", "U123"), true);
      assert.equal(store.assignTask("service-a:ENG-62", "U123"), false);
      assert.equal(store.assignTask("service-a:ENG-62", "U456"), true);
      assert.equal(store.assignTask("service-a:ENG-62", "!subteam^S123"), true);
      assert.deepEqual(store.getTaskAssignees("service-a:ENG-62"), [
        "<@U123>",
        "<@U456>",
        "<!subteam^S123>",
      ]);
      assert.deepEqual(store.getTaskAssignees("service-a:ENG-63"), []);
    });
  });

  it("counts events only after the latest boundary", async () => {
    await withStore((store) => {
      store.syncDefinitions(
        [
          {
            name: "service-a",
            url: "https://a.test/state",
            linearTeam: "workspace-a-eng",
          },
        ],
        {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
            statuses: ["In Progress", "In Review"],
          },
        },
      );
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });

      for (let count = 0; count < 3; count += 1) {
        store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });
      }
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeued",
          "review_requeue_limit_reached",
        ),
        3,
      );

      store.addEvent({
        taskId: "service-a:ENG-62",
        type: "review_requeue_limit_reached",
      });
      store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });

      assert.equal(store.countEvents("service-a:ENG-62", "review_requeued"), 4);
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeued",
          "review_requeue_limit_reached",
        ),
        1,
      );

      store.addEvent({
        taskId: "service-a:ENG-62",
        type: "review_requeue_limit_reached",
      });
      store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });
      store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });

      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeued",
          "review_requeue_limit_reached",
        ),
        2,
      );
    });
  });

  it("rolls back a batch when any event cannot be recorded", async () => {
    await withStore((store) => {
      store.syncDefinitions(
        [{ name: "service-a", url: "https://a.test/state", linearTeam: "workspace-a-eng" }],
        {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
            statuses: ["In Progress", "In Review"],
          },
        },
      );
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });

      assert.throws(
        () =>
          store.addEvents([
            { taskId: "service-a:ENG-62", type: "review_requeued" },
            { taskId: "service-a:missing", type: "review_requeue_limit_pending" },
          ]),
        /Task not found/,
      );
      assert.equal(store.countEvents("service-a:ENG-62", "review_requeued"), 0);

      store.addEvent({
        taskId: "service-a:ENG-62",
        type: "review_requeue_limit_pending",
      });
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "review_requeue_limit_pending",
          "review_requeue_limit_reached",
        ),
        ["service-a:ENG-62"],
      );
      store.addEvent({
        taskId: "service-a:ENG-62",
        type: "review_requeue_limit_reached",
      });
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "review_requeue_limit_pending",
          "review_requeue_limit_reached",
        ),
        [],
      );
    });
  });
});

async function withStore(run: (store: WatcherStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "watcher-store-"));
  const database = createDatabase(join(directory, "watcher.db"));

  try {
    await run(new WatcherStore(database.db));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
