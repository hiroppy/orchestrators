import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveWatcherConfig } from "../config/runtime.ts";
import type { ReviewReactionConfig } from "../domain/types.ts";
import { createDatabase } from "../persistence/database.ts";
import { WatcherStore } from "../persistence/store.ts";
import { collectSnapshots, resolveLinearWorkflowStatuses, runOnce } from "./runner.ts";

describe("runOnce", () => {
  it("uses the service's explicit Linear team ID", () => {
    const config = resolveWatcherConfig(
      {
        linearTeams: {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
          },
        },
        instances: {
          "service-a": {
            port: 4101,
            linearTeam: "workspace-a-eng",
          },
        },
      },
      { requireSlack: false },
    );

    assert.equal(config.linearTeams[config.services[0].linearTeam].teamId, "team-a");
    assert.equal(config.services[0].url, "http://127.0.0.1:4101/api/v1/state");
  });

  it("uses the centrally resolved Slack config", () => {
    assert.deepEqual(
      resolveWatcherConfig(
        {
          ...baseConfig(),
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            channelId: "C123",
          },
        },
        { requireSlack: true },
      ).slack,
      {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        channelId: "C123",
      },
    );
  });

  it("does not assume a workflow-specific mention status and validates configured events", () => {
    const config = resolveWatcherConfig(
      {
        ...baseConfig(),
        slack: {
          mention: { target: " <!subteam^S123> " },
        },
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.mention, {
      target: "<!subteam^S123>",
      statuses: [],
      events: [],
    });
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            slack: {
              mention: {
                target: "<!subteam^S123>",
                events: ["unknown"],
              },
            },
          } as never,
          { requireSlack: false },
        ),
      /unknown events/,
    );
  });

  it("loads workflow statuses from Linear and validates status-based rules", async () => {
    const unresolved = resolveWatcherConfig(
      {
        linearTeams: {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-id",
          },
        },
        instances: {
          "service-a": {
            port: 4101,
            linearTeam: "workspace-a-eng",
          },
        },
        slack: {
          mention: {
            target: "<!subteam^S123>",
            statuses: ["In Review"],
          },
        },
      },
      { requireSlack: false },
    );
    const calls = [];
    const resolved = await resolveLinearWorkflowStatuses(unresolved, async (teamId, options) => {
      calls.push({ teamId, options });
      return ["Todo", "In Progress", "In Review", "Done"];
    });

    assert.deepEqual(calls, [{ teamId: "team-id", options: { apiKey: "lin_test" } }]);
    assert.deepEqual(resolved.linearTeams["workspace-a-eng"].statuses, [
      "Todo",
      "In Progress",
      "In Review",
      "Done",
    ]);

    await assert.rejects(
      resolveLinearWorkflowStatuses(unresolved, async () => ["Todo", "In Progress", "Done"]),
      /slack\.mention\.statuses references unknown Linear status "In Review"/,
    );
    await assert.rejects(
      resolveLinearWorkflowStatuses(unresolved, async () =>
        Array.from({ length: 101 }, (_, index) => `Status ${index}`),
      ),
      /cannot contain more than 100 statuses/,
    );
  });

  it("requires valid review reaction settings", () => {
    const config = resolveWatcherConfig(
      {
        ...baseConfig(),
        watcher: {
          reviewReaction: {
            inReviewStatus: "In Review",
            inProgressStatus: "In Progress",
            reaction: " 👀 ",
            maxRequeues: 3,
          },
        },
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.reviewReaction, {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
      reaction: "👀",
      maxRequeues: 3,
    });

    for (const reviewReaction of [
      {
        inReviewStatus: "",
        inProgressStatus: "In Progress",
        reaction: "👀",
        maxRequeues: 3,
      },
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        maxRequeues: 3,
      } as unknown as ReviewReactionConfig,
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        reaction: "",
        maxRequeues: 3,
      },
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        reaction: "👀",
        maxRequeues: 0,
      },
    ]) {
      assert.throws(
        () =>
          resolveWatcherConfig(
            {
              ...baseConfig(),
              watcher: { reviewReaction },
            },
            { requireSlack: false },
          ),
        /watcher\.reviewReaction/,
      );
    }
  });

  it("rejects duplicate ports and non-boolean enabled values", () => {
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            linearTeams: linearTeams(),
            instances: {
              "service-a": { port: 4101, linearTeam: "workspace-a-eng" },
              "service-b": { port: 4101, linearTeam: "workspace-a-eng" },
            },
          },
          { requireSlack: false },
        ),
      /duplicate ports/,
    );

    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            linearTeams: linearTeams(),
            instances: {
              "service-a": {
                port: 4101,
                linearTeam: "workspace-a-eng",
                enabled: "false",
              },
            },
          } as never,
          { requireSlack: false },
        ),
      /enabled must be a boolean/,
    );
  });

  it("validates port, polling, and retry boundaries", () => {
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            instances: {
              "service-a": { port: 0, linearTeam: "workspace-a-eng" },
            },
          },
          { requireSlack: false },
        ),
      /port must be an integer from 1 to 65535/,
    );

    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            watcher: { pollIntervalMs: 4_999 },
          },
          { requireSlack: false },
        ),
      /pollIntervalMs must be at least 5000/,
    );

    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            watcher: {
              endedTaskRetry: { maxAttempts: 0 },
            },
          },
          { requireSlack: false },
        ),
      /maxAttempts must be a positive integer/,
    );

    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            watcher: {
              endedTaskRetry: { delayMs: -1 },
            },
          },
          { requireSlack: false },
        ),
      /delayMs must be zero or greater/,
    );

    const config = resolveWatcherConfig(
      {
        ...baseConfig(),
        watcher: {
          pollIntervalMs: 5_000,
          endedTaskRetry: { maxAttempts: 1, delayMs: 0 },
        },
        instances: {
          "service-a": { port: 65_535, linearTeam: "workspace-a-eng" },
        },
      },
      { requireSlack: false },
    );
    assert.equal(config.services[0].url, "http://127.0.0.1:65535/api/v1/state");
  });

  it("rejects instances that reference an unknown Linear team", () => {
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            linearTeams: linearTeams(),
            instances: {
              "service-a": {
                port: 4101,
                linearTeam: "missing-team",
              },
            },
          },
          { requireSlack: false },
        ),
      /must reference a configured Linear team/,
    );
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
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const output: string[] = [];
      context.mock.method(console, "log", (line) => output.push(String(line)));

      await runOnce({ config, store, dryRun: true });

      assert.deepEqual(authorizationHeaders, ["lin_other"]);
      assert.match(output[0], /Use another Linear account/);
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

  it("resets the requeue count after reaching the limit", async (context) => {
    await withStore(async (store) => {
      let linearState = "In Review";
      let failLinearFetchOnce = false;
      let hasReviewReaction = true;
      let failWorkspacePullRequestLookupOnce = false;
      let failReactionLookupOnce = false;
      let omitLinearPullRequestOnce = false;
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        if (failLinearFetchOnce) {
          failLinearFetchOnce = false;
          return new Response("temporary failure", { status: 500 });
        }
        const attachments = omitLinearPullRequestOnce
          ? { nodes: [] }
          : { nodes: [{ url: "https://github.com/acme/example/pull/42" }] };
        omitLinearPullRequestOnce = false;
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Review the pull request",
              state: { name: linearState, type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments,
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: "",
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Blocked", "Done"]),
        reviewReaction: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
          reaction: "👀",
          maxRequeues: 3,
        },
        mention: {
          target: "<@U123>",
          statuses: ["In Review", "Blocked"],
          events: [],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Progress",
      });
      for (let count = 0; count < 3; count += 1) {
        store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });
      }
      const calls: Array<Record<string, unknown>> = [];
      const deliveryErrors: string[] = [];
      context.mock.method(console, "error", (...args) => deliveryErrors.push(args.join(" ")));
      const statusUpdates: string[] = [];
      let rejectLimitNotification = true;
      let rejectLimitCardUpdate = false;
      let rejectedClientMessageId: unknown;
      const slackClient = fakeSlackClient(calls, {
        rejectPostMessage: (args) => {
          if (
            rejectLimitNotification &&
            String(args.text).includes("review requeue limit reached")
          ) {
            rejectLimitNotification = false;
            rejectLimitCardUpdate = true;
            rejectedClientMessageId = args.client_msg_id;
            return true;
          }
          return false;
        },
        rejectUpdate: (args) => {
          if (rejectLimitCardUpdate && JSON.stringify(args.blocks).includes("In Progress")) {
            rejectLimitCardUpdate = false;
            return true;
          }
          return false;
        },
      });
      const run = async (snapshotStatus: string) => {
        config.services[0].url = dataUrl({
          running: [
            {
              issue_identifier: "ENG-62",
              state: snapshotStatus,
              workspace_path: "/tmp/example",
            },
          ],
          retrying: [],
          blocked: [],
        });
        await runOnce({
          config,
          store,
          slackClient,
          slackChannelId: "C123",
          findPullRequest: async (_event, options) => {
            if (failWorkspacePullRequestLookupOnce) {
              failWorkspacePullRequestLookupOnce = false;
              return null;
            }
            return {
              url: "https://github.com/acme/example/pull/42",
              number: 42,
              hasConfiguredReaction: hasReviewReaction && options.reaction === "👀",
            };
          },
          findPullRequestByUrl: async (url, options) => {
            if (failReactionLookupOnce) {
              failReactionLookupOnce = false;
              return null;
            }
            return {
              url,
              number: 42,
              hasConfiguredReaction: hasReviewReaction && options.reaction === "👀",
            };
          },
          updateLinearStatus: async (_issue, status) => {
            statusUpdates.push(status);
            linearState = status;
          },
        });
      };

      await run("In Review");
      assert.deepEqual(statusUpdates, ["In Progress"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
      assert.equal(
        calls.filter(({ text }) => String(text).includes("👀 review reaction detected")).length,
        1,
      );
      assert.doesNotMatch(JSON.stringify(calls), /<@U123>/);

      await run("In Progress");
      linearState = "In Review";
      await run("In Review");
      assert.deepEqual(statusUpdates, ["In Progress", "In Progress"]);
      assert.equal(
        calls.filter(({ text }) => String(text).includes("👀 review reaction detected")).length,
        2,
      );
      assert.doesNotMatch(JSON.stringify(calls), /review requeue limit reached/);
      assert.doesNotMatch(JSON.stringify(calls), /<@U123>/);

      await run("In Progress");
      linearState = "In Review";
      // Phase 1: Slack rejects the limit notification, but the poll continues.
      await run("In Review");
      assert.match(deliveryErrors.join("\n"), /Simulated Slack failure/);
      assert.deepEqual(statusUpdates, ["In Progress", "In Progress", "In Progress"]);
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_limit_pending",
          "review_requeue_limit_reached",
        ),
        1,
      );

      config.reviewReaction.maxRequeues = 5;
      linearState = "Blocked";
      hasReviewReaction = false;
      store.setTaskLinearStateType("service-a:ENG-62", "completed");
      // Phase 2: an unrelated Blocked alert survives while the card update remains pending.
      await run("Blocked");
      assert.match(deliveryErrors.join("\n"), /Simulated Slack card failure/);
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_limit_pending",
          "review_requeue_limit_reached",
        ),
        1,
      );
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_limit_notified",
          "review_requeue_limit_reached",
        ),
        1,
      );
      assert.equal(
        calls.filter(({ text }) => String(text).includes("review requeue limit reached (3/3)"))
          .length,
        1,
      );
      assert.equal(
        calls.find(({ text }) => String(text).includes("review requeue limit reached (3/3)"))
          ?.client_msg_id,
        rejectedClientMessageId,
      );
      assert.match(JSON.stringify(calls), /<@U123>/);
      const blockedMentionCallCount = calls.filter((call) =>
        JSON.stringify(call).includes("<@U123>"),
      ).length;

      hasReviewReaction = true;
      linearState = "In Review";
      failLinearFetchOnce = true;
      // Phase 3: card recovery succeeds, but failed enrichment on a snapshot diff stays pending.
      await run("In Progress");
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_limit_pending",
          "review_requeue_limit_reached",
        ),
        0,
      );
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_reconcile_pending",
          "review_requeue_reconciled",
        ),
        1,
      );
      assert.equal(statusUpdates.length, 3);
      assert.equal(
        calls.filter((call) => JSON.stringify(call).includes("<@U123>")).length,
        blockedMentionCallCount,
      );

      omitLinearPullRequestOnce = true;
      failWorkspacePullRequestLookupOnce = true;
      // Phase 4: unresolved PR enrichment on a snapshot diff keeps reconciliation pending.
      await run("In Review");
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_reconcile_pending",
          "review_requeue_reconciled",
        ),
        1,
      );

      store.setTaskLinearStateType("service-a:ENG-62", "completed");
      failReactionLookupOnce = true;
      omitLinearPullRequestOnce = true;
      // Phase 5: a terminal task reuses its stored PR, but failed reaction lookup stays pending.
      await run("In Review");
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_reconcile_pending",
          "review_requeue_reconciled",
        ),
        1,
      );
      assert.equal(statusUpdates.length, 3);
      assert.equal(
        calls.filter((call) => JSON.stringify(call).includes("<@U123>")).length,
        blockedMentionCallCount,
      );

      hasReviewReaction = false;
      store.updateTaskStatus("service-a:ENG-62", "In Review");
      // Phase 6: authoritative absence of the reaction sends the deferred human mention.
      await run("In Review");
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeue_reconcile_pending",
          "review_requeue_reconciled",
        ),
        0,
      );
      assert.equal(statusUpdates.length, 3);
      assert.ok(
        calls.filter((call) => JSON.stringify(call).includes("<@U123>")).length >
          blockedMentionCallCount,
      );
      const mentionCallCount = calls.filter((call) =>
        JSON.stringify(call).includes("<@U123>"),
      ).length;

      hasReviewReaction = true;
      linearState = "In Progress";
      await run("In Progress");
      linearState = "In Review";
      // Phase 7: the next reacted In Review cycle starts from zero and requeues.
      await run("In Review");
      assert.match(JSON.stringify(calls), /review requeue limit reached \(3\/3\)/);
      assert.doesNotMatch(JSON.stringify(calls), /review requeue limit reached \(5\/5\)/);
      assert.equal(
        calls.filter((call) => JSON.stringify(call).includes("<@U123>")).length,
        mentionCallCount,
      );
      assert.match(
        JSON.stringify([...calls].reverse().find(({ method }) => method === "update")),
        /PR#42/,
      );
      assert.deepEqual(statusUpdates, ["In Progress", "In Progress", "In Progress", "In Progress"]);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
      assert.equal(
        store.countEventsAfterLatest(
          "service-a:ENG-62",
          "review_requeued",
          "review_requeue_limit_reached",
        ),
        1,
      );
      await run("In Progress");
      for (let count = 0; count < 3; count += 1) {
        store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });
      }
      config.reviewReaction.maxRequeues = 3;
      linearState = "In Review";
      // Phase 8: lowering the limit normalizes an over-limit current cycle.
      await run("In Review");
      assert.equal(statusUpdates.length, 5);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Progress");
    });
  });

  it("mentions on In Review when the configured reaction count is zero", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Ready for human review",
              state: { name: "In Review", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({
              running: [
                {
                  issue_identifier: "ENG-62",
                  state: "In Review",
                  workspace_path: "/tmp/example",
                },
              ],
              retrying: [],
              blocked: [],
            }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewReaction: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
          reaction: "👀",
          maxRequeues: 2,
        },
        mention: {
          target: "<@U123>",
          statuses: ["In Review"],
          events: [],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const calls: Array<Record<string, unknown>> = [];
      let updated = false;

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        findPullRequest: async () => ({
          url: "https://github.com/acme/example/pull/42",
          hasConfiguredReaction: false,
        }),
        updateLinearStatus: async () => {
          updated = true;
        },
      });

      assert.equal(updated, false);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.match(JSON.stringify(calls), /<@U123>/);
    });
  });

  it("reconciles nonterminal tasks after they disappear from Symphony", async (context) => {
    await withStore(async (store) => {
      const emptySnapshot = { running: [], retrying: [], blocked: [] };
      const nativeFetch = globalThis.fetch;
      let linearFetches = 0;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        linearFetches += 1;
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "Done", type: "completed" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: {
                nodes: [{ url: "https://github.com/acme/example/pull/42" }],
              },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(emptySnapshot),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
        mention: {
          target: "<@U123>",
          statuses: ["In Review"],
          events: [],
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        state: "In Review",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");

      const calls: Array<Record<string, unknown>> = [];
      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *Done*\nhttps://example.slack.com/archives/C123/p1000",
      );
      assert.match(
        String(calls.find(({ method, thread_ts }) => method === "postMessage" && thread_ts)?.text),
        /^\*In Review\* → \*Done\*\nEvent: Updated \| UpdatedAt: <!date[^\n]+>\n<https:\/\/github\.com\/acme\/example\/pull\/42\|PR#42>$/,
      );

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });
      assert.equal(linearFetches, 1);
    });
  });

  it("preserves active tasks through an outage and reports recovery without false transitions", async (context) => {
    await withStore(async (store) => {
      const activeSnapshot = {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [],
        blocked: [],
      };
      let unavailable = true;
      context.mock.method(globalThis, "fetch", async (url) => {
        assert.equal(String(url), "http://127.0.0.1:1/state");
        if (unavailable) throw new TypeError("fetch failed");
        return Response.json(activeSnapshot);
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: "http://127.0.0.1:1/state",
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["Backlog", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": activeSnapshot });
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);

      const outage = await runOnce({
        config,
        store,
        slackClient,
        slackChannelId: "C123",
      });

      assert.deepEqual(
        outage.events.map(({ type, issueIdentifier }) => [type, issueIdentifier]),
        [["retrying", "watcher:service-a"]],
      );
      assert.equal(store.getSnapshots()["service-a"]?.running[0]?.issue_identifier, "ENG-62");

      unavailable = false;
      const recovery = await runOnce({
        config,
        store,
        slackClient,
        slackChannelId: "C123",
      });

      assert.deepEqual(
        recovery.events.map(({ type, issueIdentifier }) => [type, issueIdentifier]),
        [["recovered", "watcher:service-a"]],
      );
      assert.equal(store.getTask("service-a:watcher:service-a")?.status, "available");
      assert.deepEqual(store.getSnapshots()["service-a"], activeSnapshot);
    });
  });

  it("times out an observability endpoint without blocking collection", async () => {
    const result = await collectSnapshots(
      [{ name: "service-a", url: "https://service.test/state" }],
      {},
      {
        timeoutMs: 5,
        fetch: async (_url, options) =>
          await new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          }),
      },
    );

    assert.match(result["service-a"]!.retrying[0].error!, /timed out|aborted/i);
  });

  it("preserves the previous snapshot when the endpoint returns malformed JSON", async () => {
    const previous = {
      "service-a": {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [],
        blocked: [],
      },
    };
    const result = await collectSnapshots(
      [{ name: "service-a", url: "https://service.test/state" }],
      previous,
      {
        fetch: async () => Response.json({ status: "starting" }),
      },
    );

    assert.deepEqual(result["service-a"]?.running, previous["service-a"].running);
    assert.match(result["service-a"]!.retrying[0].error!, /Invalid observability snapshot/);
  });
});

function dataUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

function linearTeams(statuses = ["Todo", "Done"]) {
  return {
    "workspace-a-eng": {
      apiKey: "lin_test",
      teamId: "team-a",
      statuses,
    },
  };
}

function baseConfig() {
  return {
    linearTeams: linearTeams(),
    instances: {
      "service-a": {
        port: 4101,
        linearTeam: "workspace-a-eng",
      },
    },
  };
}

function runtimeConfig<T extends object>(config: T) {
  return {
    pollIntervalMs: 30_000,
    endedTaskRetry: {
      maxAttempts: 2,
      delayMs: 5_000,
    },
    ...config,
  };
}

function fakeSlackClient(
  calls: Array<Record<string, unknown>>,
  options: {
    rejectPostMessage?: (args: Record<string, unknown>) => boolean;
    rejectUpdate?: (args: Record<string, unknown>) => boolean;
  } = {},
) {
  let timestamp = 0;
  return {
    chat: {
      async getPermalink(args: Record<string, unknown>) {
        calls.push({ method: "getPermalink", ...args });
        return {
          ok: true,
          channel: String(args.channel),
          permalink: `https://example.slack.com/archives/${args.channel}/p${String(
            args.message_ts,
          ).replace(".", "")}`,
        };
      },
      async postMessage(args: Record<string, unknown>) {
        if (options.rejectPostMessage?.(args)) throw new Error("Simulated Slack failure");
        timestamp += 1;
        calls.push({ method: "postMessage", ...args });
        return { ok: true, channel: String(args.channel), ts: `${timestamp}.000` };
      },
      async update(args: Record<string, unknown>) {
        if (options.rejectUpdate?.(args)) throw new Error("Simulated Slack card failure");
        calls.push({ method: "update", ...args });
        return { ok: true, channel: String(args.channel), ts: String(args.ts) };
      },
    },
  } as never;
}

async function withStore(run: (store: WatcherStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "watcher-run-"));
  const database = createDatabase(join(directory, "watcher.db"));

  try {
    await run(new WatcherStore(database.db));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
