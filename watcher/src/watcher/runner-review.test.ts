import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runOnce } from "./runner.ts";
import {
  REVIEW_REQUEUE_ATTEMPT_EVENT,
  decideReviewReaction,
  reviewRequeueAttemptKey,
} from "./review-reactions.ts";
import {
  dataUrl,
  fakeSlackClient,
  linearTeams,
  runtimeConfig,
  withStore,
} from "./runner.test-support.ts";

describe("watcher review reactions", () => {
  it("limits requeues for the same pull request head", async (context) => {
    await withStore(async (store) => {
      let linearState = "In Review";
      let linearFetchFailuresRemaining = 0;
      let hasReviewReaction = true;
      let failWorkspacePullRequestLookupOnce = false;
      let failReactionLookupOnce = false;
      let omitLinearPullRequestOnce = false;
      let headRefOid = "abc123";
      const nativeFetch = globalThis.fetch;
      context.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("data:")) return nativeFetch(url, options);
        if (linearFetchFailuresRemaining > 0) {
          linearFetchFailuresRemaining -= 1;
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
              creator: { name: "Creator", email: "creator@example.com" },
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
        notifications: {
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
              headRefOid,
              hasConfiguredReaction: hasReviewReaction && options.reaction === "👀",
            };
          },
          findPullRequestByUrl: async (url, options) => {
            if (failReactionLookupOnce) {
              failReactionLookupOnce = false;
              return { url, number: 42 };
            }
            return {
              url,
              number: 42,
              headRefOid,
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
      assert.match(
        JSON.stringify(
          calls.find(({ text }) => String(text).includes("👀 review reaction detected"))?.blocks,
        ),
        /Review reaction detected/,
      );
      assert.doesNotMatch(
        JSON.stringify(
          calls.find(({ text }) => String(text).includes("👀 review reaction detected")),
        ),
        /<@U123>/,
      );

      await run("In Progress");
      linearState = "In Review";
      await run("In Review");
      assert.deepEqual(statusUpdates, ["In Progress", "In Progress"]);
      assert.equal(
        calls.filter(({ text }) => String(text).includes("👀 review reaction detected")).length,
        2,
      );
      assert.doesNotMatch(JSON.stringify(calls), /review requeue limit reached/);
      assert.equal(store.getTaskAssignees("service-a:ENG-62").includes("<@U123>"), true);

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
      assert.doesNotMatch(
        store.getLatestEvent("service-a:ENG-62", "review_requeue_limit_pending")?.body ?? "",
        /creatorName|creatorEmail|creator@example\.com/,
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
      assert.match(
        JSON.stringify(
          calls.find(({ text }) => String(text).includes("review requeue limit reached (3/3)"))
            ?.blocks,
        ),
        /Review requeue limit reached.*Requeues/s,
      );
      assert.match(JSON.stringify(calls), /<@U123>/);
      const assigneeNotificationCount = () =>
        calls.filter(
          (call) => call.method === "postMessage" && JSON.stringify(call).includes("<@U123>"),
        ).length;
      const blockedMentionCallCount = assigneeNotificationCount();

      hasReviewReaction = true;
      linearState = "In Review";
      linearFetchFailuresRemaining = 2;
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
      assert.match(
        JSON.stringify([...calls].reverse().find(({ method }) => method === "update")),
        /@U123/,
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
      assert.equal(store.getTaskAssignees("service-a:ENG-62").includes("<@U123>"), true);

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
      // Phase 5: a terminal task reuses its stored PR, but a non-authoritative reaction lookup
      // stays pending.
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
      assert.equal(assigneeNotificationCount(), blockedMentionCallCount);

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
      assert.equal(
        store.countEventsWithBody(
          "service-a:ENG-62",
          REVIEW_REQUEUE_ATTEMPT_EVENT,
          reviewRequeueAttemptKey(
            {
              type: "updated",
              service: "service-a",
              issueIdentifier: "ENG-62",
              pullRequest: {
                url: "https://github.com/acme/example/pull/42",
                headRefOid,
              },
            },
            "👀",
          ),
        ),
        3,
      );
      assert.ok(assigneeNotificationCount() > blockedMentionCallCount);
      const mentionCallCount = assigneeNotificationCount();

      hasReviewReaction = true;
      config.reviewReaction.maxRequeues = 3;
      linearState = "In Progress";
      await run("In Progress");
      linearState = "In Review";
      // Phase 7: returning to In Review with the same reacted head stays capped.
      await run("In Review");
      assert.equal(statusUpdates.length, 3);
      assert.equal(store.getTask("service-a:ENG-62")?.status, "In Review");
      assert.ok(assigneeNotificationCount() > mentionCallCount);
      const cappedMentionCount = assigneeNotificationCount();

      // A new pull request head starts a separate retry budget.
      headRefOid = "def456";
      linearState = "In Progress";
      await run("In Progress");
      linearState = "In Review";
      await run("In Review");
      assert.equal(statusUpdates.length, 4);
      assert.equal(
        store.countEventsWithBody(
          "service-a:ENG-62",
          REVIEW_REQUEUE_ATTEMPT_EVENT,
          reviewRequeueAttemptKey(
            {
              type: "updated",
              service: "service-a",
              issueIdentifier: "ENG-62",
              pullRequest: {
                url: "https://github.com/acme/example/pull/42",
                headRefOid,
              },
            },
            "👀",
          ),
        ),
        1,
      );
      assert.equal(assigneeNotificationCount(), cappedMentionCount);
      assert.match(
        JSON.stringify([...calls].reverse().find(({ method }) => method === "update")),
        /PR#42/,
      );
      assert.match(
        JSON.stringify([...calls].reverse().find(({ method }) => method === "update")),
        /@U123/,
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
              creator: { name: "Creator", email: "creator@example.com" },
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
        notifications: {
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

  it("preserves the retry budget from legacy requeue events", async () => {
    await withStore(async (store) => {
      const config = runtimeConfig({
        services: [{ name: "service-a", url: "", linearTeam: "workspace-a-eng" }],
        linearTeams: linearTeams(["In Progress", "In Review"]),
        reviewReaction: {
          inReviewStatus: "In Review",
          inProgressStatus: "In Progress",
          reaction: "👀",
          maxRequeues: 3,
        },
      });
      store.syncDefinitions(config.services, config.linearTeams);
      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
      });
      for (let count = 0; count < 3; count += 1) {
        store.addEvent({ taskId: "service-a:ENG-62", type: "review_requeued" });
      }

      const legacyHead = {
        type: "updated" as const,
        service: "service-a",
        issueIdentifier: "ENG-62",
        state: "In Review",
        pullRequest: {
          url: "https://github.com/acme/example/pull/42",
          headRefOid: "abc123",
          hasConfiguredReaction: true,
        },
      };
      assert.deepEqual(decideReviewReaction(config, store, legacyHead), {
        shouldRequeue: false,
        reachesLimit: false,
      });
      assert.equal(
        store.countEventsWithBody(
          "service-a:ENG-62",
          REVIEW_REQUEUE_ATTEMPT_EVENT,
          reviewRequeueAttemptKey(legacyHead, "👀"),
        ),
        3,
      );

      assert.deepEqual(
        decideReviewReaction(config, store, {
          ...legacyHead,
          pullRequest: { ...legacyHead.pullRequest, headRefOid: "def456" },
        }),
        { shouldRequeue: true, reachesLimit: false },
      );

      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-63",
        state: "In Review",
      });
      for (let count = 0; count < 3; count += 1) {
        store.addEvent({ taskId: "service-a:ENG-63", type: "review_requeued" });
      }
      store.addEvent({ taskId: "service-a:ENG-63", type: "review_requeue_limit_reached" });
      for (let count = 0; count < 2; count += 1) {
        store.addEvent({ taskId: "service-a:ENG-63", type: "review_requeued" });
      }
      const partialLegacyCycle = {
        ...legacyHead,
        issueIdentifier: "ENG-63",
        pullRequest: { ...legacyHead.pullRequest, url: "https://github.com/acme/example/pull/43" },
      };
      assert.deepEqual(decideReviewReaction(config, store, partialLegacyCycle), {
        shouldRequeue: true,
        reachesLimit: true,
      });
      assert.equal(
        store.countEventsWithBody(
          "service-a:ENG-63",
          REVIEW_REQUEUE_ATTEMPT_EVENT,
          reviewRequeueAttemptKey(partialLegacyCycle, "👀"),
        ),
        2,
      );

      store.upsertTaskFromEvent({
        type: "started",
        service: "service-a",
        issueIdentifier: "ENG-64",
        state: "In Review",
      });
      const exhaustedLegacyHead = {
        ...legacyHead,
        issueIdentifier: "ENG-64",
        pullRequest: { ...legacyHead.pullRequest, url: "https://github.com/acme/example/pull/44" },
      };
      for (let count = 0; count < 3; count += 1) {
        store.addEvent({ taskId: "service-a:ENG-64", type: "review_requeued" });
      }
      store.addEvent({
        taskId: "service-a:ENG-64",
        type: "review_requeue_limit_pending",
        body: JSON.stringify({
          message: "limit reached",
          event: exhaustedLegacyHead,
          reaction: "👀",
          maxRequeues: 3,
        }),
      });
      store.addEvent({ taskId: "service-a:ENG-64", type: "review_requeue_limit_reached" });
      assert.deepEqual(decideReviewReaction(config, store, exhaustedLegacyHead), {
        shouldRequeue: false,
        reachesLimit: false,
      });
      assert.equal(
        store.countEventsWithBody(
          "service-a:ENG-64",
          REVIEW_REQUEUE_ATTEMPT_EVENT,
          reviewRequeueAttemptKey(exhaustedLegacyHead, "👀"),
        ),
        3,
      );

      const earlierExhaustedHead = {
        ...exhaustedLegacyHead,
        pullRequest: { ...exhaustedLegacyHead.pullRequest, headRefOid: "earlier-head" },
      };
      store.addEvent({
        taskId: "service-a:ENG-64",
        type: "review_requeue_limit_pending",
        body: JSON.stringify({
          message: "earlier limit reached",
          event: earlierExhaustedHead,
          reaction: "👀",
          maxRequeues: 3,
        }),
      });
      store.addEvent({ taskId: "service-a:ENG-64", type: "review_requeue_limit_reached" });
      assert.deepEqual(decideReviewReaction(config, store, earlierExhaustedHead), {
        shouldRequeue: false,
        reachesLimit: false,
      });
      assert.equal(
        store.countEventsWithBody(
          "service-a:ENG-64",
          REVIEW_REQUEUE_ATTEMPT_EVENT,
          reviewRequeueAttemptKey(earlierExhaustedHead, "👀"),
        ),
        3,
      );
    });
  });
});
