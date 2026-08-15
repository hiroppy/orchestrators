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
            "url,number,title,body,state,isDraft,reviewDecision,headRefName,headRefOid,baseRefName,labels",
          ]);
          assert.equal(options.cwd, "/tmp/repo");

          return {
            stdout: JSON.stringify({
              url: "https://github.com/example/example-service/pull/123",
              number: 123,
              title: "Add the contact form",
              state: "OPEN",
              isDraft: false,
              reviewDecision: "REVIEW_REQUIRED",
              headRefName: "eng-65-contact-form",
              headRefOid: "abc123",
              labels: [{ name: "stg-deploy" }, { name: "symphony" }],
            }),
          };
        },
      },
    );

    assert.deepEqual(result, {
      url: "https://github.com/example/example-service/pull/123",
      number: 123,
      title: "Add the contact form",
      body: null,
      state: "OPEN",
      isDraft: false,
      reviewDecision: "REVIEW_REQUIRED",
      headRefName: "eng-65-contact-form",
      headRefOid: "abc123",
      baseRefName: null,
      repository: "example/example-service",
      labels: ["stg-deploy", "symphony"],
    });
  });

  it("loads the latest inline review comment when requested", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Review", issueIdentifier: "ENG-65" },
      {
        includeLatestReviewComment: true,
        execFile: async (_command, args) => {
          if (args[0] === "api") {
            assert.deepEqual(args, [
              "api",
              "repos/example/service/pulls/123/comments?sort=created&direction=desc&per_page=1",
            ]);
            return { stdout: JSON.stringify([{ created_at: "2026-08-15T06:02:10Z" }]) };
          }
          return {
            stdout: JSON.stringify({
              url: "https://github.com/example/service/pull/123",
              number: 123,
              headRefName: "eng-65-contact-form",
              labels: [{ name: "stg-deploy" }],
            }),
          };
        },
      },
    );

    assert.equal(result?.latestReviewCommentAt, "2026-08-15T06:02:10Z");
    assert.deepEqual(result?.labels, ["stg-deploy"]);
  });

  it("keeps the pull request when loading its latest comment fails", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Review", issueIdentifier: "ENG-65" },
      {
        includeLatestReviewComment: true,
        execFile: async (_command, args) => {
          if (args[0] === "api") throw new Error("GitHub API unavailable");
          return {
            stdout: JSON.stringify({
              url: "https://github.com/example/service/pull/123",
              number: 123,
              headRefName: "eng-65-contact-form",
            }),
          };
        },
      },
    );

    assert.equal(result?.url, "https://github.com/example/service/pull/123");
    assert.equal(result?.latestReviewCommentAt, null);
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
  it("represents a PR with no inline comments", async () => {
    const url = "https://github.com/example/service/pull/123";
    const result = await findPullRequestByUrl(url, {
      includeLatestReviewComment: true,
      execFile: async (command, args, options) => {
        assert.equal(command, "gh");
        if (args[0] === "api") return { stdout: "[]" };
        assert.equal(options.cwd, undefined);
        return {
          stdout: JSON.stringify({
            url,
            number: 123,
            labels: [{ name: "symphony" }],
          }),
        };
      },
    });

    assert.equal(result?.latestReviewCommentAt, null);
    assert.deepEqual(result?.labels, ["symphony"]);
  });

  it("normalizes missing labels to an empty list", async () => {
    const result = await findPullRequestByUrl("https://github.com/example/service/pull/123", {
      execFile: async () => ({
        stdout: JSON.stringify({ url: "https://github.com/example/service/pull/123" }),
      }),
    });

    assert.deepEqual(result?.labels, []);
  });
});
