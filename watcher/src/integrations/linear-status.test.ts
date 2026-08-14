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
