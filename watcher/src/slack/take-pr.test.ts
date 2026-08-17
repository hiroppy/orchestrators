import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPending,
  pullRequest,
  selectionBody,
  takePrOptions as options,
} from "./take-pr.test-support.ts";
import { handleAppMention } from "./mention-commands.ts";
import { fakeClient, withStore } from "./app.test-support.ts";
import { handleTakePrAction, handleTakePrMention } from "./take-pr.ts";

describe("take-pr Slack flow", () => {
  it("expires abandoned requests after 24 hours", async () => {
    await withStore((store) => {
      const startedAt = new Date("2026-08-11T00:00:00.000Z");
      const request = {
        pullRequestUrl: pullRequest.url,
        repository: pullRequest.repository,
        pullRequestTitle: pullRequest.title,
        pullRequestBody: pullRequest.body,
        headBranch: pullRequest.headRefName,
        baseBranch: pullRequest.baseRefName,
        channelId: "C123",
        threadTs: "10.000",
        requesterSlackUserId: "U123",
      };
      store.createPendingTakePrRequest({ id: "request-active", ...request }, startedAt);
      assert.ok(
        store.getPendingTakePrRequest(
          "request-active",
          new Date(startedAt.getTime() + 24 * 60 * 60 * 1_000 - 1),
        ),
      );
      assert.equal(
        store.getPendingTakePrRequest(
          "request-active",
          new Date(startedAt.getTime() + 24 * 60 * 60 * 1_000),
        ),
        undefined,
      );
    });
  });

  it("atomically takes and restores pending requests", async () => {
    await withStore((store) => {
      const startedAt = new Date("2026-08-11T00:00:00.000Z");
      store.createPendingTakePrRequest(
        {
          id: "request123",
          pullRequestUrl: pullRequest.url,
          repository: pullRequest.repository,
          pullRequestTitle: pullRequest.title,
          pullRequestBody: pullRequest.body,
          headBranch: pullRequest.headRefName,
          baseBranch: pullRequest.baseRefName,
          channelId: "C123",
          threadTs: "10.000",
          requesterSlackUserId: "U123",
        },
        startedAt,
      );

      const request = store.takePendingTakePrRequest("request123", startedAt);
      assert.equal(request?.id, "request123");
      assert.equal(store.takePendingTakePrRequest("request123"), undefined);
      store.restorePendingTakePrRequest(request!);
      assert.equal(store.getPendingTakePrRequest("request123", startedAt)?.id, "request123");
    });
  });

  it("stores PR metadata and replies in the source thread with enabled service options", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await handleAppMention(
        {
          event: {
            channel: "C123",
            ts: "10.000",
            user: "U123",
            text: `<@UBOT> take-pr ${pullRequest.url}`,
          },
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        undefined,
        options(),
      );

      const pending = store.getPendingTakePrRequest("request123");
      assert.deepEqual(pending, {
        id: "request123",
        pullRequestUrl: pullRequest.url,
        repository: pullRequest.repository,
        pullRequestTitle: pullRequest.title,
        pullRequestBody: pullRequest.body,
        headBranch: pullRequest.headRefName,
        baseBranch: pullRequest.baseRefName,
        channelId: "C123",
        threadTs: "10.000",
        requesterSlackUserId: "U123",
        createdAt: pending?.createdAt,
      });
      const reply = calls.find(({ method }) => method === "postMessage")?.args;
      assert.equal(reply?.channel, "C123");
      assert.equal(reply?.thread_ts, "10.000");
      assert.match(JSON.stringify(reply?.blocks), /static_select.*service-a.*request123/s);
      assert.doesNotMatch(JSON.stringify(reply?.blocks), /fix\/widget/);
    });
  });

  it("defaults the service select from the GitHub repository name", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await handleTakePrMention(
        { channel: "C123", ts: "10.000", user: "U123" },
        [pullRequest.url],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        options({
          services: [
            { name: "other", url: "https://other.test/state", linearTeam: "workspace-a-eng" },
            { name: "Widget", url: "https://widget.test/state", linearTeam: "workspace-a-eng" },
          ],
        }),
      );

      const blocks = calls.find(({ method }) => method === "postMessage")?.args.blocks;
      assert.match(
        JSON.stringify(blocks),
        /"initial_option":\{"text":\{"type":"plain_text","text":"Widget"\},"value":"request123:i1"\}/,
      );
      assert.match(JSON.stringify(blocks), /"action_id":"take_pr_confirm"/);
    });
  });

  it("uses bounded opaque option values for long service names", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await handleTakePrMention(
        { channel: "C123", ts: "10.000", user: "U123" },
        [pullRequest.url],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        options({
          services: [
            {
              name: "service-".repeat(30),
              url: "https://service.test",
              linearTeam: "workspace-a-eng",
            },
          ],
        }),
      );

      const blocks = JSON.stringify(calls[0].args.blocks);
      assert.match(blocks, /"value":"request123:i0"/);
      assert.doesNotMatch(blocks, /request123:service-service/);
    });
  });

  it("reports an expired selector after in-memory state is unavailable", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await handleTakePrAction(
        {
          ack: async () => {},
          action: { value: "request123" },
          body: {
            user: { id: "U123" },
            channel: { id: "C123" },
            message: { ts: "11.000", thread_ts: "10.000" },
          },
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        options(),
      );

      assert.equal(calls[0].args.channel, "C123");
      assert.equal(calls[0].args.thread_ts, "10.000");
      assert.match(String(calls[0].args.text), /selector has expired.*take-pr command again/s);
    });
  });

  it("confirms the inferred service with the OK button", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const takePrOptions = options({
        services: [
          { name: "widget", url: "https://widget.test/state", linearTeam: "workspace-a-eng" },
        ],
        createLinearIssue: async () => ({
          identifier: "ENG-100",
          url: "https://linear.app/example/issue/ENG-100/take-pr",
        }),
      });
      store.syncDefinitions(takePrOptions.services, takePrOptions.linearTeams);
      await createPending(store, calls, takePrOptions);
      calls.length = 0;

      await handleTakePrAction(
        {
          ack: async () => {},
          action: { value: "request123" },
          body: {
            user: { id: "U123" },
            state: {
              values: {
                "take-pr:request123": {
                  take_pr_service_select: {
                    selected_option: { value: "request123:i0" },
                  },
                },
              },
            },
          },
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        takePrOptions,
      );

      assert.equal(store.getPendingTakePrRequest("request123"), undefined);
    });
  });

  it("asks the requester to select a service before confirming", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let creations = 0;
      const takePrOptions = options({
        services: [
          { name: "other", url: "https://other.test/state", linearTeam: "workspace-a-eng" },
        ],
        createLinearIssue: async () => {
          creations += 1;
          throw new Error("should not create");
        },
      });
      await createPending(store, calls, takePrOptions);
      calls.length = 0;

      await handleTakePrAction(
        {
          ack: async () => {},
          action: { value: "request123" },
          body: { user: { id: "U123" }, state: { values: {} } },
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        takePrOptions,
      );

      assert.equal(creations, 0);
      assert.match(String(calls[0].args.text), /Select a service before confirming take-pr/);
    });
  });

  it("deduplicates Slack redelivery of the same app mention", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const takePrOptions = options();
      delete takePrOptions.createRequestId;

      await createPending(store, calls, takePrOptions);
      await createPending(store, calls, takePrOptions);

      assert.equal(calls[0].args.client_msg_id, calls[1].args.client_msg_id);
    });
  });

  it("reports a take-pr-specific error when selector delivery fails", async () => {
    await withStore(async (store) => {
      const calls: Array<Record<string, unknown>> = [];
      let postAttempts = 0;
      await handleAppMention(
        {
          event: {
            channel: "C123",
            ts: "10.000",
            user: "U123",
            text: `<@UBOT> take-pr ${pullRequest.url}`,
          },
          client: {
            chat: {
              postMessage: async (args: Record<string, unknown>) => {
                postAttempts += 1;
                if (postAttempts === 1) throw new Error("selector unavailable");
                calls.push(args);
                return { ok: true };
              },
            },
          } as never,
          logger: { error: () => {} },
        },
        store,
        undefined,
        options(),
      );

      assert.ok(store.getPendingTakePrRequest("request123"));
      assert.equal(calls[0].thread_ts, "10.000");
      assert.match(String(calls[0].text), /Failed to start take-pr.*No Linear issue was created/s);
      assert.doesNotMatch(String(calls[0].text), /current task status/);
    });
  });

  it("rejects take-pr outside the configured watcher channel", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let lookups = 0;
      await handleTakePrMention(
        { channel: "CUNTRUSTED", ts: "10.000", user: "U123" },
        [pullRequest.url],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        options({
          findPullRequest: async () => {
            lookups += 1;
            return pullRequest;
          },
        }),
      );

      assert.equal(lookups, 0);
      assert.match(String(calls[0].args.text), /only allowed in the configured watcher channel/);
    });
  });

  it("rejects invalid and inaccessible PR URLs without creating pending state", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let lookups = 0;
      const takePrOptions = options({
        findPullRequest: async () => {
          lookups += 1;
          return null;
        },
      });

      await handleTakePrMention(
        { channel: "C123", ts: "10.000" },
        ["https://example.com/not-a-pr"],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        takePrOptions,
      );
      await handleTakePrMention(
        { channel: "C123", ts: "11.000" },
        [pullRequest.url],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        takePrOptions,
      );

      assert.equal(lookups, 1);
      assert.equal(store.getPendingTakePrRequest("request123"), undefined);
      assert.match(String(calls[0].args.text), /Usage/);
      assert.match(String(calls[1].args.text), /Could not load/);
    });
  });

  it("rejects a closed PR before creating pending state", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await handleTakePrMention(
        { channel: "C123", ts: "10.000", user: "U123" },
        [pullRequest.url],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        options({ findPullRequest: async () => ({ ...pullRequest, state: "CLOSED" }) }),
      );

      assert.equal(store.getPendingTakePrRequest("request123"), undefined);
      assert.match(String(calls[0].args.text), /must be open/);
    });
  });

  it("revalidates that the PR is still open before claiming a delayed selection", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await createPending(store, calls, options());
      calls.length = 0;
      let creations = 0;

      await handleTakePrAction(
        {
          ack: async () => {},
          action: { value: "request123" },
          body: selectionBody(),
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        options({
          findPullRequest: async () => ({ ...pullRequest, state: "MERGED" }),
          createLinearIssue: async () => {
            creations += 1;
            throw new Error("should not create");
          },
        }),
      );

      assert.equal(creations, 0);
      assert.ok(store.getPendingTakePrRequest("request123"));
      assert.match(String(calls[0].args.text), /no longer open.*No Linear issue was created/s);
    });
  });

  it("uses refreshed PR metadata after a delayed selection", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await createPending(store, calls, options());
      calls.length = 0;
      const updatedPullRequest = {
        ...pullRequest,
        title: "Updated widget fix",
        body: "## Summary\n\nUpdated widget fix details.",
        headRefName: "fix/updated-widget",
        baseRefName: "release",
      };

      await handleTakePrAction(
        {
          ack: async () => {},
          action: { value: "request123" },
          body: selectionBody(),
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        options({
          findPullRequest: async () => updatedPullRequest,
          createLinearIssue: async (input) => {
            assert.match(input.description, /Updated widget fix details/);
            assert.doesNotMatch(input.description, /Fixes the widget regression/);
            return {
              identifier: "ENG-100",
              url: "https://linear.app/example/issue/ENG-100/take-pr",
            };
          },
        }),
      );

      assert.equal(store.getPendingTakePrRequest("request123"), undefined);
      assert.match(String(calls[1].args.text), /Updated widget fix/);
    });
  });
});
