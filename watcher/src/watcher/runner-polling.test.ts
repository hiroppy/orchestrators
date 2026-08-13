import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runOnce, runWatcherPollingLoop } from "./runner.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher polling", () => {
  it("continues polling after a transient poll failure", async () => {
    const attempts: number[] = [];
    const errors: unknown[] = [];
    const delays: number[] = [];

    await runWatcherPollingLoop(
      async () => {
        attempts.push(attempts.length + 1);
        if (attempts.length === 1) throw new Error("temporary Slack failure");
      },
      1_000,
      {
        failureRetryIntervalMs: 30_000,
        shouldContinue: () => attempts.length < 2,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        reportError: (error) => errors.push(error),
      },
    );

    assert.deepEqual(attempts, [1, 2]);
    assert.deepEqual(delays, [30_000]);
    assert.match(String(errors[0]), /temporary Slack failure/);
  });

  it("stops after repeated poll failures", async () => {
    let attempts = 0;
    const errors: unknown[] = [];

    await assert.rejects(
      runWatcherPollingLoop(
        async () => {
          attempts += 1;
          throw new Error("persistent database failure");
        },
        1_000,
        {
          sleep: async () => {},
          reportError: (error) => errors.push(error),
        },
      ),
      /persistent database failure/,
    );

    assert.equal(attempts, 3);
    assert.equal(errors.length, 3);
  });

  it("uses the Linear team referenced by the service", async (context) => {
    await withStore(async (store) => {
      const current = {
        running: [{ issue_identifier: "ALT-77", state: "Building" }],
        retrying: [],
        blocked: [],
      };
      const authorizationHeaders: string[] = [];
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        authorizationHeaders.push(String(options?.headers?.authorization));
        return Response.json({
          data: {
            issue: {
              identifier: "ALT-77",
              title: "Use another Linear account",
              creator: { name: "Private Creator", email: "private@example.com" },
              state: { name: "Building", type: "started" },
              url: "https://linear.app/other/issue/ALT-77/example",
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-b",
            url: dataUrl(current),
            linearTeam: "workspace-b-eng",
          },
        ],
        linearTeams: {
          "workspace-b-eng": {
            apiKey: "lin_other",
            teamId: "team-b",
            statuses: ["Triage", "Building", "Shipped"],
          },
        },
        notifications: {
          statuses: [],
          events: ["started"],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const slackCalls: Array<Record<string, unknown>> = [];

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(slackCalls),
        slackChannelId: "C123",
      });

      assert.deepEqual(authorizationHeaders, ["lin_other"]);
      assert.equal(
        slackCalls.some(({ method }) => method === "lookupByEmail"),
        true,
      );
      assert.deepEqual(store.getSnapshots()["service-b"], current);
    });
  });

  it("persists poll snapshots in SQLite", async () => {
    await withStore(async (store) => {
      const current = {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [],
        blocked: [],
      };
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(current),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["Todo", "In Progress", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);

      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);
      await runOnce({
        config,
        store,
        slackClient,
        slackChannelId: "C123",
      });

      assert.equal(store.getSnapshots()["service-a"]?.running[0]?.issue_identifier, "ENG-62");
      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
      assert.equal(calls.filter(({ method }) => method === "update").length, 0);

      await runOnce({
        config,
        store,
        slackClient,
        slackChannelId: "C123",
      });
      assert.equal(calls.filter(({ method }) => method === "postMessage").length, 1);
    });
  });

  it("fetches task metadata and creator in one Linear request", async (context) => {
    await withStore(async (store) => {
      const current = {
        running: [{ issue_identifier: "ENG-62", state: "Blocked" }],
        retrying: [],
        blocked: [],
      };
      let linearRequests = 0;
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        linearRequests += 1;
        if (linearRequests === 2) {
          return Response.json({
            errors: [{ message: "rate limited", extensions: { code: "RATELIMITED" } }],
          });
        }
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Notify the creator",
              state: { name: "Blocked", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [{ name: "service-a", url: dataUrl(current), linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "Blocked", "Done"]),
        notifications: { statuses: [], events: ["started"] },
      });
      store.syncDefinitions(config.services, config.linearTeams);

      const warnings: string[] = [];
      context.mock.method(console, "warn", (message) => warnings.push(String(message)));
      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
      });
      assert.deepEqual(warnings, []);
      assert.equal(linearRequests, 1);
      assert.deepEqual(store.getSnapshots()["service-a"], current);
    });
  });

  it("commits permanent creator misses and still sends default assignees", async (context) => {
    await withStore(async (store) => {
      const current = {
        running: [{ issue_identifier: "ENG-62", state: "Blocked" }],
        retrying: [],
        blocked: [],
      };
      let linearRequests = 0;
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        linearRequests += 1;
        if (linearRequests === 2) return new Response("not found", { status: 404 });
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Notify reviewers",
              state: { name: "Blocked", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [{ name: "service-a", url: dataUrl(current), linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "Blocked", "Done"]),
        defaultAssignees: ["<@UREVIEWERS>"],
        notifications: {
          statuses: [],
          events: ["started"],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const calls: Array<Record<string, unknown>> = [];

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.deepEqual(store.getSnapshots()["service-a"], current);
      assert.match(JSON.stringify(calls), /Assignees: <@UREVIEWERS>/);
    });
  });

  it("continues publishing other events when one Linear lookup fails", async (context) => {
    await withStore(async (store) => {
      const current = {
        running: [
          { issue_identifier: "ENG-61", state: "Blocked" },
          { issue_identifier: "ENG-62", state: "Blocked" },
        ],
        retrying: [],
        blocked: [],
      };
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const body = JSON.parse(String(options?.body)) as {
          variables: { id: string; includeCreator: boolean };
        };
        if (body.variables.id === "ENG-62" && body.variables.includeCreator) {
          return new Response("temporary failure", { status: 500 });
        }
        return Response.json({
          data: {
            issue: {
              identifier: body.variables.id,
              title: `Notify ${body.variables.id}`,
              creator: { name: "Creator", email: `${body.variables.id}@example.com` },
              state: { name: "Blocked", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [{ name: "service-a", url: dataUrl(current), linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "Blocked", "Done"]),
        notifications: { statuses: [], events: ["started"] },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const calls: Array<Record<string, unknown>> = [];
      context.mock.method(console, "warn", () => {});

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(
        calls.some(({ method }) => method === "postMessage"),
        true,
      );
      assert.deepEqual(store.getSnapshots()["service-a"], current);
    });
  });
});
