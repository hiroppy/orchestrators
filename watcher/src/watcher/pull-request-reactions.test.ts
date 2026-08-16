import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { syncPullRequestReactions } from "./pull-request-reactions.ts";

describe("syncPullRequestReactions", () => {
  it("mirrors GitHub reaction presence onto the Slack thread parent", async () => {
    const calls: Array<{ method: string; name: string }> = [];
    const client = {
      reactions: {
        async add({ name }: { name: string }) {
          calls.push({ method: "add", name });
        },
        async get() {
          return {
            message: {
              reactions: [{ name: "+1" }, { name: "heart" }, { name: "custom_reaction" }],
            },
          };
        },
        async remove({ name }: { name: string }) {
          calls.push({ method: "remove", name });
        },
      },
    } as never;

    await syncPullRequestReactions(
      client,
      { parentChannelId: "C123", parentMessageTs: "1.000" } as never,
      { url: "https://github.com/acme/example/pull/42", reactions: ["THUMBS_UP", "EYES"] },
    );

    assert.deepEqual(
      calls.filter(({ method }) => method === "add"),
      [{ method: "add", name: "eyes" }],
    );
    assert.deepEqual(
      calls.filter(({ method }) => method === "remove").map(({ name }) => name),
      ["heart"],
    );
  });

  it("accepts Slack responses that already match the desired state", async () => {
    const slackError = (error: string) => Object.assign(new Error(error), { data: { error } });
    const client = {
      reactions: {
        async add() {
          throw slackError("already_reacted");
        },
        async get() {
          return { message: { reactions: [{ name: "eyes" }] } };
        },
        async remove() {
          throw slackError("no_reaction");
        },
      },
    } as never;

    await syncPullRequestReactions(
      client,
      { parentChannelId: "C123", parentMessageTs: "1.000" } as never,
      { url: "https://github.com/acme/example/pull/42", reactions: ["HEART"] },
    );
  });
});
