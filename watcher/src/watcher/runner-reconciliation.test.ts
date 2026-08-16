import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileSlackStatusTransition, runOnce } from "./runner.ts";
import { checkReviewReadyNotification, REVIEW_READY_DELAY_MS } from "./review-ready.ts";
import { collectSnapshots } from "./snapshots.ts";
import { createPendingStatusHookEvent } from "./status-hooks.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher reconciliation and snapshots", () => {
  it("restarts the review-ready window after manual status transitions", async (context) => {
    await withStore(async (store) => {
      let linearState = "In Progress";
      context.mock.method(globalThis, "fetch", async () =>
        Response.json({
          data: {
            issue:
              linearState === "In Progress"
                ? null
                : {
                    identifier: "ENG-62",
                    title: "Review the pull request",
                    state: { name: linearState, type: "started" },
                    url: "https://linear.app/example/issue/ENG-62/example",
                    attachments: {
                      nodes: [{ url: "https://github.com/acme/example/pull/42" }],
                    },
                    relations: { nodes: [] },
                  },
          },
        }),
      );
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewComment: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Review the pull request",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      store.assignTask(task.id, "U123");
      const calls: Array<Record<string, unknown>> = [];
      const slackClient = fakeSlackClient(calls);
      const transitionManually = async (status: string) => {
        linearState = status;
        const { task: updatedTask } = store.updateTaskStatusAtomically(
          task.id,
          status,
          () => undefined,
        );
        await reconcileSlackStatusTransition({
          config,
          store,
          slackClient,
          slackChannelId: "C123",
          task: updatedTask,
        });
        return updatedTask;
      };
      const pullRequest = {
        url: "https://github.com/acme/example/pull/42",
        state: "OPEN",
        isDraft: false,
        headRefOid: "abcdef123456",
      };

      await checkReviewReadyNotification({
        store,
        slackClient,
        task,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      await transitionManually("In Progress");
      const backInReview = await transitionManually("In Review");
      const reenteredAt = new Date("2026-08-16T00:00:00.000Z");
      await checkReviewReadyNotification({
        store,
        slackClient,
        task: backInReview,
        inReviewStatus: "In Review",
        pullRequest,
        now: reenteredAt,
      });
      await checkReviewReadyNotification({
        store,
        slackClient,
        task: backInReview,
        inReviewStatus: "In Review",
        pullRequest,
        now: new Date(reenteredAt.getTime() + REVIEW_READY_DELAY_MS - 1),
      });

      assert.equal(
        calls.filter(({ text }) => String(text).startsWith("Ready for review:")).length,
        0,
      );
    });
  });

  it("announces a Symphony terminal override immediately after a Slack status change", async (context) => {
    await withStore(async (store) => {
      context.mock.method(globalThis, "fetch", async () =>
        Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "Ready for Release", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
              relations: {
                nodes: [
                  {
                    type: "blocks",
                    relatedIssue: {
                      identifier: "ENG-63",
                      title: "Already ready for release",
                      state: { name: "Ready for Release", type: "started" },
                    },
                  },
                  {
                    type: "blocks",
                    relatedIssue: {
                      identifier: "ENG-64",
                      title: "Start the follow-up",
                      state: { name: "In Review", type: "started" },
                    },
                  },
                  {
                    type: "blocks",
                    relatedIssue: {
                      identifier: "ENG-65",
                      title: "Still active by policy",
                      state: { name: "In Progress", type: "completed" },
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            activeStates: ["In Progress"],
            terminalStates: ["Done", "Ready for Release"],
          },
        ],
        linearTeams: linearTeams(["In Review", "Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const { task: closedTask } = store.updateTaskStatusAtomically(
        task.id,
        "Ready for Release",
        () => undefined,
      );
      const calls: Array<Record<string, unknown>> = [];

      await reconcileSlackStatusTransition({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        task: closedTask,
      });

      assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *Ready for Release*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
      );
      const relatedMessage = calls.find(
        ({ method, thread_ts }) => method === "postMessage" && thread_ts,
      )?.text;
      assert.match(String(relatedMessage), /ENG-64.*Start the follow-up/);
      assert.match(String(relatedMessage), /ENG-65.*Still active by policy/);
      assert.doesNotMatch(String(relatedMessage), /ENG-63|Already ready for release/);
    });
  });

  it("reclassifies a persisted terminal row before reconciling an active override", async (context) => {
    await withStore(async (store) => {
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
              state: { name: "Ready for Release", type: "started" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
              relations: { nodes: [] },
            },
            issue0: {
              identifier: "ENG-62",
              state: { name: "Ready for Release", type: "started" },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
            activeStates: ["In Review"],
            terminalStates: ["Done", "Ready for Release"],
          },
        ],
        linearTeams: linearTeams(["In Review", "Ready for Release", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Review",
        resolvedStateType: "completed",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const calls: Array<Record<string, unknown>> = [];
      const reconcile = () =>
        runOnce({
          config,
          store,
          slackClient: fakeSlackClient(calls),
          slackChannelId: "C123",
        });

      await reconcile();

      assert.equal(store.getTask(task.id)?.status, "Ready for Release");
      assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
      assert.equal(linearFetches, 2);

      await reconcile();

      assert.equal(linearFetches, 2);
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
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
      let hookAttempts = 0;
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(emptySnapshot),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
        statusHooks: [
          {
            id: "capture-attempt",
            status: "In Review",
            run: () => {
              hookAttempts += 1;
            },
          },
        ],
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
      const pendingHook = createPendingStatusHookEvent(
        config.statusHooks,
        task,
        "In Progress",
        "In Review",
      );
      assert.ok(pendingHook);
      store.addEvent(pendingHook);

      const calls: Array<Record<string, unknown>> = [];
      let pullRequestLookups = 0;
      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        runPeriodicMaintenance: false,
      });

      assert.equal(linearFetches, 0);
      assert.equal(hookAttempts, 0);
      assert.equal(store.getTask(task.id)?.status, "In Review");

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        findPullRequestByUrl: async (url) => {
          pullRequestLookups += 1;
          return {
            url,
            number: 42,
            title: "Ship the reconciled pull request",
          };
        },
      });

      assert.equal(hookAttempts, 1);
      assert.equal(store.getTask(task.id)?.status, "Done");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *Done*\n<https://example.slack.com/archives/C123/p1000|Merge the pull request>",
      );
      assert.match(
        String(calls.find(({ method, thread_ts }) => method === "postMessage" && thread_ts)?.text),
        /^\*In Review\* → \*Done\*\nEvent: Updated$/,
      );
      assert.match(
        JSON.stringify(
          calls.find(
            ({ method, thread_ts, text }) =>
              method === "postMessage" && thread_ts && String(text).includes("→ *Done*"),
          )?.blocks,
        ),
        /Ship the reconciled pull request/,
      );

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
        findPullRequestByUrl: async () => {
          pullRequestLookups += 1;
          throw new Error("A no-op reconciliation must not fetch PR metadata");
        },
      });
      assert.equal(linearFetches, 2);
      assert.equal(pullRequestLookups, 1);
    });
  });

  it("recovers missing Linear state metadata while a task remains in Symphony", async (context) => {
    await withStore(async (store) => {
      const activeSnapshot = {
        running: [{ issue_identifier: "ENG-62", state: "Todo" }],
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
              title: "Canceled task",
              state: { name: "Canceled", type: "canceled" },
              attachments: { nodes: [] },
              relations: { nodes: [] },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl(activeSnapshot),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["Todo", "Canceled"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.replaceSnapshots({ "service-a": activeSnapshot });
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Canceled task",
        resolvedState: "Canceled",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const calls: Array<Record<string, unknown>> = [];

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient(calls),
        slackChannelId: "C123",
      });

      assert.equal(store.getTask(task.id)?.linearStateType, "canceled");
      assert.equal(
        calls.find(({ method, thread_ts }) => method === "postMessage" && !thread_ts)?.text,
        "Task closed | *Canceled*\n<https://example.slack.com/archives/C123/p1000|Canceled task>",
      );
    });
  });

  it("uses detailed state when Linear changes after the batch summary", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        const { query } = JSON.parse(String(options?.body)) as { query: string };
        if (query.includes("OrchestratorWatcherIssueStateBatch")) {
          return Response.json({
            data: {
              issue0: {
                identifier: "ENG-62",
                state: { name: "In Review", type: "started" },
              },
            },
          });
        }
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-62",
              title: "Merge the pull request",
              state: { name: "Done", type: "completed" },
              url: "https://linear.app/example/issue/ENG-62/example",
              attachments: { nodes: [] },
              relations: { nodes: [] },
            },
          },
        });
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Progress", "In Review", "Done"]),
        reviewComment: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        issueTitle: "Merge the pull request",
        resolvedState: "In Review",
        resolvedStateType: "started",
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
      assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      assert.equal(
        calls.filter(({ method, thread_ts }) => method === "postMessage" && !thread_ts).length,
        1,
      );
    });
  });

  for (const batchFailure of ["request failure", "partial response"] as const) {
    it(`falls back to detailed reconciliation after a batch ${batchFailure}`, async (context) => {
      await withStore(async (store) => {
        const nativeFetch = globalThis.fetch;
        let linearFetches = 0;
        context.mock.method(globalThis, "fetch", async (url, options) => {
          if (String(url).startsWith("data:")) return nativeFetch(url, options);
          linearFetches += 1;
          const { query } = JSON.parse(String(options?.body)) as { query: string };
          if (query.includes("OrchestratorWatcherIssueStateBatch")) {
            return batchFailure === "request failure"
              ? new Response("temporary failure", { status: 500 })
              : Response.json({ data: {} });
          }
          return Response.json({
            data: {
              issue: {
                identifier: "ENG-62",
                title: "Merge the pull request",
                state: { name: "Done", type: "completed" },
                url: "https://linear.app/example/issue/ENG-62/example",
                attachments: { nodes: [] },
                relations: { nodes: [] },
              },
            },
          });
        });
        const config = runtimeConfig({
          services: [
            {
              name: "service-a",
              url: dataUrl({ running: [], retrying: [], blocked: [] }),
              linearTeam: "workspace-a-eng",
            },
          ],
          linearTeams: linearTeams(["In Review", "Done"]),
        });
        store.syncDefinitions(config.services, config.linearTeams);
        const task = store.upsertTaskFromEvent({
          type: "ended",
          service: "service-a",
          issueIdentifier: "ENG-62",
          resolvedState: "In Review",
          resolvedStateType: "started",
        });
        store.setParentMessage(task.id, "C123", "1.000", "{}");

        await runOnce({
          config,
          store,
          slackClient: fakeSlackClient([]),
          slackChannelId: "C123",
        });

        assert.equal(linearFetches, 2);
        assert.equal(store.getTask(task.id)?.status, "Done");
        assert.equal(store.getTask(task.id)?.linearStateType, "completed");
      });
    });
  }

  it("defers a rate-limited team without issuing per-task fallback requests", async (context) => {
    await withStore(async (store) => {
      const nativeFetch = globalThis.fetch;
      let linearFetches = 0;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        linearFetches += 1;
        return Response.json(
          { errors: [{ extensions: { code: "RATELIMITED" } }] },
          { status: 400 },
        );
      });
      const config = runtimeConfig({
        services: [
          {
            name: "service-a",
            url: dataUrl({ running: [], retrying: [], blocked: [] }),
            linearTeam: "workspace-a-eng",
          },
        ],
        linearTeams: linearTeams(["In Review", "Done"]),
      });
      store.syncDefinitions(config.services, config.linearTeams);
      const task = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-62",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(task.id, "C123", "1.000", "{}");
      const secondTask = store.upsertTaskFromEvent({
        type: "ended",
        service: "service-a",
        issueIdentifier: "ENG-63",
        resolvedState: "In Review",
        resolvedStateType: "started",
      });
      store.setParentMessage(secondTask.id, "C123", "2.000", "{}");

      await runOnce({
        config,
        store,
        slackClient: fakeSlackClient([]),
        slackChannelId: "C123",
      });

      assert.equal(linearFetches, 1);
      assert.equal(store.getTask(task.id)?.status, "In Review");
      assert.equal(store.getTask(secondTask.id)?.status, "In Review");
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
        defaultAssignees: ["<@UREVIEWERS>"],
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
