import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WatcherStore } from "../persistence/store.ts";
import { linearTeams, runtimeConfig, withStore } from "./runner.test-support.ts";
import { syncPullRequestStatuses } from "./pull-request-status-sync.ts";

describe("pull request status sync", () => {
  it("moves Linear to Canceled when a pull request closes without merging", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: Array<{ issueIdentifier: string; status: string }> = [];

      const updatedTaskIds = await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (issueIdentifier, status) => {
          updates.push({ issueIdentifier, status });
        },
      });

      assert.deepEqual(updates, [{ issueIdentifier: "ENG-42", status: "Canceled" }]);
      assert.deepEqual([...updatedTaskIds], ["service-a:ENG-42"]);
    });
  });

  it("does not update Linear for a merged pull request", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Done");
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(),
        findPullRequestByUrl: async (url) => ({ url, state: "MERGED" }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, []);
    });
  });

  it("queues reconciliation without repeating a completed Linear mutation", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];
      const options = {
        config,
        store,
        ...syncDependencies("Canceled"),
        findPullRequestByUrl: async (url: string) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
        },
      };

      const updatedTaskIds = await syncPullRequestStatuses(options);

      assert.deepEqual(updates, []);
      assert.deepEqual([...updatedTaskIds], ["service-a:ENG-42"]);
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
        ...syncDependencies(),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (issueIdentifier) => {
          if (issueIdentifier === "ENG-42") throw new Error("Linear unavailable");
          updates.push(issueIdentifier);
        },
      });

      assert.deepEqual(updates, ["ENG-43"]);
    });
  });

  it("continues syncing other tasks when one pull request lookup fails", async () => {
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
        ...syncDependencies(),
        findPullRequestByUrl: async (url) => {
          if (url.endsWith("/42")) throw new Error("GitHub unavailable");
          return { url, state: "CLOSED" };
        },
        updateLinearStatus: async (issueIdentifier) => {
          updates.push(issueIdentifier);
        },
      });

      assert.deepEqual(updates, ["ENG-43"]);
    });
  });

  it("persists the team's canonical status name", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      config.pullRequestStatusSync = { closed: "canceled" };

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          assert.equal(status, "Canceled");
        },
      });
    });
  });

  it("does not cancel from a stale pull request attachment", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies("In Review", "https://github.com/example/repository/pull/43"),
        findPullRequestByUrl: async () => {
          throw new Error("stale pull request should not be inspected");
        },
        updateLinearStatus: async (_issueIdentifier, status) => updates.push(status),
      });

      assert.deepEqual(updates, []);
      assert.equal(
        store.getTask("service-a:ENG-42")?.pullRequest?.url,
        "https://github.com/example/repository/pull/43",
      );
    });
  });

  it("preserves the stored pull request when Linear is unavailable", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(),
        fetchLinearIssue: async () => null,
        findPullRequestByUrl: async () => {
          throw new Error("pull request should not be inspected");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      });

      assert.equal(
        store.getTask("service-a:ENG-42")?.pullRequest?.url,
        "https://github.com/example/repository/pull/42",
      );
    });
  });
});

function syncDependencies(linearStatus = "In Review", pullRequestUrl?: string) {
  return {
    fetchLinearIssue: async (issueIdentifier?: string) => {
      const identifier = issueIdentifier ?? "ENG-42";
      return {
        identifier,
        title: "Tracked task",
        state: linearStatus,
        stateType: "started",
        url: null,
        pullRequest: {
          url:
            pullRequestUrl ??
            `https://github.com/example/repository/pull/${identifier.split("-").at(-1)}`,
        },
      };
    },
  };
}

function setupTask(store: WatcherStore, status = "In Review") {
  const teams = linearTeams(["In Progress", "In Review", "Done", "Canceled"]);
  const service = {
    name: "service-a",
    url: "data:application/json,{}",
    linearTeam: "workspace-a-eng",
    statusHooks: [{ id: "notify-canceled", status: "Canceled", run: () => undefined }],
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
    defaultAssignees: [],
  });
}
