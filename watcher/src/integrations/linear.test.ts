import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchLinearIssueState,
  fetchLinearWorkflowStates,
  updateLinearIssueStatus,
} from "./linear.ts";

describe("fetchLinearWorkflowStates", () => {
  it("returns team workflow states in Linear position order", async (context) => {
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        data: {
          team: {
            states: {
              nodes: [
                { name: "Done", type: "completed", position: 1 },
                { name: "In Progress", type: "started", position: 1 },
                { name: "Todo", type: "unstarted", position: 1 },
              ],
            },
          },
        },
      });
    });

    assert.deepEqual(await fetchLinearWorkflowStates("team-id", { apiKey: "lin_test" }), [
      "Todo",
      "In Progress",
      "Done",
    ]);
    assert.equal(calls[0].url, "https://api.linear.app/graphql");
    assert.deepEqual(JSON.parse(calls[0].options.body).variables, { id: "team-id" });
  });

  it("fails when the configured team cannot be resolved", async (context) => {
    context.mock.method(globalThis, "fetch", async () => Response.json({ data: { team: null } }));

    await assert.rejects(
      fetchLinearWorkflowStates("missing-team", { apiKey: "lin_test" }),
      /Linear team not found/,
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

describe("updateLinearIssueStatus", () => {
  it("resolves a team-scoped workflow state and updates the Linear issue", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);

      if (requests.length === 1) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              team: {
                states: {
                  nodes: [
                    { id: "state-progress", name: "In Progress" },
                    { id: "state-review", name: "In Review" },
                  ],
                },
              },
            },
          },
        });
      }

      return Response.json({
        data: { issueUpdate: { success: true } },
      });
    });

    await updateLinearIssueStatus("ENG-62", "In Review", {
      apiKey: "lin_test",
    });

    assert.deepEqual(requests[1].variables, {
      id: "issue-uuid",
      stateId: "state-review",
    });
  });

  it("fails without mutating when the status does not exist in the issue team", async (context) => {
    context.mock.method(globalThis, "fetch", async () =>
      Response.json({
        data: {
          issue: {
            id: "issue-uuid",
            team: {
              states: { nodes: [{ id: "state-done", name: "Done" }] },
            },
          },
        },
      }),
    );

    await assert.rejects(
      updateLinearIssueStatus("ENG-62", "QA", { apiKey: "lin_test" }),
      /Linear status not found/,
    );
  });

  it("times out a status mutation that never responds", async (context) => {
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

    await assert.rejects(
      updateLinearIssueStatus("ENG-62", "Done", {
        apiKey: "lin_test",
        timeoutMs: 5,
      }),
      /timed out|aborted/i,
    );
  });
});
