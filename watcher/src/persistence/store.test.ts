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

  it("stores and clears the latest task activity and its Slack publication time", async () => {
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
      store.replaceSnapshots({
        "service-a": {
          running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
          retrying: [],
          blocked: [],
        },
      });
      store.setTaskActivity("service-a:ENG-62", {
        message: "Running tests",
        changedFiles: ["views.ts"],
        changedFileCount: 1,
        additions: 4,
        deletions: 2,
      });
      store.markTaskActivityPublished("service-a:ENG-62", new Date("2026-08-16T01:00:15.000Z"));

      const task = store.getTask("service-a:ENG-62");
      assert.equal(task?.currentActivity?.message, "Running tests");
      assert.deepEqual(task?.currentActivity?.changedFiles, ["views.ts"]);
      assert.equal(task?.activityPublishedAt, "2026-08-16T01:00:15.000Z");

      store.setTaskActivity("service-a:ENG-62", undefined);

      const clearedTask = store.getTask("service-a:ENG-62");
      assert.equal(clearedTask?.currentActivity, undefined);
      assert.equal(clearedTask?.activityPublishedAt, undefined);
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

      const assignedAt = new Date("2026-01-01T00:00:00.000Z");
      assert.equal(store.assignTask("service-a:ENG-62", "U123", assignedAt), true);
      assert.equal(store.assignTask("service-a:ENG-62", "U123", assignedAt), false);
      assert.equal(store.assignTask("service-a:ENG-62", "U456", assignedAt), true);
      assert.equal(store.assignTask("service-a:ENG-62", "!subteam^S123", assignedAt), true);
      assert.deepEqual(store.getTaskAssignees("service-a:ENG-62"), [
        "<!subteam^S123>",
        "<@U123>",
        "<@U456>",
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

  it("rolls back a status update when an atomic event cannot be recorded", async () => {
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
          store.updateTaskStatusAtomically("service-a:ENG-62", "In Progress", () => [
            { taskId: "service-a:ENG-62", type: "review_requeued" },
            { taskId: "service-a:missing", type: "review_comment_handled" },
          ]),
        /Task not found/,
      );
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.equal(store.countEvents("service-a:ENG-62", "review_requeued"), 0);
    });
  });

  it("orders recovered timeline events by occurrence time and finds their source key", async () => {
    await withStore((store) => {
      store.syncDefinitions(
        [{ name: "service-a", url: "https://a.test/state", linearTeam: "workspace-a-eng" }],
        {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
            statuses: ["Todo", "In Progress", "Done"],
          },
        },
      );
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "Done",
      });
      const delivered = store.addEvent({
        taskId: task.id,
        type: "status_timeline",
        statusEventKey: "source:later",
        fromStatus: "In Progress",
        toStatus: "Done",
        createdAt: new Date("2026-08-15T12:00:00Z"),
      });
      store.addEvent({
        taskId: task.id,
        type: "status_timeline",
        fromStatus: "Todo",
        toStatus: "In Progress",
        createdAt: new Date("2026-08-15T11:00:00Z"),
      });

      assert.deepEqual(
        store.getLatestEventsByType(task.id, "status_timeline", 2).map((event) => event.toStatus),
        ["Done", "In Progress"],
      );
      assert.equal(store.hasStatusTimelineEvent(task.id, "source:later"), true);
      assert.equal(store.hasStatusTimelineEvent(task.id, "source:missing"), false);

      store.setTaskEventSlackThreadTs(delivered.id, "20.000");
      for (let index = 0; index < 12; index += 1) {
        store.addEvent({
          taskId: task.id,
          type: "status_timeline",
          fromStatus: "In Progress",
          toStatus: "Done",
          createdAt: new Date(`2026-08-15T13:${String(index).padStart(2, "0")}:00Z`),
        });
      }

      assert.equal(
        store
          .getLatestEventsByType(task.id, "status_timeline", 12)
          .some((event) => event.slackThreadTs),
        false,
      );
      assert.equal(
        store.getLatestDeliveredEventsByType(task.id, "status_timeline", 1)[0]?.slackThreadTs,
        "20.000",
      );

      for (let index = 0; index < 12; index += 1) {
        const unchanged = store.addEvent({
          taskId: task.id,
          type: "status_timeline",
          fromStatus: "Done",
          toStatus: "Done",
          createdAt: new Date(`2026-08-15T14:${String(index).padStart(2, "0")}:00Z`),
        });
        store.setTaskEventSlackThreadTs(unchanged.id, `21.${String(index).padStart(3, "0")}`);
      }

      assert.equal(store.getLatestDeliveredStatusChanges(task.id, 1)[0]?.id, delivered.id);
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
