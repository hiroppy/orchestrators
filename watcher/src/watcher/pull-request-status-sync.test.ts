import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequest } from "../domain/github.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { runOnce } from "./run-once.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";
import { syncPullRequestStatuses } from "./pull-request-status-sync.ts";

const pullRequestUrl = "https://github.com/acme/example/pull/42";

describe("pull request status sync", () => {
  it("is disabled when the setting is omitted", async () => {
    await withStore(async (store) => {
      const config = setup(store);
      let lookups = 0;

      await syncPullRequestStatuses({
        config,
        store,
        fetchLinearIssue: async () => assert.fail("must not fetch Linear"),
        findPullRequestByUrl: async () => {
          lookups += 1;
          return pullRequest("CLOSED");
        },
        updateLinearStatus: async () => assert.fail("must not update Linear"),
      });

      assert.equal(lookups, 0);
    });
  });

  it("moves a closed pull request to the canonical configured status once", async () => {
    await withStore(async (store) => {
      const config = setup(store, { closed: "canceled" });
      const updates: unknown[][] = [];
      const options = {
        config,
        store,
        fetchLinearIssue: async () => linearIssue(pullRequestUrl),
        findPullRequestByUrl: async () => pullRequest("CLOSED"),
        updateLinearStatus: async (...args: unknown[]) => {
          updates.push(args);
        },
      };

      await syncPullRequestStatuses(options);
      store.updateTaskStatus("service-a:ENG-42", "Todo");
      await syncPullRequestStatuses(options);

      assert.deepEqual(updates, [["ENG-42", "Canceled", { apiKey: "lin_test", teamId: "team-a" }]]);
      assert.equal(store.countEvents("service-a:ENG-42", "pull_request_status_synced"), 1);
    });
  });

  it("ignores open and merged pull requests", async () => {
    await withStore(async (store) => {
      const config = setup(store, { closed: "Canceled" });
      addTask(store, "ENG-43", "https://github.com/acme/example/pull/43");
      const states = new Map([
        [pullRequestUrl, "OPEN"],
        ["https://github.com/acme/example/pull/43", "MERGED"],
      ]);

      await syncPullRequestStatuses({
        config,
        store,
        fetchLinearIssue: async (identifier) =>
          linearIssue(
            identifier === "ENG-42" ? pullRequestUrl : "https://github.com/acme/example/pull/43",
          ),
        findPullRequestByUrl: async (url) => pullRequest(states.get(url) ?? "CLOSED", url),
        updateLinearStatus: async () => assert.fail("must not update Linear"),
      });
    });
  });

  it("retries failures without blocking other tasks", async (context) => {
    await withStore(async (store) => {
      context.mock.method(console, "error", () => undefined);
      const config = setup(store, { closed: "Canceled" });
      addTask(store, "ENG-43", "https://github.com/acme/example/pull/43");
      const attempts = new Map<string, number>();
      let failFirstTask = true;
      const options = {
        config,
        store,
        fetchLinearIssue: async (identifier: string | undefined) =>
          linearIssue(
            identifier === "ENG-42" ? pullRequestUrl : "https://github.com/acme/example/pull/43",
          ),
        findPullRequestByUrl: async (url: string) => pullRequest("CLOSED", url),
        updateLinearStatus: async (identifier: string) => {
          attempts.set(identifier, (attempts.get(identifier) ?? 0) + 1);
          if (identifier === "ENG-42" && failFirstTask) throw new Error("Linear unavailable");
        },
      };

      await syncPullRequestStatuses(options);
      failFirstTask = false;
      await syncPullRequestStatuses(options);

      assert.deepEqual(Object.fromEntries(attempts), { "ENG-42": 2, "ENG-43": 1 });
      assert.equal(store.countEvents("service-a:ENG-42", "pull_request_status_synced"), 1);
      assert.equal(store.countEvents("service-a:ENG-43", "pull_request_status_synced"), 1);
    });
  });

  it("does not apply a stale pull request after its Linear attachment changes", async () => {
    for (const currentUrl of [undefined, "https://github.com/acme/example/pull/99"]) {
      await withStore(async (store) => {
        const config = setup(store, { closed: "Canceled" });
        let lookups = 0;

        await syncPullRequestStatuses({
          config,
          store,
          fetchLinearIssue: async () => linearIssue(currentUrl),
          findPullRequestByUrl: async () => {
            lookups += 1;
            return pullRequest("CLOSED");
          },
          updateLinearStatus: async () => assert.fail("must not update Linear"),
        });

        assert.equal(lookups, 0);
        assert.equal(store.countEvents("service-a:ENG-42", "pull_request_status_synced"), 0);
      });
    }
  });

  it("preserves an issue that is already terminal in Linear", async () => {
    await withStore(async (store) => {
      const config = setup(store, { closed: "Canceled" });
      let lookups = 0;

      await syncPullRequestStatuses({
        config,
        store,
        fetchLinearIssue: async () => linearIssue(pullRequestUrl, "Done", "completed"),
        findPullRequestByUrl: async () => {
          lookups += 1;
          return pullRequest("CLOSED");
        },
        updateLinearStatus: async () => assert.fail("must not update Linear"),
      });

      assert.equal(lookups, 0);
    });
  });

  it("matches equivalent GitHub pull request URL variants", async () => {
    await withStore(async (store) => {
      const config = setup(store, { closed: "Canceled" });
      let updates = 0;

      await syncPullRequestStatuses({
        config,
        store,
        fetchLinearIssue: async () =>
          linearIssue("https://GitHub.com/ACME/EXAMPLE/pull/00042/?diff=split#review"),
        findPullRequestByUrl: async () => pullRequest("CLOSED"),
        updateLinearStatus: async () => {
          updates += 1;
        },
      });

      assert.equal(updates, 1);
    });
  });

  it("runs only during periodic maintenance", async () => {
    await withStore(async (store) => {
      const snapshot = {
        running: [{ issue_identifier: "ENG-42", state: "In Review" }],
        retrying: [],
        blocked: [],
      };
      const config = setup(store, { closed: "Canceled" }, dataUrl(snapshot));
      store.replaceSnapshots({ "service-a": snapshot });
      let updates = 0;
      const options = {
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
        fetchLinearIssue: async () => linearIssue(pullRequestUrl),
        findPullRequestByUrl: async () => pullRequest("CLOSED"),
        updateLinearStatus: async () => {
          updates += 1;
        },
      };

      await runOnce({ ...options, runPeriodicMaintenance: false });
      await runOnce(options);

      assert.equal(updates, 1);
    });
  });
});

