import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dispatchStatusHooks, runStatusHooks, type StatusHookContext } from "./status-hooks.ts";

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
        },
        { status: "Done", run: () => "should-not-run" },
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
        },
      ],
      context,
      helpers,
    );

    assert.match(String(result.error), /broken/);
  });

  it("uses enriched PR data and parent-fixed Slack destinations", async () => {
    const posts: Array<Record<string, unknown>> = [];
    await dispatchStatusHooks({
      hooks: [
        {
          status: "In Review",
          run: async ({ pullRequest }, { slack }) => {
            await slack.postMessage({ text: pullRequest?.title ?? "missing" });
            await slack.postThreadMessage({ text: "thread" });
            return "returned";
          },
        },
      ],
      task: {
        id: "ios:APP-42",
        serviceName: "ios",
        issueIdentifier: "APP-42",
        title: "Ship preview",
        status: "In Review",
        parentChannelId: "COLD",
        parentMessageTs: "10.000",
        updatedAt: "2026-08-10T00:00:00Z",
      },
      fromStatus: "In Progress",
      toStatus: "In Review",
      pullRequest: {
        url: "https://github.com/example/app/pull/42",
        number: 42,
        title: "Enriched title",
        headRefName: "app-42",
      },
      slackClient: {
        chat: {
          async postMessage(args) {
            posts.push(args);
          },
        },
      },
      watcherChannelId: "CNEW",
    });

    assert.deepEqual(posts, [
      { text: "Enriched title", channel: "CNEW" },
      { text: "thread", channel: "COLD", thread_ts: "10.000" },
      { channel: "COLD", thread_ts: "10.000", text: "returned" },
    ]);
  });
});
