import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AmbiguousLinearTakePrIssueError, createLinearTakePrIssue } from "./take-pr.ts";

const input = {
  idempotencyKey: "request123",
  teamId: "team-a",
  projectSlug: "project-123",
  title: "既存PRを更新: Fix widget",
  description: "PR metadata and instructions",
  pullRequestTitle: "Fix widget",
  pullRequestUrl: "https://github.com/example/widget/pull/42",
};

describe("createLinearTakePrIssue", () => {
  it("validates the team and project before creating the issue in Todo", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      if (requests.length === 1) {
        return Response.json({
          data: {
            team: {
              id: "team-a",
              states: { nodes: [{ id: "state-todo", name: "Todo" }] },
            },
            projects: {
              nodes: [
                {
                  id: "project-id",
                  name: "Project",
                  slugId: "project-123",
                  teams: { nodes: [{ id: "team-a" }] },
                },
              ],
            },
          },
        });
      }
      if (requests.length === 2) return Response.json({ data: { issue: null } });
      if (requests.length === 4) return attachmentResponse();
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              identifier: "ENG-100",
              url: "https://linear.app/example/issue/ENG-100/take-pr",
              state: { name: "Todo" },
            },
          },
        },
      });
    });

    assert.deepEqual(await createLinearTakePrIssue(input, { apiKey: "lin_test" }), {
      identifier: "ENG-100",
      url: "https://linear.app/example/issue/ENG-100/take-pr",
    });
    assert.deepEqual(requests[0].variables, {
      teamId: "team-a",
      projectSlug: "project-123",
    });
    assert.match(requests[1].variables.issueId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(requests[2].variables, {
      issueId: requests[1].variables.issueId,
      teamId: "team-a",
      projectId: "project-id",
      stateId: "state-todo",
      title: input.title,
      description: input.description,
    });
    assert.deepEqual(requests[3].variables, {
      issueId: requests[1].variables.issueId,
      title: input.pullRequestTitle,
      url: input.pullRequestUrl,
    });
  });

  it("uses the stable project slug ID when deriving the issue ID", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      if (request.query.includes("TakePrTarget")) {
        return Response.json({
          data: {
            team: {
              id: "team-a",
              states: { nodes: [{ id: "state-todo", name: "Todo" }] },
            },
            projects: {
              nodes: [
                {
                  id: "project-id",
                  slugId: "f96dc363d974",
                  teams: { nodes: [{ id: "team-a" }] },
                },
              ],
            },
          },
        });
      }
      if (request.query.includes("query OrchestratorWatcherTakePrIssue")) {
        return Response.json({ data: { issue: null } });
      }
      if (request.query.includes("TakePrAttachmentCreate")) return attachmentResponse();
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              identifier: "ENG-100",
              url: "https://linear.app/example/issue/ENG-100/take-pr",
              state: { name: "Todo" },
            },
          },
        },
      });
    });

    await createLinearTakePrIssue(
      { ...input, projectSlug: "orchestrators-f96dc363d974" },
      { apiKey: "lin_test" },
    );
    await createLinearTakePrIssue(
      { ...input, projectSlug: "renamed-f96dc363d974" },
      { apiKey: "lin_test" },
    );

    assert.equal(requests[0].variables.projectSlug, "f96dc363d974");
    assert.equal(requests[2].variables.projectId, "project-id");
    assert.equal(requests[2].variables.issueId, requests[6].variables.issueId);
  });

  it("creates the issue when Linear reports that the idempotency issue does not exist", async (context) => {
    let requests = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      if (requests === 1) return takePrTargetResponse();
      if (requests === 2) {
        return Response.json({ errors: [{ message: "Entity not found: Issue" }] });
      }
      if (requests === 4) return attachmentResponse();
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              identifier: "ENG-100",
              url: "https://linear.app/example/issue/ENG-100/take-pr",
              state: { name: "Todo" },
            },
          },
        },
      });
    });

    assert.deepEqual(await createLinearTakePrIssue(input, { apiKey: "lin_test" }), {
      identifier: "ENG-100",
      url: "https://linear.app/example/issue/ENG-100/take-pr",
    });
    assert.equal(requests, 4);
  });

  it("reconciles an ambiguously successful create mutation by its stable issue ID", async (context) => {
    let requests = 0;
    let issueId: string | undefined;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      requests += 1;
      const request = JSON.parse(String(options?.body));
      if (requests === 1) return takePrTargetResponse();
      if (requests === 2) {
        issueId = request.variables.issueId;
        return Response.json({ data: { issue: null } });
      }
      if (requests === 3) throw new TypeError("connection lost after commit");
      assert.equal(request.variables.issueId, issueId);
      if (requests === 5) return attachmentResponse();
      return Response.json({
        data: {
          issue: {
            identifier: "ENG-100",
            url: "https://linear.app/example/issue/ENG-100/take-pr",
            state: { name: "In Review" },
          },
        },
      });
    });

    assert.deepEqual(await createLinearTakePrIssue(input, { apiKey: "lin_test" }), {
      identifier: "ENG-100",
      url: "https://linear.app/example/issue/ENG-100/take-pr",
    });
    assert.equal(requests, 5);
  });

  it("restores a missing pull request attachment for an existing issue", async (context) => {
    const requests: Array<{ variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      if (requests.length === 1) return takePrTargetResponse();
      if (requests.length === 2) {
        return Response.json({
          data: {
            issue: {
              identifier: "ENG-100",
              url: "https://linear.app/example/issue/ENG-100/take-pr",
              state: { name: "In Progress" },
            },
          },
        });
      }
      return attachmentResponse();
    });

    await createLinearTakePrIssue(input, { apiKey: "lin_test" });

    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].variables, {
      issueId: requests[1].variables.issueId,
      title: input.pullRequestTitle,
      url: input.pullRequestUrl,
    });
  });

  it("does not duplicate the pull request attachment when retrying an existing issue", async (context) => {
    let requests = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      if (requests === 1) return takePrTargetResponse();
      return Response.json({
        data: {
          issue: {
            identifier: "ENG-100",
            url: "https://linear.app/example/issue/ENG-100/take-pr",
            attachments: { nodes: [{ url: input.pullRequestUrl }] },
            state: { name: "In Progress" },
          },
        },
      });
    });

    assert.deepEqual(await createLinearTakePrIssue(input, { apiKey: "lin_test" }), {
      identifier: "ENG-100",
      url: "https://linear.app/example/issue/ENG-100/take-pr",
    });
    assert.equal(requests, 2);
  });

  it("reports an ambiguous result when post-mutation reconciliation also fails", async (context) => {
    let requests = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      if (requests === 1) return takePrTargetResponse();
      if (requests === 2) return Response.json({ data: { issue: null } });
      throw new TypeError("Linear unavailable");
    });

    await assert.rejects(
      createLinearTakePrIssue(input, { apiKey: "lin_test" }),
      AmbiguousLinearTakePrIssueError,
    );
    assert.equal(requests, 4);
  });

  it("does not create an issue for a missing project, team mismatch, or missing state", async (context) => {
    const cases = [
      {
        projects: { nodes: [] },
        states: [{ id: "state-todo", name: "Todo" }],
        error: /project not found/,
      },
      {
        projects: {
          nodes: [
            {
              id: "project-id",
              slugId: "project-123",
              teams: { nodes: [{ id: "other-team" }] },
            },
          ],
        },
        states: [{ id: "state-todo", name: "Todo" }],
        error: /not associated/,
      },
      {
        projects: {
          nodes: [
            {
              id: "project-id",
              slugId: "project-123",
              teams: { nodes: [{ id: "team-a" }] },
            },
          ],
        },
        states: [{ id: "state-progress", name: "In Progress" }],
        error: /no Todo state/,
      },
    ];

    for (const testCase of cases) {
      let requests = 0;
      context.mock.method(globalThis, "fetch", async () => {
        requests += 1;
        return Response.json({
          data: {
            team: { id: "team-a", states: { nodes: testCase.states } },
            projects: testCase.projects,
          },
        });
      });
      await assert.rejects(createLinearTakePrIssue(input, { apiKey: "lin_test" }), testCase.error);
      assert.equal(requests, 1);
      context.mock.restoreAll();
    }
  });
});

function takePrTargetResponse(): Response {
  return Response.json({
    data: {
      team: {
        id: "team-a",
        states: { nodes: [{ id: "state-todo", name: "Todo" }] },
      },
      projects: {
        nodes: [
          {
            id: "project-id",
            name: "Project",
            slugId: "project-123",
            teams: { nodes: [{ id: "team-a" }] },
          },
        ],
      },
    },
  });
}

function attachmentResponse(): Response {
  return Response.json({ data: { attachmentCreate: { success: true } } });
}
