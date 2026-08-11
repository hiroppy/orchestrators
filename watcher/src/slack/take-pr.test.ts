import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppMention } from "./mention-commands.ts";
import { fakeClient, withStore } from "./app.test-support.ts";
import {
  handleTakePrAction,
  handleTakePrMention,
  parseGitHubPullRequestUrl,
  projectSlugFromWorkflow,
  type TakePrOptions,
} from "./take-pr.ts";

const pullRequest = {
  url: "https://github.com/example/widget/pull/42",
  number: 42,
  title: "Fix the widget",
  repository: "example/widget",
  headRefName: "fix/widget",
  baseRefName: "main",
};

describe("take-pr parsing", () => {
  it("accepts GitHub PR URLs and Slack-formatted links", () => {
    assert.equal(
      parseGitHubPullRequestUrl("https://github.com/example/widget/pull/42"),
      "https://github.com/example/widget/pull/42",
    );
    assert.equal(
      parseGitHubPullRequestUrl(
        "<https://github.com/example/widget/pull/42|github.com/example/widget/pull/42>",
      ),
      "https://github.com/example/widget/pull/42",
    );
  });

  it("rejects non-PR, non-GitHub, query, fragment, and zero-number URLs", () => {
    for (const value of [
      "https://github.com/example/widget/issues/42",
      "https://example.com/example/widget/pull/42",
      "https://github.com/example/widget/pull/42?diff=split",
      "https://github.com/example/widget/pull/42#discussion",
      "https://github.com/example/widget/pull/0",
      "not-a-url",
    ]) {
      assert.equal(parseGitHubPullRequestUrl(value), undefined, value);
    }
  });

  it("reads only tracker.provider.project_slug from YAML frontmatter", () => {
    assert.equal(
      projectSlugFromWorkflow(`---
tracker:
  kind: linear
  provider:
    project_slug: "project-123" # configured project
---
Instructions
`),
      "project-123",
    );
    assert.equal(
      projectSlugFromWorkflow(`---
tracker:
  project_slug: legacy-project
other:
  provider:
    project_slug: wrong-project
---
`),
      undefined,
    );
    assert.equal(
      projectSlugFromWorkflow("tracker:\n  provider:\n    project_slug: missing"),
      undefined,
    );
  });
});

