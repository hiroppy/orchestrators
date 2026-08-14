import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchLinearWorkflowStates, updateLinearIssueStatus } from "./linear.ts";

describe("updateLinearIssueStatus", () => {
  it("reuses cached team workflow states when updating the Linear issue", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);

      if (request.query.includes("TeamWorkflowStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-progress", name: "In Progress", type: "started", position: 1 },
                  { id: "state-review", name: "In Review", type: "started", position: 2 },
                ],
              },
            },
          },
        });
      }

      return Response.json({
        data: { issueUpdate: { success: true } },
      });
    });

    await fetchLinearWorkflowStates("team-cache-test", { apiKey: "lin_test" });
    await updateLinearIssueStatus("ENG-62", "In Review", {
      apiKey: "lin_test",
      issueId: "issue-uuid",
      teamId: "team-cache-test",
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].variables, {
      id: "issue-uuid",
      stateId: "state-review",
    });
  });

  it("invalidates a rejected cached state and refreshes it on the next attempt", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);

      if (request.query.includes("TeamWorkflowStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-review-stale", name: "In Review", type: "started", position: 1 },
                ],
              },
            },
          },
        });
      }
      if (requests.length === 2) {
        return Response.json({ errors: [{ message: "Workflow state not found" }] });
      }
      if (request.query.includes("IssueStatusTarget")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-current",
              team: {
                states: {
                  nodes: [{ id: "state-review-current", name: "In Review" }],
                },
              },
            },
          },
        });
      }
      return Response.json({ data: { issueUpdate: { success: true } } });
    });

    await fetchLinearWorkflowStates("team-stale-cache-test", { apiKey: "lin_test" });
    await assert.rejects(
      updateLinearIssueStatus("ENG-62", "In Review", {
        apiKey: "lin_test",
        issueId: "issue-stale",
        teamId: "team-stale-cache-test",
      }),
      /Workflow state not found/,
    );
    await updateLinearIssueStatus("ENG-63", "In Review", {
      apiKey: "lin_test",
      issueId: "issue-next",
      teamId: "team-stale-cache-test",
    });
    await updateLinearIssueStatus("ENG-64", "In Review", {
      apiKey: "lin_test",
      issueId: "issue-cached",
      teamId: "team-stale-cache-test",
    });

    assert.equal(requests.length, 5);
    assert.deepEqual(
      requests.map(({ variables }) => variables),
      [
        { id: "team-stale-cache-test" },
        { id: "issue-stale", stateId: "state-review-stale" },
        { id: "ENG-63" },
        { id: "issue-current", stateId: "state-review-current" },
        { id: "issue-cached", stateId: "state-review-current" },
      ],
    );
  });

  it("revalidates workflow state names after the cache expires", async (context) => {
    let now = 0;
    context.mock.method(Date, "now", () => now);
    const requests: Array<{ query: string }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      if (request.query.includes("TeamWorkflowStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [{ id: "state-review", name: "In Review", type: "started", position: 1 }],
              },
            },
          },
        });
      }
      return Response.json({
        data: {
          issue: {
            id: "issue-current",
            team: {
              states: { nodes: [{ id: "state-renamed", name: "Reviewing" }] },
            },
          },
        },
      });
    });

    await fetchLinearWorkflowStates("team-renamed-state-test", { apiKey: "lin_test" });
    now = 10 * 60 * 1_000;
    await assert.rejects(
      updateLinearIssueStatus("ENG-62", "In Review", {
        apiKey: "lin_test",
        issueId: "issue-uuid",
        teamId: "team-renamed-state-test",
      }),
      /Linear status not found/,
    );
    assert.equal(requests.length, 2);
  });

  it("does not amplify a transient cached mutation failure", async (context) => {
    const requests: Array<{ query: string }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      if (request.query.includes("TeamWorkflowStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [{ id: "state-review", name: "In Review", type: "started", position: 1 }],
              },
            },
          },
        });
      }
      return Response.json(
        { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] },
        { status: 400 },
      );
    });

    await fetchLinearWorkflowStates("team-rate-limit-test", { apiKey: "lin_test" });
    await assert.rejects(
      updateLinearIssueStatus("ENG-62", "In Review", {
        apiKey: "lin_test",
        issueId: "issue-uuid",
        teamId: "team-rate-limit-test",
      }),
      /HTTP 400/,
    );
    assert.equal(requests.length, 2);
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
