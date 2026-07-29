import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffSnapshots } from "./diff.ts";

const baseConfig = {
  linearTeams: {
    "workspace-a-eng": {
      apiKey: "lin_test",
      teamId: "team-a",
      baseUrl: "https://linear.app/example/issue",
      statuses: ["Todo", "In Progress", "Done"],
    },
  },
  services: [
    {
      name: "serviceA",
      url: "http://127.0.0.1:5103/api/v1/state",
      linearTeam: "workspace-a-eng",
    },
  ],
};

describe("diffSnapshots", () => {
  it("reports newly running issues", () => {
    const current = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-62",
            issue_url: "https://linear.app/example/issue/ENG-62/example",
            state: "In Progress",
            last_event: "notification",
            last_event_at: "2026-06-12T05:34:32Z",
            last_message: "agent message streaming: checking files",
            workspace_path: "/tmp/example-workspaces/ENG-62",
            started_at: "2026-06-12T05:30:00Z",
            turn_count: 7,
            tokens: { input_tokens: 1_200, output_tokens: 800, total_tokens: 2_000 },
          },
        ],
        retrying: [],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots({}, current, baseConfig), [
      {
        type: "started",
        service: "serviceA",
        issueIdentifier: "ENG-62",
        issueUrl: "https://linear.app/example/issue/ENG-62/example",
        state: "In Progress",
        message: "agent message streaming: checking files",
        workspacePath: "/tmp/example-workspaces/ENG-62",
        startedAt: "2026-06-12T05:30:00Z",
        turnCount: 7,
        tokens: { input: 1_200, output: 800, total: 2_000 },
        lastEvent: "notification",
        lastEventAt: "2026-06-12T05:34:32Z",
        activity: "agent message streaming: checking files",
      },
    ]);
  });

  it("does not report a new event when only activity changes within the same issue status", () => {
    const previous = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-62",
            state: "In Progress",
            last_event: "notification",
            last_event_at: "2026-06-12T05:34:32Z",
            last_message: "agent message streaming: checking files",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-62",
            state: "In Progress",
            last_event: "notification",
            last_event_at: "2026-06-12T05:35:32Z",
            last_message: "command output streaming: vitest run",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots(previous, current, baseConfig), []);
  });

  it("reports a new event when a running issue changes tracker status", () => {
    const previous = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-62",
            state: "Todo",
            last_message: "command output streaming: setup",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-62",
            state: "In Progress",
            last_message: "command output streaming: vitest run",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots(previous, current, baseConfig), [
      {
        type: "updated",
        service: "serviceA",
        issueIdentifier: "ENG-62",
        issueUrl: "https://linear.app/example/issue/ENG-62",
        state: "In Progress",
        message: "command output streaming: vitest run",
        activity: "command output streaming: vitest run",
      },
    ]);
  });

  it("does not report updates when only volatile message ids change", () => {
    const previous = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-65",
            state: "Todo",
            last_event: "notification",
            last_event_at: "2026-06-12T22:52:32Z",
            last_message: "item completed: agent message (msg_03b991a6)",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-65",
            state: "Todo",
            last_event: "notification",
            last_event_at: "2026-06-12T22:53:05Z",
            last_message: "item completed: agent message (msg_04c771b2)",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots(previous, current, baseConfig), []);
  });

  it("adds a Linear URL fallback when the API omits issue_url", () => {
    const current = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-65",
            state: "Todo",
            last_event: "notification",
            last_message: "item started: command execution (call_kJKoEgi, inprogress)",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };

    assert.equal(
      diffSnapshots({}, current, baseConfig)[0].issueUrl,
      "https://linear.app/example/issue/ENG-65",
    );
    assert.equal(diffSnapshots({}, current, baseConfig)[0].activity, "command execution started");
  });

  it("uses the referenced Linear team's URL fallback", () => {
    const current = {
      serviceB: {
        running: [{ issue_identifier: "ALT-77", state: "In Progress" }],
        retrying: [],
        blocked: [],
      },
    };
    const config = {
      linearTeams: {
        "workspace-b-eng": {
          apiKey: "lin_test",
          teamId: "team-b",
          baseUrl: "https://linear.app/example-two/issue",
          statuses: ["In Progress", "Done"],
        },
      },
      services: [
        {
          name: "serviceB",
          url: "http://127.0.0.1:5104/api/v1/state",
          linearTeam: "workspace-b-eng",
        },
      ],
    };

    assert.equal(
      diffSnapshots({}, current, config)[0].issueUrl,
      "https://linear.app/example-two/issue/ALT-77",
    );
  });

  it("omits activity for generic completed agent message events", () => {
    const current = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-65",
            state: "Todo",
            last_event: "notification",
            last_message: "item completed: agent message (msg_03b991a6)",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };

    assert.equal(diffSnapshots({}, current, baseConfig)[0].activity, undefined);
  });

  it("does not report updates for timestamp-only running changes", () => {
    const previous = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-62",
            state: "In Progress",
            last_event: "notification",
            last_event_at: "2026-06-12T05:34:32Z",
            last_message: "command output streaming",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [
          {
            issue_identifier: "ENG-62",
            state: "In Progress",
            last_event: "notification",
            last_event_at: "2026-06-12T05:35:32Z",
            last_message: "command output streaming",
          },
        ],
        retrying: [],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots(previous, current, baseConfig), []);
  });

  it("does not report retry updates for due-at-only changes", () => {
    const previous = {
      serviceA: {
        running: [],
        retrying: [
          {
            issue_identifier: "ENG-63",
            attempt: 2,
            due_at: "2026-06-12T05:40:00Z",
            error: "agent exited",
          },
        ],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [],
        retrying: [
          {
            issue_identifier: "ENG-63",
            attempt: 2,
            due_at: "2026-06-12T05:40:30Z",
            error: "agent exited",
          },
        ],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots(previous, current, baseConfig), []);
  });

  it("does not report retry updates while the issue remains retrying", () => {
    const previous = {
      serviceA: {
        running: [],
        retrying: [{ issue_identifier: "ENG-63", attempt: 1, error: "first error" }],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [],
        retrying: [{ issue_identifier: "ENG-63", attempt: 2, error: "second error" }],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots(previous, current, baseConfig), []);
  });

  it("does not emit ended when a running issue moves into blocked", () => {
    const previous = {
      serviceA: {
        running: [{ issue_identifier: "ENG-64", state: "In Progress" }],
        retrying: [],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [],
        retrying: [],
        blocked: [
          { issue_identifier: "ENG-64", state: "In Progress", error: "waiting for user input" },
        ],
      },
    };

    assert.deepEqual(
      diffSnapshots(previous, current, baseConfig).map((event) => event.type),
      ["blocked"],
    );
  });

  it("reports retrying, blocked, and ended transitions", () => {
    const previous = {
      serviceA: {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [],
        retrying: [
          {
            issue_identifier: "ENG-63",
            issue_url: "https://linear.app/example/issue/ENG-63/example",
            attempt: 2,
            due_at: "2026-06-12T05:40:00Z",
            error: "agent exited",
          },
        ],
        blocked: [
          {
            issue_identifier: "ENG-64",
            issue_url: "https://linear.app/example/issue/ENG-64/example",
            state: "In Progress",
            error: "waiting for user input",
            blocked_at: "2026-06-12T05:36:00Z",
          },
        ],
      },
    };

    assert.deepEqual(
      diffSnapshots(previous, current, baseConfig).map((event) => event.type),
      ["retrying", "blocked", "ended"],
    );
  });

  it("reports watcher availability recovery instead of ending its synthetic task", () => {
    const previous = {
      serviceA: {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [
          {
            issue_identifier: "watcher:serviceA",
            state: "unavailable",
            error: "fetch failed",
          },
        ],
        blocked: [],
      },
    };
    const current = {
      serviceA: {
        running: [{ issue_identifier: "ENG-62", state: "In Progress" }],
        retrying: [],
        blocked: [],
      },
    };

    assert.deepEqual(diffSnapshots(previous, current, baseConfig), [
      {
        type: "recovered",
        service: "serviceA",
        issueIdentifier: "watcher:serviceA",
        state: "available",
      },
    ]);
  });
});
