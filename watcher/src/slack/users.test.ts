import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSlackAssigneeId, resolveSlackAssigneeLabels } from "./users.ts";

describe("Slack users", () => {
  it("resolves mentions, me, and a bare username", async () => {
    const cursors: Array<string | undefined> = [];
    const client = {
      users: {
        async info() {
          return { ok: true };
        },
        async list({ cursor }: { cursor?: string }) {
          cursors.push(cursor);
          return cursor
            ? {
                ok: true,
                members: [{ id: "UHIROPPY", name: "Hiroppy", profile: {} }],
              }
            : {
                ok: true,
                members: [{ id: "UOTHER", name: "other", profile: {} }],
                response_metadata: { next_cursor: "next-page" },
              };
        },
      },
    } as never;

    assert.equal(await resolveSlackAssigneeId(client, "<@U123>"), "U123");
    assert.equal(await resolveSlackAssigneeId(client, "<!subteam^S123>"), "!subteam^S123");
    assert.equal(await resolveSlackAssigneeId(client, "ME", "UCURRENT"), "UCURRENT");
    assert.equal(await resolveSlackAssigneeId(client, "hiroppy"), "UHIROPPY");
    assert.equal(await resolveSlackAssigneeId(client, "@Hiroppy"), "UHIROPPY");
    assert.deepEqual(cursors, [undefined, "next-page", undefined, "next-page"]);
  });

  it("ignores inactive identities when resolving a bare name", async () => {
    const client = {
      users: {
        async info() {
          return { ok: true };
        },
        async list() {
          return {
            ok: true,
            members: [
              { id: "UACTIVE", name: "hiroppy", profile: {} },
              { id: "UDELETED", name: "hiroppy", deleted: true, profile: {} },
              { id: "UBOT", name: "hiroppy", is_bot: true, profile: {} },
              { id: "UAPP", name: "hiroppy", is_app_user: true, profile: {} },
            ],
          };
        },
      },
    } as never;

    assert.equal(await resolveSlackAssigneeId(client, "hiroppy"), "UACTIVE");
  });

  it("does not resolve an ambiguous bare name", async () => {
    const client = {
      users: {
        async info() {
          return { ok: true };
        },
        async list() {
          return {
            ok: true,
            members: [
              { id: "U123", name: "hiroppy", profile: {} },
              { id: "U456", profile: { display_name: "Hiroppy" } },
            ],
          };
        },
      },
    } as never;

    assert.equal(await resolveSlackAssigneeId(client, "hiroppy"), undefined);
  });

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
      ["<@U02T8HCR5>", "<!subteam^S123>", "<!subteam^S456|Reviewers>"],
    );

    assert.deepEqual(labels, ["@Hiroppy", "@S123", "@Reviewers"]);
  });

  it("falls back to the user ID when display-name lookup is unavailable", async () => {
    assert.deepEqual(await resolveSlackAssigneeLabels({}, ["<@U02T8HCR5>"]), ["@U02T8HCR5"]);
  });
});