describe("take-pr Slack flow", () => {
  it("stores PR metadata and replies in the source thread with enabled service options", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      await handleAppMention(
        {
          event: {
            channel: "C123",
            ts: "10.000",
            user: "U123",
            text: `<@UBOT> take-pr ${pullRequest.url}`,
          },
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        [],
        options(),
      );

      const pending = store.getPendingTakePrRequest("request123");
      assert.deepEqual(pending, {
        id: "request123",
        pullRequestUrl: pullRequest.url,
        repository: pullRequest.repository,
        pullRequestTitle: pullRequest.title,
        headBranch: pullRequest.headRefName,
        baseBranch: pullRequest.baseRefName,
        channelId: "C123",
        threadTs: "10.000",
        requesterSlackUserId: "U123",
        status: "pending",
        selectedService: undefined,
        linearIssueUrl: undefined,
        createdAt: pending?.createdAt,
        updatedAt: pending?.updatedAt,
      });
      const reply = calls.find(({ method }) => method === "postMessage")?.args;
      assert.equal(reply?.channel, "C123");
      assert.equal(reply?.thread_ts, "10.000");
      assert.match(JSON.stringify(reply?.blocks), /static_select.*service-a.*request123/s);
      assert.doesNotMatch(JSON.stringify(reply?.blocks), /fix\/widget/);
    });
  });

  it("rejects invalid and inaccessible PR URLs without creating pending state", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let lookups = 0;
      const takePrOptions = options({
        findPullRequest: async () => {
          lookups += 1;
          return null;
        },
      });

      await handleTakePrMention(
        { channel: "C123", ts: "10.000" },
        ["https://example.com/not-a-pr"],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        takePrOptions,
      );
      await handleTakePrMention(
        { channel: "C123", ts: "11.000" },
        [pullRequest.url],
        fakeClient(calls),
        { error: (error) => assert.fail(String(error)) },
        store,
        takePrOptions,
      );

      assert.equal(lookups, 1);
      assert.equal(store.getPendingTakePrRequest("request123"), undefined);
      assert.match(String(calls[0].args.text), /Usage/);
      assert.match(String(calls[1].args.text), /Could not load/);
    });
  });

  it("creates an In Progress Linear issue for the selected service and completes the request", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const takePrOptions = options({
        createLinearIssue: async (input, { apiKey }) => {
          assert.equal(apiKey, "lin_test");
          assert.equal(input.teamId, "team-a");
          assert.equal(input.projectSlug, "project-123");
          assert.match(input.title, /既存PRを更新: Fix the widget/);
          assert.match(input.description, /example\/widget/);
          assert.match(input.description, /fix\/widget/);
          assert.match(input.description, /Base branch: `main`/);
          assert.match(input.description, /新しい PR を作成せず/);
          return {
            identifier: "ENG-100",
            url: "https://linear.app/example/issue/ENG-100/take-pr",
          };
        },
      });
      await createPending(store, calls, takePrOptions);
      calls.length = 0;
      let acknowledged = false;

      await handleTakePrAction(
        {
          ack: async () => {
            acknowledged = true;
          },
          action: { selected_option: { value: "request123:service-a" } },
          client: fakeClient(calls),
          logger: { error: (error) => assert.fail(String(error)) },
        },
        store,
        takePrOptions,
      );

      assert.equal(acknowledged, true);
      assert.deepEqual(
        {
          status: store.getPendingTakePrRequest("request123")?.status,
          service: store.getPendingTakePrRequest("request123")?.selectedService,
          issueUrl: store.getPendingTakePrRequest("request123")?.linearIssueUrl,
        },
        {
          status: "completed",
          service: "service-a",
          issueUrl: "https://linear.app/example/issue/ENG-100/take-pr",
        },
      );
      assert.match(String(calls[0].args.text), /ENG-100.*service-a.*Existing PR/s);
    });
  });

  it("does not create an issue when service or WORKFLOW configuration is invalid", async () => {
    await withStore(async (store) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      let creations = 0;
      const takePrOptions = options({
        readWorkflow: async () => "---\ntracker:\n  provider: {}\n---\n",
        createLinearIssue: async () => {
          creations += 1;
          throw new Error("should not create");
        },
      });
      await createPending(store, calls, takePrOptions);
      calls.length = 0;
      const errors: unknown[] = [];

      await handleTakePrAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "request123:missing-service" } },
          client: fakeClient(calls),
          logger: { error: (error) => errors.push(error) },
        },
        store,
        takePrOptions,
      );
      await handleTakePrAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "request123:service-a" } },
          client: fakeClient(calls),
          logger: { error: (error) => errors.push(error) },
        },
        store,
        { ...takePrOptions, linearTeams: {} },
      );
      await handleTakePrAction(
        {
          ack: async () => {},
          action: { selected_option: { value: "request123:service-a" } },
          client: fakeClient(calls),
          logger: { error: (error) => errors.push(error) },
        },
        store,
        takePrOptions,
      );

      assert.equal(creations, 0);
      assert.equal(store.getPendingTakePrRequest("request123")?.status, "pending");
      assert.match(String(calls[0].args.text), /Service is not enabled/);
      assert.match(String(calls[1].args.text), /Linear configuration is incomplete/);
      assert.match(String(calls[2].args.text), /tracker\.provider\.project_slug/);
      assert.equal(errors.length, 2);
    });
  });
});

function options(overrides: Partial<TakePrOptions> = {}): TakePrOptions {
  return {
    services: [
      { name: "service-a", url: "https://service.test/state", linearTeam: "workspace-a-eng" },
    ],
    linearTeams: {
      "workspace-a-eng": {
        apiKey: "lin_test",
        teamId: "team-a",
        statuses: ["Todo", "In Progress", "Done"],
      },
    },
    symphoniesDirectory: "/workspace/symphonies",
    findPullRequest: async () => pullRequest,
    createRequestId: () => "request123",
    readWorkflow: async () => `---
tracker:
  kind: linear
  provider:
    project_slug: project-123
---
`,
    ...overrides,
  };
}

async function createPending(
  store: Parameters<typeof handleTakePrMention>[4],
  calls: Array<{ method: string; args: Record<string, unknown> }>,
  takePrOptions: TakePrOptions,
): Promise<void> {
  await handleTakePrMention(
    { channel: "C123", ts: "10.000", user: "U123" },
    [pullRequest.url],
    fakeClient(calls),
    { error: (error) => assert.fail(String(error)) },
    store,
    takePrOptions,
  );
}
