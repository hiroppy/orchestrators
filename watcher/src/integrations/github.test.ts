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
            "url,number,title,body,state,isDraft,reviewDecision,mergeable,headRefName,headRefOid,baseRefName,labels",
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
              mergeable: "CONFLICTING",
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
      mergeable: "CONFLICTING",
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
        symphonyGitHubLogins: ["symphony-bot"],
        execFile: async (_command, args) => {
          if (args[0] === "api") {
            assert.equal(args[1], "graphql");
            assert.ok(args.includes("owner=example"));
            assert.ok(args.includes("repo=service"));
            assert.ok(args.includes("number=123"));
            assert.match(args.at(-1) ?? "", /reviewThreads/);
            return {
              stdout: JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      author: { login: "pull-request-author" },
                      reviewThreads: {
                        nodes: [
                          {
                            isResolved: true,
                            isOutdated: false,
                            comments: { nodes: [{ createdAt: "2026-08-15T07:00:00Z" }] },
                          },
                          {
                            isResolved: false,
                            isOutdated: true,
                            comments: { nodes: [{ createdAt: "2026-08-15T06:30:00Z" }] },
                          },
                          {
                            isResolved: false,
                            isOutdated: false,
                            comments: {
                              nodes: [
                                {
                                  author: { login: "reviewer" },
                                  createdAt: "2026-08-15T06:02:10Z",
                                },
                                {
                                  author: { login: "pull-request-author" },
                                  createdAt: "2026-08-15T06:05:00Z",
                                },
                                {
                                  author: { login: "SYMPHONY-BOT" },
                                  createdAt: "2026-08-15T06:06:00Z",
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            };
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

  it("ignores comments added to resolved review threads", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Review", issueIdentifier: "ENG-65" },
      {
        includeLatestReviewComment: true,
        execFile: async (_command, args) => ({
          stdout:
            args[0] === "api"
              ? JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        reviewThreads: {
                          nodes: [
                            {
                              isResolved: true,
                              isOutdated: false,
                              comments: { nodes: [{ createdAt: "2026-08-15T07:00:00Z" }] },
                            },
                          ],
                        },
                      },
                    },
                  },
                })
              : JSON.stringify({
                  url: "https://github.com/example/service/pull/123",
                  number: 123,
                  headRefName: "eng-65-contact-form",
                }),
        }),
      },
    );

    assert.equal(result?.latestReviewCommentAt, null);
  });

  it("ignores comments in outdated review threads", async () => {
    const result = await findPullRequest(
      { workspacePath: "/tmp/repo", state: "In Review", issueIdentifier: "ENG-65" },
      {
        includeLatestReviewComment: true,
        execFile: async (_command, args) => ({
          stdout:
            args[0] === "api"
              ? JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        reviewThreads: {
                          nodes: [
                            {
                              isResolved: false,
                              isOutdated: true,
                              comments: { nodes: [{ createdAt: "2026-08-15T07:00:00Z" }] },
                            },
                          ],
                        },
                      },
                    },
                  },
                })
              : JSON.stringify({
                  url: "https://github.com/example/service/pull/123",
                  number: 123,
                  headRefName: "eng-65-contact-form",
                }),
        }),
      },
    );

    assert.equal(result?.latestReviewCommentAt, null);
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
