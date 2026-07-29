import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findPullRequest, findPullRequestByUrl, requireGitHubCli } from "./github.ts";

describe("requireGitHubCli", () => {
  it("accepts an installed and authenticated GitHub CLI", async () => {
    await requireGitHubCli(async (command, args, options) => {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["auth", "status"]);
      assert.equal(options.timeout, 10_000);
      return { stdout: "", stderr: "" };
    });
  });

  it("fails startup guidance when GitHub CLI is unavailable or unauthenticated", async () => {
    await assert.rejects(
      requireGitHubCli(async () => {
        throw new Error("not authenticated");
      }),
      /GitHub CLI is required.*gh auth login/,
    );
  });
});

describe("findPullRequest", () => {
  it("returns null when the event has no workspace path", async () => {
    const result = await findPullRequest(
      {},
      { execFile: async () => assert.fail("execFile should not be called") },
    );

    assert.equal(result, null);
  });

  it("returns null for Todo events", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "Todo", issueIdentifier: "ENG-65" },
      { execFile: async () => assert.fail("execFile should not be called for Todo") },
    );

    assert.equal(result, null);
  });

  it("returns PR metadata from gh pr view", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Progress", issueIdentifier: "ENG-65" },
      {
        execFile: async (command, args, options) => {
          assert.equal(command, "gh");
          assert.deepEqual(args, [
            "pr",
            "view",
            "--json",
            "url,number,state,isDraft,reviewDecision,headRefName",
          ]);
          assert.equal(options.cwd, "/tmp/repo");

          return {
            stdout: JSON.stringify({
              url: "https://github.com/example/example-service/pull/123",
              number: 123,
              state: "OPEN",
              isDraft: false,
              reviewDecision: "REVIEW_REQUIRED",
              headRefName: "eng-65-contact-form",
            }),
          };
        },
      },
    );

    assert.deepEqual(result, {
      url: "https://github.com/example/example-service/pull/123",
      number: 123,
      state: "OPEN",
      isDraft: false,
      reviewDecision: "REVIEW_REQUIRED",
      headRefName: "eng-65-contact-form",
    });
  });

  it("checks the configured reaction only when requested", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Review", issueIdentifier: "ENG-65" },
      {
        reaction: "👀",
        execFile: async (_command, args) => {
          assert.deepEqual(args, [
            "pr",
            "view",
            "--json",
            "url,number,state,isDraft,reviewDecision,headRefName,reactionGroups",
          ]);
          return {
            stdout: JSON.stringify({
              url: "https://github.com/example/service/pull/123",
              headRefName: "eng-65-contact-form",
              reactionGroups: [
                { content: "THUMBS_UP", users: { totalCount: 2 } },
                { content: "EYES", users: { totalCount: 1 } },
              ],
            }),
          };
        },
      },
    );

    assert.equal(result?.hasConfiguredReaction, true);
  });

  it("returns null when gh finds a PR for a stale branch", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Progress", issueIdentifier: "ENG-65" },
      {
        execFile: async () => ({
          stdout: JSON.stringify({
            url: "https://github.com/example/worker-service/pull/91",
            number: 91,
            state: "OPEN",
            isDraft: true,
            reviewDecision: "",
            headRefName: "fix/issue-86-clear-stale-subagents",
          }),
        }),
      },
    );

    assert.equal(result, null);
  });

  it("does not match an issue identifier that is only a numeric prefix", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Progress", issueIdentifier: "ENG-6" },
      {
        execFile: async () => ({
          stdout: JSON.stringify({
            url: "https://github.com/example/worker-service/pull/65",
            headRefName: "eng-65-another-issue",
          }),
        }),
      },
    );

    assert.equal(result, null);
  });

  it("returns null when gh cannot find a pull request", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo" },
      {
        execFile: async () => {
          throw new Error("no pull requests found");
        },
      },
    );

    assert.equal(result, null);
  });
});

describe("findPullRequestByUrl", () => {
  it("loads reaction metadata from an attached pull request URL", async () => {
    const url = "https://github.com/example/service/pull/123";
    const result = await findPullRequestByUrl(url, {
      reaction: "👀",
      execFile: async (command, args, options) => {
        assert.equal(command, "gh");
        assert.deepEqual(args, [
          "pr",
          "view",
          url,
          "--json",
          "url,number,state,isDraft,reviewDecision,headRefName,reactionGroups",
        ]);
        assert.equal(options.cwd, undefined);
        return {
          stdout: JSON.stringify({
            url,
            number: 123,
            reactionGroups: [{ content: "EYES", users: { totalCount: 0 } }],
          }),
        };
      },
    });

    assert.equal(result?.hasConfiguredReaction, false);
  });

  it("maps a configured emoji to GitHub reaction content", async () => {
    const result = await findPullRequestByUrl("https://github.com/example/service/pull/123", {
      reaction: "🚀",
      execFile: async () => ({
        stdout: JSON.stringify({
          url: "https://github.com/example/service/pull/123",
          reactionGroups: [{ content: "ROCKET", users: { totalCount: 1 } }],
        }),
      }),
    });

    assert.equal(result?.hasConfiguredReaction, true);
  });
});
