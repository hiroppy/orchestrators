import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchLinearIssueState, fetchLinearIssueStateSummaries } from "./linear.ts";

describe("fetchLinearIssueStateSummaries", () => {
  it("fetches multiple issue states in one lightweight GraphQL request", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      return Response.json({
        data: {
          issue0: { identifier: "ENG-1", state: { name: "In Review", type: "started" } },
          issue1: { identifier: "ENG-2", state: { name: "Done", type: "completed" } },
        },
      });
    });

    const result = await fetchLinearIssueStateSummaries(["ENG-1", "ENG-2"], {
      apiKey: "lin_test",
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.variables, { id0: "ENG-1", id1: "ENG-2" });
    assert.doesNotMatch(requests[0]?.query ?? "", /attachments|relations|creator/);
    assert.deepEqual(
      [...result.values()],
      [
        { identifier: "ENG-1", state: "In Review", stateType: "started" },
        { identifier: "ENG-2", state: "Done", stateType: "completed" },
      ],
    );
  });

  it("chunks large reconciliations into bounded requests", async (context) => {
    let requests = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      return Response.json({ data: {} });
    });

    await fetchLinearIssueStateSummaries(
      Array.from({ length: 51 }, (_, index) => `ENG-${index + 1}`),
      { apiKey: "lin_test" },
    );

    assert.equal(requests, 2);
  });

  it("keys summaries by the requested identifier when Linear returns a canonical identifier", async (context) => {
    context.mock.method(globalThis, "fetch", async () =>
      Response.json({
        data: {
          issue0: {
            identifier: "NEW-1",
            state: { name: "In Progress", type: "started" },
          },
        },
      }),
    );

    const result = await fetchLinearIssueStateSummaries(["OLD-1"], { apiKey: "lin_test" });

    assert.deepEqual(result.get("OLD-1"), {
      identifier: "NEW-1",
      state: "In Progress",
      stateType: "started",
    });
  });

  it("preserves a batch rate-limit error for the caller", async (context) => {
    context.mock.method(globalThis, "fetch", async () =>
      Response.json({ errors: [{ extensions: { code: "RATELIMITED" } }] }, { status: 400 }),
    );

    await assert.rejects(
      fetchLinearIssueStateSummaries(["ENG-1"], { apiKey: "lin_test" }),
      /rate limit/i,
    );
  });
});

describe("fetchLinearIssueState", () => {
  it("returns current Linear issue state by issue identifier", async (context) => {
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options });

      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "ENG-65",
              title: "Show Linear titles in Slack",
              state: { name: "In Review", type: "started" },
              url: "https://linear.app/example/issue/ENG-65/example",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchLinearIssueState("ENG-65", {
      apiKey: "lin_test",
    });

    assert.equal(calls[0].url, "https://api.linear.app/graphql");
    assert.equal(calls[0].options.headers.authorization, "lin_test");
    assert.deepEqual(result, {
      identifier: "ENG-65",
      title: "Show Linear titles in Slack",
      state: "In Review",
      stateType: "started",
      url: "https://linear.app/example/issue/ENG-65/example",
    });
  });

  it("returns null when no api key is configured", async () => {
    const result = await fetchLinearIssueState("ENG-65", {
      apiKey: null,
    });

    assert.equal(result, null);
  });

  it("returns a GitHub pull request attached to the Linear issue", async (context) => {
    context.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            data: {
              issue: {
                identifier: "ENG-67",
                title: "Include attached pull requests",
                state: { name: "In Review", type: "started" },
                url: "https://linear.app/example/issue/ENG-67/example",
                attachments: {
                  nodes: [
                    { url: "https://example.com/design/67" },
                    { url: "https://github.com/example/example-service/pull/456" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await fetchLinearIssueState("ENG-67", {
      apiKey: "lin_test",
    });

    assert.deepEqual(result.pullRequest, {
      url: "https://github.com/example/example-service/pull/456",
      number: 456,
    });
  });

  it("returns nonterminal issues blocked by the current issue as next related work", async (context) => {
    context.mock.method(globalThis, "fetch", async () =>
      Response.json({
        data: {
          issue: {
            identifier: "ENG-62",
            title: "Finish the foundation",
            state: { name: "Done", type: "completed" },
            url: "https://linear.app/example/issue/ENG-62/foundation",
            relations: {
              nodes: [
                {
                  type: "blocks",
                  relatedIssue: {
                    identifier: "ENG-63",
                    title: "Start the follow-up",
                    url: "https://linear.app/example/issue/ENG-63/follow-up",
                    state: { name: "Todo", type: "unstarted" },
                  },
                },
                {
                  type: "blocks",
                  relatedIssue: {
                    identifier: "ENG-64",
                    title: "Already finished",
                    url: "https://linear.app/example/issue/ENG-64/finished",
                    state: { type: "completed" },
                  },
                },
                {
                  type: "related",
                  relatedIssue: {
                    identifier: "ENG-65",
                    title: "Only related",
                    url: "https://linear.app/example/issue/ENG-65/related",
                    state: { type: "unstarted" },
                  },
                },
              ],
            },
          },
        },
      }),
    );

    const result = await fetchLinearIssueState("ENG-62", { apiKey: "lin_test" });

    assert.deepEqual(result?.relatedIssues, [
      {
        identifier: "ENG-63",
        title: "Start the follow-up",
        url: "https://linear.app/example/issue/ENG-63/follow-up",
        state: "Todo",
        stateType: "unstarted",
      },
    ]);
  });

  it("retries transient Linear failures before falling back", async (context) => {
    let attempts = 0;
    context.mock.method(globalThis, "fetch", async () => {
      attempts += 1;

      if (attempts === 1) {
        return new Response("temporary failure", { status: 500 });
      }

      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "ENG-59",
              title: "Retry Linear requests",
              state: { name: "Done", type: "completed" },
              url: "https://linear.app/example/issue/ENG-59/example",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchLinearIssueState("ENG-59", {
      apiKey: "lin_test",
      retryDelayMs: 0,
    });

    assert.equal(attempts, 2);
    assert.deepEqual(result, {
      identifier: "ENG-59",
      title: "Retry Linear requests",
      state: "Done",
      stateType: "completed",
      url: "https://linear.app/example/issue/ENG-59/example",
    });
  });

  it("returns immediately when Linear still reports an active state type", async (context) => {
    let attempts = 0;
    context.mock.method(globalThis, "fetch", async () => {
      attempts += 1;

      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "ENG-66",
              title: "Keep active issues visible",
              state: { name: "In Progress", type: "started" },
              url: "https://linear.app/example/issue/ENG-66/example",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchLinearIssueState("ENG-66", {
      apiKey: "lin_test",
      retryDelayMs: 0,
    });

    assert.equal(attempts, 1);
    assert.deepEqual(result, {
      identifier: "ENG-66",
      title: "Keep active issues visible",
      state: "In Progress",
      stateType: "started",
      url: "https://linear.app/example/issue/ENG-66/example",
    });
  });

  it("times out a Linear request that never responds", async (context) => {
    context.mock.method(
      globalThis,
      "fetch",
      async (_url, options) =>
        await new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );

    const result = await fetchLinearIssueState("ENG-66", {
      apiKey: "lin_test",
      maxAttempts: 1,
      timeoutMs: 5,
    });

    assert.equal(result, null);
  });
});
