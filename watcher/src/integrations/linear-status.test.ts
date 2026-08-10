import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { updateLinearIssueStatus } from "./linear.ts";

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
