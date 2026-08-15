import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  effectiveLinearStateType,
  enteredTerminalLinearState,
  isTerminalLinearState,
} from "./linear.ts";

describe("Linear terminal states", () => {
  it("recognizes every built-in terminal state type", () => {
    for (const stateType of ["completed", "canceled", "duplicate"]) {
      assert.equal(isTerminalLinearState(stateType, "Any status", []), true);
    }
    for (const stateType of ["triage", "backlog", "unstarted", "started", undefined]) {
      assert.equal(isTerminalLinearState(stateType, "In Progress", []), false);
    }
  });

  it("overrides every supported workflow state category by status name", () => {
    const statusTypeOverrides = {
      triage: "triage",
      backlog: "backlog",
      planned: "unstarted",
      developing: "started",
      released: "completed",
      rejected: "canceled",
    };

    for (const [status, expectedType] of Object.entries(statusTypeOverrides)) {
      assert.equal(effectiveLinearStateType("started", status, statusTypeOverrides), expectedType);
    }
    assert.equal(
      effectiveLinearStateType("started", " released ", statusTypeOverrides),
      "completed",
    );
    assert.equal(effectiveLinearStateType("started", "Unlisted", statusTypeOverrides), "started");
    assert.equal(effectiveLinearStateType("started", "  ", statusTypeOverrides), "started");
    assert.equal(isTerminalLinearState("started", "Released", statusTypeOverrides), true);
    assert.equal(isTerminalLinearState("completed", "Developing", statusTypeOverrides), false);
  });

  it("ignores inherited properties when no override is configured", () => {
    assert.equal(effectiveLinearStateType("started", "constructor", {}), "started");
    assert.equal(effectiveLinearStateType("started", "__proto__", {}), "started");
  });

  it("announces only transitions from nonterminal to terminal", () => {
    const statusTypeOverrides = {
      "in staging check": "completed",
      released: "completed",
    };
    const cases = [
      {
        name: "configured terminal status",
        previous: ["started", "In Review"],
        current: ["started", "In Staging Check"],
        expected: true,
      },
      {
        name: "built-in terminal type",
        previous: ["started", "In Review"],
        current: ["completed", "Done"],
        expected: true,
      },
      {
        name: "same configured terminal status",
        previous: ["started", "In Staging Check"],
        current: ["started", "In Staging Check"],
        expected: false,
      },
      {
        name: "configured terminal to built-in terminal",
        previous: ["started", "In Staging Check"],
        current: ["completed", "Done"],
        expected: false,
      },
      {
        name: "nonterminal transition",
        previous: ["unstarted", "Todo"],
        current: ["started", "In Progress"],
        expected: false,
      },
    ] as const;

    for (const testCase of cases) {
      assert.equal(
        enteredTerminalLinearState(
          testCase.previous[0],
          testCase.current[0],
          testCase.previous[1],
          testCase.current[1],
          statusTypeOverrides,
        ),
        testCase.expected,
        testCase.name,
      );
    }
  });
});
