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
      const publishedStatuses: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(store, undefined, async (task) => {
          publishedStatuses.push(task.status);
        }),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (issueIdentifier, status) => {
          updates.push({ issueIdentifier, status });
        },
      });

      assert.deepEqual(updates, [{ issueIdentifier: "ENG-42", status: "Canceled" }]);
      assert.deepEqual(publishedStatuses, ["In Review"]);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "Canceled");
    });
  });

  it("does not update Linear for a merged pull request", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Done");
      const updates: string[] = [];

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(store),
        findPullRequestByUrl: async (url) => ({ url, state: "MERGED" }),
        updateLinearStatus: async (_issueIdentifier, status) => {
          updates.push(status);
        },
      });

      assert.deepEqual(updates, []);
    });
  });

  it("does not replace a live terminal Linear status for a newly closed pull request", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      let publications = 0;
      const options: Parameters<typeof syncPullRequestStatuses>[0] = {
        config,
        store,
        ...syncDependencies(store),
        fetchLinearIssue: async () => ({
          identifier: "ENG-42",
          title: "Tracked task",
          state: "Done",
          stateType: "completed",
          url: null,
          pullRequest: { url: "https://github.com/example/repository/pull/42" },
        }),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        publishLinearUpdate: async (_task, pullRequest) => {
          publications += 1;
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          store.updateTaskStatus("service-a:ENG-42", "Done");
          store.setTaskLinearStateType("service-a:ENG-42", "completed");
          if (publications === 1) throw new Error("Slack unavailable");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      };

      await syncPullRequestStatuses(options);
      await syncPullRequestStatuses(options);

      assert.equal(publications, 2);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "Done");
      assert.equal(store.getTask("service-a:ENG-42")?.linearStateType, "completed");
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        [],
      );
    });
  });

  it("does not reapply Canceled after recording the close", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      const updates: string[] = [];
      const options = {
        config,
        store,
        ...syncDependencies(store),
        findPullRequestByUrl: async (url: string) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
        },
      };

      await syncPullRequestStatuses(options);
      store.updateTaskStatus("service-a:ENG-42", "In Progress");
      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, ["Canceled"]);
    });
  });

  it("publishes a later terminal Linear status after completing the close sync", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      let publications = 0;
      store.setTaskLinearStateType("service-a:ENG-42", "canceled");
      store.addEvent({
        taskId: "service-a:ENG-42",
        type: "pull_request_status_synced",
        actor: "watcher",
        fromStatus: "In Review",
        toStatus: "Canceled",
        body: JSON.stringify({
          url: "https://github.com/example/repository/pull/42",
          state: "closed",
          headRefOid: null,
        }),
      });

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(store),
        fetchLinearIssue: async () => ({
          identifier: "ENG-42",
          title: "Tracked task",
          state: "Done",
          stateType: "completed",
          url: null,
          pullRequest: { url: "https://github.com/example/repository/pull/42" },
        }),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        publishLinearUpdate: async (_task, pullRequest) => {
          publications += 1;
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          store.updateTaskStatus("service-a:ENG-42", "Done");
          store.setTaskLinearStateType("service-a:ENG-42", "completed");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      });

      assert.equal(publications, 1);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "Done");
      assert.equal(store.getTask("service-a:ENG-42")?.linearStateType, "completed");
    });
  });

  it("publishes a live reactivation without repeating a completed close mutation", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      let publications = 0;
      store.setTaskLinearStateType("service-a:ENG-42", "canceled");
      store.addEvent({
        taskId: "service-a:ENG-42",
        type: "pull_request_status_synced",
        actor: "watcher",
        fromStatus: "In Review",
        toStatus: "Canceled",
        body: JSON.stringify({
          url: "https://github.com/example/repository/pull/42",
          state: "closed",
          headRefOid: null,
        }),
      });

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(store),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        publishLinearUpdate: async (_task, pullRequest) => {
          publications += 1;
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          store.updateTaskStatus("service-a:ENG-42", "In Review");
          store.setTaskLinearStateType("service-a:ENG-42", "started");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      });

      assert.equal(publications, 1);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-42")?.linearStateType, "started");
    });
  });

  it("publishes a later terminal Linear status after the pull request reopens", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      let publications = 0;
      store.updateTaskStatus("service-a:ENG-42", "Canceled");
      store.setTaskLinearStateType("service-a:ENG-42", "canceled");
      store.addEvent({
        taskId: "service-a:ENG-42",
        type: "pull_request_status_synced",
        actor: "watcher",
        fromStatus: "In Review",
        toStatus: "Canceled",
      });

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(store),
        fetchLinearIssue: async () => ({
          identifier: "ENG-42",
          title: "Tracked task",
          state: "Done",
          stateType: "completed",
          url: null,
          pullRequest: { url: "https://github.com/example/repository/pull/42" },
        }),
        findPullRequestByUrl: async (url) => ({ url, state: "OPEN" }),
        publishLinearUpdate: async (_task, pullRequest) => {
          publications += 1;
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          store.updateTaskStatus("service-a:ENG-42", "Done");
          store.setTaskLinearStateType("service-a:ENG-42", "completed");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      });

      assert.equal(publications, 1);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "Done");
      assert.equal(store.getTask("service-a:ENG-42")?.linearStateType, "completed");
    });
  });

  it("reapplies Canceled after the same pull request reopens and closes again", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      const updates: string[] = [];
      let pullRequestState = "CLOSED";
      const options = {
        config,
        store,
        ...syncDependencies(store),
        publishLinearUpdate: async (_task, pullRequest) => {
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          const isClosed = pullRequestState === "CLOSED";
          store.updateTaskStatus("service-a:ENG-42", isClosed ? "Canceled" : "In Review");
          store.setTaskLinearStateType("service-a:ENG-42", isClosed ? "canceled" : "started");
        },
        findPullRequestByUrl: async (url: string) => ({
          url,
          state: pullRequestState,
          headRefOid: "same-head",
        }),
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
        },
      };

      await syncPullRequestStatuses(options);
      pullRequestState = "OPEN";
      await syncPullRequestStatuses(options);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "In Review");
      assert.equal(store.getTask("service-a:ENG-42")?.linearStateType, "started");
      pullRequestState = "CLOSED";
      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, ["Canceled", "Canceled"]);
      assert.equal(
        store.getLatestEventsByType("service-a:ENG-42", "pull_request_status_synced", 10).length,
        2,
      );
    });
  });

  it("completes an abandoned pending close sync when the pull request reopens", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      let publications = 0;
      store.addEvent({
        taskId: "service-a:ENG-42",
        type: "pull_request_status_sync_pending",
        actor: "watcher",
        fromStatus: "In Review",
        toStatus: "Canceled",
      });

      const options = {
        config,
        store,
        ...syncDependencies(store, undefined, async () => {
          publications += 1;
          if (publications === 1) throw new Error("Slack unavailable");
        }),
        findPullRequestByUrl: async (url) => ({ url, state: "OPEN" }),
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      };

      await syncPullRequestStatuses(options);
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        ["service-a:ENG-42"],
      );

      await syncPullRequestStatuses(options);

      assert.equal(publications, 2);
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        [],
      );
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
        ...syncDependencies(store),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (issueIdentifier) => {
          if (issueIdentifier === "ENG-42") throw new Error("Linear unavailable");
          updates.push(issueIdentifier);
        },
      });

      assert.deepEqual(updates, ["ENG-43"]);
    });
  });

  it("abandons a failed mutation when Linear moves to another terminal status", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      let linearState = { state: "In Review", stateType: "started" };
      let updates = 0;
      let publications = 0;
      const options = {
        config,
        store,
        ...syncDependencies(store),
        publishLinearUpdate: async (_task, pullRequest) => {
          publications += 1;
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          store.updateTaskStatus("service-a:ENG-42", linearState.state);
          store.setTaskLinearStateType("service-a:ENG-42", linearState.stateType);
        },
        fetchLinearIssue: async () => ({
          identifier: "ENG-42",
          title: "Tracked task",
          ...linearState,
          url: null,
          pullRequest: { url: "https://github.com/example/repository/pull/42" },
        }),
        findPullRequestByUrl: async (url: string) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async () => {
          updates += 1;
          throw new Error("Linear unavailable");
        },
      };

      await syncPullRequestStatuses(options);
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        ["service-a:ENG-42"],
      );

      linearState = { state: "Done", stateType: "completed" };
      await syncPullRequestStatuses(options);

      assert.equal(updates, 1);
      assert.equal(publications, 1);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "Done");
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        [],
      );
    });
  });

  it("treats equivalent GitHub pull request URLs as the same attachment", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      let publications = 0;
      let lookups = 0;

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(
          store,
          "https://github.com/example/repository/pull/0042/files?diff=split#discussion",
          async () => {
            publications += 1;
          },
        ),
        findPullRequestByUrl: async (url) => {
          lookups += 1;
          return { url, state: "OPEN" };
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      });

      assert.equal(lookups, 1);
      assert.equal(publications, 0);
      assert.equal(
        store.getTask("service-a:ENG-42")?.pullRequest?.url,
        "https://github.com/example/repository/pull/42",
      );
    });
  });

  it("tracks a replacement pull request across terminal reactivation and close", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      const replacementUrl = "https://github.com/example/repository/pull/43";
      let linearState = { state: "Canceled", stateType: "canceled" };
      let pullRequestState = "OPEN";
      let lookups = 0;
      let updates = 0;
      store.setTaskLinearStateType("service-a:ENG-42", "canceled");
      store.addEvent({
        taskId: "service-a:ENG-42",
        type: "pull_request_status_synced",
        actor: "watcher",
        fromStatus: "In Review",
        toStatus: "Canceled",
        body: JSON.stringify({
          url: "https://github.com/example/repository/pull/42",
          state: "closed",
          headRefOid: null,
        }),
      });
      const options = {
        config,
        store,
        ...syncDependencies(store),
        fetchLinearIssue: async () => ({
          identifier: "ENG-42",
          title: "Tracked task",
          ...linearState,
          url: null,
          pullRequest: { url: replacementUrl },
        }),
        findPullRequestByUrl: async (url: string) => {
          lookups += 1;
          return { url, state: pullRequestState };
        },
        publishLinearUpdate: async (
          _task: { id: string },
          pullRequest: { url: string } | undefined,
        ) => {
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          store.updateTaskStatus("service-a:ENG-42", linearState.state);
          store.setTaskLinearStateType("service-a:ENG-42", linearState.stateType);
        },
        updateLinearStatus: async () => {
          updates += 1;
          linearState = { state: "Canceled", stateType: "canceled" };
        },
      };

      await syncPullRequestStatuses(options);
      assert.equal(store.getTask("service-a:ENG-42")?.pullRequest?.url, replacementUrl);

      linearState = { state: "In Review", stateType: "started" };
      await syncPullRequestStatuses(options);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "In Review");

      pullRequestState = "CLOSED";
      await syncPullRequestStatuses(options);

      assert.equal(lookups, 2);
      assert.equal(updates, 1);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "Canceled");
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
        ...syncDependencies(store),
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
        ...syncDependencies(store),
        findPullRequestByUrl: async (url) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async () => undefined,
      });

      assert.equal(store.getTask("service-a:ENG-42")?.status, "Canceled");
    });
  });

  it("does not cancel from a stale pull request attachment", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];
      const publications: Array<string | undefined> = [];

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(
          store,
          "https://github.com/example/repository/pull/43",
          async (_task, pullRequest) => publications.push(pullRequest?.url),
        ),
        findPullRequestByUrl: async () => {
          throw new Error("stale pull request should not be inspected");
        },
        updateLinearStatus: async (_issueIdentifier, status) => updates.push(status),
      });

      assert.deepEqual(updates, []);
      assert.deepEqual(publications, ["https://github.com/example/repository/pull/43"]);
      assert.equal(
        store.getTask("service-a:ENG-42")?.pullRequest?.url,
        "https://github.com/example/repository/pull/43",
      );
    });
  });

  it("discovers an uncached pull request before syncing its closed state", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      store.setTaskPullRequest("service-a:ENG-42", undefined);
      const updates: string[] = [];
      let pullRequestLookups = 0;
      const options = {
        config,
        store,
        ...syncDependencies(store),
        findPullRequestByUrl: async (url: string) => {
          pullRequestLookups += 1;
          return { url, state: "CLOSED" };
        },
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
        },
      };

      await syncPullRequestStatuses(options);
      assert.equal(
        store.getTask("service-a:ENG-42")?.pullRequest?.url,
        "https://github.com/example/repository/pull/42",
      );
      assert.equal(pullRequestLookups, 0);

      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, ["Canceled"]);
      assert.equal(pullRequestLookups, 1);
    });
  });

  it("retries publishing enriched metadata for an open pull request", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      let publications = 0;
      const options = {
        config,
        store,
        ...syncDependencies(store),
        findPullRequestByUrl: async (url: string) => ({
          url,
          state: "OPEN",
          title: "Enriched pull request",
          labels: ["ready"],
        }),
        publishLinearUpdate: async (
          task: { id: string },
          pullRequest: { url: string; title?: string; labels?: string[] } | undefined,
        ) => {
          publications += 1;
          store.setTaskPullRequest(task.id, pullRequest);
          if (publications === 1) throw new Error("Slack unavailable");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      };

      await syncPullRequestStatuses(options);
      assert.equal(store.getTask("service-a:ENG-42")?.pullRequest?.title, undefined);

      await syncPullRequestStatuses(options);

      assert.equal(publications, 2);
      assert.equal(store.getTask("service-a:ENG-42")?.pullRequest?.title, "Enriched pull request");
      assert.deepEqual(store.getTask("service-a:ENG-42")?.pullRequest?.labels, ["ready"]);
    });
  });

  it("retries publishing a replacement pull request attachment", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const replacementUrl = "https://github.com/example/repository/pull/43";
      let publications = 0;
      const options = {
        config,
        store,
        ...syncDependencies(store, replacementUrl, async (_task, pullRequest) => {
          publications += 1;
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          if (publications === 1) {
            store.updateTaskStatus("service-a:ENG-42", "Canceled");
            store.setTaskLinearStateType("service-a:ENG-42", "canceled");
            throw new Error("Slack unavailable");
          }
        }),
        findPullRequestByUrl: async () => {
          throw new Error("replacement pull request should not be inspected");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      };

      await syncPullRequestStatuses(options);
      assert.equal(
        store.getTask("service-a:ENG-42")?.pullRequest?.url,
        "https://github.com/example/repository/pull/42",
      );
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        ["service-a:ENG-42"],
      );

      await syncPullRequestStatuses(options);

      assert.equal(publications, 2);
      assert.equal(store.getTask("service-a:ENG-42")?.pullRequest?.url, replacementUrl);
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        [],
      );
    });
  });

  it("retains lifecycle tracking when a replacement abandons a completed close mutation", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const originalUrl = "https://github.com/example/repository/pull/42";
      const replacementUrl = "https://github.com/example/repository/pull/43";
      let linearState = { state: "In Review", stateType: "started" };
      let linearPullRequestUrl = originalUrl;
      let pullRequestState = "CLOSED";
      let publications = 0;
      let updates = 0;
      const options = {
        config,
        store,
        ...syncDependencies(store),
        fetchLinearIssue: async () => ({
          identifier: "ENG-42",
          title: "Tracked task",
          ...linearState,
          url: null,
          pullRequest: { url: linearPullRequestUrl },
        }),
        findPullRequestByUrl: async (url: string) => ({ url, state: pullRequestState }),
        publishLinearUpdate: async (_task: { id: string }, pullRequest: { url: string }) => {
          publications += 1;
          store.setTaskPullRequest("service-a:ENG-42", pullRequest);
          store.updateTaskStatus("service-a:ENG-42", linearState.state);
          store.setTaskLinearStateType("service-a:ENG-42", linearState.stateType);
          if (publications === 1) throw new Error("Slack unavailable");
        },
        updateLinearStatus: async () => {
          updates += 1;
          linearState = { state: "Canceled", stateType: "canceled" };
        },
      };

      await syncPullRequestStatuses(options);
      linearPullRequestUrl = replacementUrl;
      await syncPullRequestStatuses(options);

      assert.equal(store.countEvents("service-a:ENG-42", "pull_request_status_synced"), 1);

      linearState = { state: "In Review", stateType: "started" };
      pullRequestState = "OPEN";
      await syncPullRequestStatuses(options);
      pullRequestState = "CLOSED";
      await syncPullRequestStatuses(options);

      assert.equal(updates, 2);
      assert.equal(store.getTask("service-a:ENG-42")?.status, "Canceled");
    });
  });

  it("publishes a removed pull request attachment", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const publications: Array<string | undefined> = [];

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(store, null, async (_task, pullRequest) => {
          publications.push(pullRequest?.url);
        }),
        findPullRequestByUrl: async () => {
          throw new Error("removed pull request should not be inspected");
        },
        updateLinearStatus: async () => {
          throw new Error("Linear status should not be updated");
        },
      });

      assert.deepEqual(publications, [undefined]);
      assert.equal(store.getTask("service-a:ENG-42")?.pullRequest, undefined);
    });
  });

  it("preserves the stored pull request when Linear is unavailable", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);

      await syncPullRequestStatuses({
        config,
        store,
        ...syncDependencies(store),
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

  it("retries Slack publication without repeating the Linear mutation", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];
      let publications = 0;
      let linearStatus = "In Review";
      const options = {
        config,
        store,
        ...syncDependencies(store, undefined, async () => {
          publications += 1;
          if (publications === 1) throw new Error("Slack unavailable");
        }),
        fetchLinearIssue: async () => ({
          identifier: "ENG-42",
          title: "Tracked task",
          state: linearStatus,
          stateType: "started",
          url: null,
          pullRequest: { url: "https://github.com/example/repository/pull/42" },
        }),
        findPullRequestByUrl: async (url: string) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
          linearStatus = status;
        },
      };

      await syncPullRequestStatuses(options);
      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, ["Canceled"]);
      assert.equal(publications, 2);
    });
  });

  it("retries until publication persists the target status", async () => {
    await withStore(async (store) => {
      const config = setupTask(store);
      const updates: string[] = [];
      let publications = 0;
      const options = {
        config,
        store,
        ...syncDependencies(store),
        publishLinearUpdate: async (task: { id: string }) => {
          publications += 1;
          if (publications === 2) store.updateTaskStatus(task.id, "Canceled");
        },
        findPullRequestByUrl: async (url: string) => ({ url, state: "CLOSED" }),
        updateLinearStatus: async (_issueIdentifier: string, status: string) => {
          updates.push(status);
        },
      };

      await syncPullRequestStatuses(options);
      assert.equal(store.countEvents("service-a:ENG-42", "pull_request_status_synced"), 0);

      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, ["Canceled", "Canceled"]);
      assert.equal(publications, 2);
      assert.equal(store.countEvents("service-a:ENG-42", "pull_request_status_synced"), 1);
    });
  });

  it("includes only terminal tasks with an incomplete pull request status sync", async () => {
    await withStore(async (store) => {
      const config = setupTask(store, "Canceled");
      store.upsertTaskFromEvent({
        type: "updated",
        service: "service-a",
        issueIdentifier: "ENG-42",
        issueTitle: "Tracked task",
        resolvedState: "Canceled",
        resolvedStateType: "canceled",
        pullRequest: { url: "https://github.com/example/repository/pull/42" },
      });
      let pullRequestLookups = 0;
      const options = {
        config,
        store,
        ...syncDependencies(store),
        findPullRequestByUrl: async (url: string) => {
          pullRequestLookups += 1;
          return { url, state: "CLOSED" };
        },
        updateLinearStatus: async () => undefined,
      };

      await syncPullRequestStatuses(options);
      assert.equal(pullRequestLookups, 0);

      store.addEvent({
        taskId: "service-a:ENG-42",
        type: "status_timeline",
        fromStatus: "In Review",
        toStatus: "Canceled",
      });
      await syncPullRequestStatuses(options);
      assert.equal(pullRequestLookups, 0);

      store.addEvent({
        taskId: "service-a:ENG-42",
        type: "pull_request_status_sync_pending",
        fromStatus: "In Review",
        toStatus: "Canceled",
      });
      await syncPullRequestStatuses(options);

      assert.equal(pullRequestLookups, 1);
      assert.equal(store.countEvents("service-a:ENG-42", "pull_request_status_synced"), 1);
      assert.deepEqual(
        store.getTaskIdsWithIncompleteEvent(
          "pull_request_status_sync_pending",
          "pull_request_status_sync_completed",
        ),
        [],
      );
    });
  });
});

function syncDependencies(
  store: WatcherStore,
  pullRequestUrl?: string | null,
  publish: (
    task: { id: string; status: string },
    pullRequest: { url: string } | undefined,
  ) => Promise<void> = async () => undefined,
) {
  return {
    fetchLinearIssue: async (issueIdentifier?: string) => {
      const identifier = issueIdentifier ?? "ENG-42";
      return {
        identifier,
        title: "Tracked task",
        state: "In Review",
        stateType: "started",
        url: null,
        pullRequest:
          pullRequestUrl === null
            ? undefined
            : {
                url:
                  pullRequestUrl ??
                  `https://github.com/example/repository/pull/${identifier.split("-").at(-1)}`,
              },
      };
    },
    publishLinearUpdate: async (
      task: { id: string; pullRequest?: { url: string } },
      pullRequest,
    ) => {
      await publish(store.getTask(task.id)!, pullRequest);
      store.setTaskPullRequest(task.id, pullRequest);
      if (pullRequest?.url === task.pullRequest?.url) {
        store.updateTaskStatus(task.id, "Canceled");
      }
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
