import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseWorkflowFrontmatter,
  trackerStatesFromWorkflow,
  workflowPathFor,
} from "./workflow.ts";

describe("Symphony workflow", () => {
  it("parses the complete YAML frontmatter", () => {
    assert.deepEqual(
      parseWorkflowFrontmatter(`---
tracker:
  kind: linear
  provider:
    project_slug: project-123
  terminal_states:
    - Done
    - Ready for Release
---
Instructions
`),
      {
        tracker: {
          kind: "linear",
          provider: { project_slug: "project-123" },
          terminal_states: ["Done", "Ready for Release"],
        },
      },
    );
  });

  it("parses unterminated frontmatter like Symphony", () => {
    assert.deepEqual(
      parseWorkflowFrontmatter(`---
tracker:
  active_states: [Todo]
  terminal_states: [Done]
`),
      {
        tracker: {
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
      },
    );
  });

  it("rejects missing, malformed, and non-object frontmatter", () => {
    assert.equal(parseWorkflowFrontmatter("tracker:\n  kind: linear"), undefined);
    assert.equal(parseWorkflowFrontmatter("---\ntracker: [\n---\n"), undefined);
    assert.equal(parseWorkflowFrontmatter("---\n- tracker\n---\n"), undefined);
  });

  it("reads and validates active and terminal state names", () => {
    assert.deepEqual(
      trackerStatesFromWorkflow(`---
tracker:
  active_states: [Todo, " In Progress "]
  terminal_states: [Done, " Ready for Release "]
---
`),
      {
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Ready for Release"],
      },
    );
    assert.equal(trackerStatesFromWorkflow("---\ntracker: {}\n---\n"), undefined);
    assert.equal(
      trackerStatesFromWorkflow(
        "---\ntracker:\n  active_states: [Todo]\n  terminal_states: [Done, 123]\n---\n",
      ),
      undefined,
    );
    assert.equal(
      trackerStatesFromWorkflow(
        "---\ntracker:\n  active_states: [Todo]\n  terminal_states: [todo]\n---\n",
      ),
      undefined,
    );
  });

  it("resolves a service workflow without allowing traversal", () => {
    assert.equal(
      workflowPathFor("/app/symphonies", "service-a"),
      "/app/symphonies/service-a/elixir/WORKFLOW.md",
    );
    assert.equal(
      workflowPathFor("/app/symphonies", "..service"),
      "/app/symphonies/..service/elixir/WORKFLOW.md",
    );
    assert.throws(() => workflowPathFor("/app/symphonies", "../outside"), /cannot resolve outside/);
  });
});