function setup(
  store: WatcherStore,
  pullRequestStatusSync?: { closed: string },
  url = dataUrl({ running: [], retrying: [], blocked: [] }),
) {
  const services = [{ name: "service-a", url, linearTeam: "workspace-a-eng" }];
  const teams = linearTeams(["Todo", "In Review", "Canceled"]);
  const config = runtimeConfig({ services, linearTeams: teams, pullRequestStatusSync });
  store.syncDefinitions(services, teams);
  addTask(store, "ENG-42", pullRequestUrl);
  return config;
}

function addTask(store: WatcherStore, identifier: string, url: string): void {
  store.upsertTaskFromEvent({
    type: "updated",
    service: "service-a",
    issueIdentifier: identifier,
    issueTitle: `Task ${identifier}`,
    state: "In Review",
    resolvedState: "In Review",
    pullRequest: { url },
  });
}

function pullRequest(state: string, url = pullRequestUrl): PullRequest {
  return { url, state, headRefOid: "abc123" };
}

function linearIssue(url?: string, state = "In Review", stateType = "started") {
  return {
    identifier: "ENG-42",
    title: "Task ENG-42",
    state,
    stateType,
    url: "https://linear.app/acme/issue/ENG-42",
    ...(url ? { pullRequest: { url } } : {}),
  };
}
