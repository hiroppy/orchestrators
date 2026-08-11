import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLinearTakePrIssue } from "./linear.ts";

const input = {
  teamId: "team-a",
  projectSlug: "project-123",
  title: "既存PRを更新: Fix widget",
  description: "PR metadata and instructions",
};

describe("createLinearTakePrIssue", () => {
  it("validates the team and project before creating the issue in In Progress", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      if (requests.length === 1) {
        return Response.json({
          data: {
            team: {
              id: "team-a",
              states: { nodes: [{ id: "state-progress", name: "In Progress" }] },
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
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              identifier: "ENG-100",
              url: "https://linear.app/example/issue/ENG-100/take-pr",
              state: { name: "In Progress" },
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
    assert.deepEqual(requests[1].variables, {
      teamId: "team-a",
      projectId: "project-id",
      stateId: "state-progress",
      title: input.title,
      description: input.description,
    });
  });

  it("does not create an issue for a missing project, team mismatch, or missing state", async (context) => {
    const cases = [
      {
        projects: { nodes: [] },
        states: [{ id: "state-progress", name: "In Progress" }],
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
        states: [{ id: "state-progress", name: "In Progress" }],
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
        states: [{ id: "state-todo", name: "Todo" }],
        error: /no In Progress state/,
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
