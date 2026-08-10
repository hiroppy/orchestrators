import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchLinearWorkflowStates } from "./linear.ts";

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
