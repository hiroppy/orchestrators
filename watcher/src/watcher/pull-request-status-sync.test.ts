import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import { linearTeams, runtimeConfig, withStore } from "./runner.test-support.ts";
import { syncPullRequestStatuses } from "./pull-request-status-sync.ts";

describe("pull request status sync", () => {
  for (const testCase of [
    { name: "no checks have registered", checks: [] },
    { name: "CI is running", checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
    { name: "CI failed", checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }] },
  ]) {
    it(`keeps Linear In Progress when ${testCase.name}`, async () => {
      await withStore(async (store) => {
        const config = setupTask(store, "In Progress");
        const updates: string[] = [];

        await syncPullRequestStatuses({
          config,
          store,
          findPullRequestByUrl: async (url) => ({
            url,
            state: "OPEN",
            isDraft: false,
            checks: testCase.checks,
          }),
          updateLinearStatus: async (_issueIdentifier, status) => {
            updates.push(status);
          },
        });

        assert.deepEqual(updates, []);
      });
    });
  }

  it("moves Linear to In Review after every registered check passes", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "In Progress");
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        findPullRequestByUrl: async (url) => ({
          url,
          state: "OPEN",
          isDraft: false,
          checks: [
            { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
            { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
          ],
        }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, ["In Review"]);
    });
  });

  it("keeps a draft pull request In Progress after its checks pass", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "In Progress");
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        findPullRequestByUrl: async (url) => ({
          url,
          state: "OPEN",
          isDraft: true,
          checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, []);
    });
  });

  it("returns an In Review issue to In Progress when CI fails", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        findPullRequestByUrl: async (url) => ({
          url,
          state: "OPEN",
          isDraft: false,
          checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
        }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, ["In Progress"]);
    });
  });

  it("keeps an In Review issue unchanged when checks are unavailable", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        findPullRequestByUrl: async (url) => ({ url, state: "OPEN", isDraft: false }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, []);
    });
  });

  it("allows repaired CI on the same head to return to In Review", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];
      let conclusion = "FAILURE";
      const options = {
        config,
        store,
        findPullRequestByUrl: async (url: string) => ({
          url,
          state: "OPEN",
          isDraft: false,
          headRefOid: "head-1",
          checks: [{ name: "test", status: "COMPLETED", conclusion }],
        }),
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
        },
      };

      await syncPullRequestStatuses(options);
      store.updateTaskStatus("service-a:ENG-42", "In Progress");
      conclusion = "SUCCESS";
      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, ["In Progress", "In Review"]);
    });
  });

  it("moves Linear to Canceled when a pull request closes without merging", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: Array<{ issueIdentifier: string; status: string }> = [];

      await syncPullRequestStatuses({
        config,
        store,
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (issueIdentifier, status) => {
          updates.push({ issueIdentifier, status });
        },
      });

      assert.deepEqual(updates, [{ issueIdentifier: "ENG-42", status: "Canceled" }]);
    });
  });

  it("does not update Linear for a merged pull request", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Done");
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        findPullRequestByUrl: async (url) => ({ url, state: "MERGED" }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, []);
    });
  });

  it("does not reapply Canceled after recording the close", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      const updates: string[] = [];
      const options = {
        config,
        store,
        findPullRequestByUrl: async (url: string) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
        },
      };

      await syncPullRequestStatuses(options);
      store.updateTaskStatus("service-a:ENG-42", "In Progress");
      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, []);
    });
  });

  it("continues syncing other tasks when one Linear update fails", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-43",
        issueTitle: "Second task",
        resolvedState: "In Review",
        pullRequest: { url: "https://github.com/example/repository/pull/43" },
      });
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (issueIdentifier) => {
          if (issueIdentifier === "ENG-42") throw new Error("Linear unavailable");
          updates.push(issueIdentifier);
        },
      });

      assert.deepEqual(updates, ["ENG-43"]);
    });
  });
});

function setupTask(store: WatcherStore, status = "In Review") {
  const teams = linearTeams(["In Progress", "In Review", "Done", "Canceled"]);
  const service = {
    name: "service-a",
    url: "data:application/json,{}",
    linearTeam: "workspace-a-eng",
  };
  store.syncDefinitions([service], teams);
  store.upsertTaskFromEvent({
    type: "started",
    service: "service-a",
    issueIdentifier: "ENG-42",
    issueTitle: "Tracked task",
    resolvedState: status,
    pullRequest: { url: "https://github.com/example/repository/pull/42" },
  });
  return runtimeConfig({
    services: [service],
    linearTeams: teams,
    pullRequestStatusSync: { closed: "Canceled" },
    reviewComment: { inProgressStatus: "In Progress", inReviewStatus: "In Review" },
    defaultAssignees: [],
  });
}
