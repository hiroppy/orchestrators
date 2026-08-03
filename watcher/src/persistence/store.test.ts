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
          last_message: "working",
          tokens: { total_tokens: 123 },
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
