import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSlackAssigneeLabels } from "./users.ts";

describe("Slack users", () => {
  it("resolves user mentions to non-notifying display-name labels", async () => {
    const labels = await resolveSlackAssigneeLabels(
      {
        users: {
          async info({ user }) {
            return {
              ok: true,
              user: { id: user, profile: { display_name: "Hiroppy" } },
            };
          },
        },
      },
      ["<@U02T8HCR5>", "<!subteam^S123>"],
    );

    assert.deepEqual(labels, ["@Hiroppy", "<!subteam^S123>"]);
  });

  it("falls back to the user ID when display-name lookup is unavailable", async () => {
    assert.deepEqual(await resolveSlackAssigneeLabels({}, ["<@U02T8HCR5>"]), ["@U02T8HCR5"]);
  });
});
