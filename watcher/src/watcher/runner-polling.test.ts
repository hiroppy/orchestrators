import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runOnce, runPoll } from "./runner.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher polling", () => {
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
        mention: {
          targets: [],
          statuses: [],
          events: ["started"],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const output: string[] = [];
      const slackCalls: Array<Record<string, unknown>> = [];
      context.mock.method(console, "log", (line) => output.push(String(line)));

      await runOnce({
        config,
        store,
        dryRun: true,
        slackClient: fakeSlackClient(slackCalls),
      });

      assert.deepEqual(authorizationHeaders, ["lin_other", "lin_other"]);
      assert.match(output[0], /Use another Linear account/);
      assert.match(output[0], /Private Creator/);
      assert.doesNotMatch(output[0], /private@example\.com/);
      assert.equal(
        slackCalls.some(({ method }) => method === "lookupByEmail"),
        false,
      );
      assert.deepEqual(store.getSnapshots()["service-b"], {
        running: [],
        retrying: [],
        blocked: [],
      });
    });
  });

  it("persists poll snapshots in SQLite only after a non-dry run", async () => {
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

  it("includes task notification assignments in dry-run output", async (context) => {
    await withStore(async (store) => {
      const current = {
        running: [{ issue_identifier: "ENG-62", state: "Blocked" }],
        retrying: [],
        blocked: [],
      };
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Investigate the blocker",
              state: { name: "Blocked", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [{ name: "service-a", url: dataUrl(current), linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "Blocked"]),
        mention: { targets: [], statuses: ["Blocked"], events: [] },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      store.assignTaskNotificationMention("service-a:ENG-62", "U123");
      const output: string[] = [];
      context.mock.method(console, "log", (line) => output.push(String(line)));

      await runOnce({ config, store, dryRun: true });

      assert.match(output.join("\n"), /<@U123>/);
    });
  });

  it("retries creator-only notifications when Linear creator enrichment fails", async (context) => {
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
        mention: { targets: [], statuses: [], events: ["started"] },
      });
      store.syncDefinitions(config.services, config.linearTeams);

      const warnings: string[] = [];
      context.mock.method(console, "warn", (message) => warnings.push(String(message)));
      await runPoll({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
      });
      assert.deepEqual(warnings, ["Could not fetch Linear creator for notification: ENG-62"]);
      assert.deepEqual(store.getSnapshots()["service-a"], {
        running: [],
        retrying: [],
        blocked: [],
      });
    });
  });

  it("commits permanent creator misses and still sends static mentions", async (context) => {
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
        mention: {
          targets: ["<!subteam^SREVIEWERS>"],
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
      assert.match(JSON.stringify(calls), /Mentions: <!subteam\^SREVIEWERS>/);
    });
  });

  it("preflights creator enrichment before publishing any event", async (context) => {
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
        mention: { targets: [], statuses: [], events: ["started"] },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const calls: Array<Record<string, unknown>> = [];
      context.mock.method(console, "warn", () => {});

      await runPoll({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(
        calls.some(({ method }) => method === "postMessage"),
        false,
      );
      assert.deepEqual(store.getSnapshots()["service-a"], {
        running: [],
        retrying: [],
        blocked: [],
      });
    });
  });
});
