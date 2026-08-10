import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runStatusHooks, type StatusHookContext } from "./status-hooks.ts";

const context: StatusHookContext = {
  event: "issue.status_changed",
  service: "ios",
  issue: { identifier: "APP-42", title: "Ship preview" },
  transition: { from: "In Progress", to: "In Review" },
  pullRequest: { url: "https://github.com/example/app/pull/42", number: 42 },
};
const helpers = {
  slack: {
    postMessage: async () => {},
    postThreadMessage: async () => {},
  },
} as const;

describe("status hooks", () => {
  it("runs matching TypeScript hooks with context and returns their message", async () => {
    const results = await runStatusHooks(
      [
        {
          status: "in review",
          run: (received) => received.issue.identifier,
          timeoutMs: 1_000,
        },
        { status: "Done", run: () => "should-not-run", timeoutMs: 1_000 },
      ],
      context,
      helpers,
    );

    assert.deepEqual(results, [{ output: "APP-42" }]);
  });

  it("reports command failures without throwing", async () => {
    const [result] = await runStatusHooks(
      [
        {
          status: "In Review",
          run: () => {
            throw new Error("broken");
          },
          timeoutMs: 1_000,
        },
      ],
      context,
      helpers,
    );

    assert.match(String(result.error), /broken/);
  });
});
