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
    - In Staging Check
---
Instructions
`),
      {
        tracker: {
          kind: "linear",
          provider: { project_slug: "project-123" },
          terminal_states: ["Done", "In Staging Check"],
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
  terminal_states: [Done, " In Staging Check "]
---
`),
      {
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "In Staging Check"],
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
      workflowPathFor("/app/symphonies", "iiba"),
      "/app/symphonies/iiba/elixir/WORKFLOW.md",
    );
    assert.throws(() => workflowPathFor("/app/symphonies", "../outside"), /cannot resolve outside/);
  });
});
