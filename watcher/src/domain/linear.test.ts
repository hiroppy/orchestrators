import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effectiveLinearStateType } from "./linear.ts";

describe("effectiveLinearStateType", () => {
  const activeStates = ["Todo", "In Progress"];
  const terminalStates = ["Done", "In Staging Check"];

  it("uses Symphony terminal states to override the Linear state type", () => {
    assert.equal(
      effectiveLinearStateType("In Staging Check", "started", activeStates, terminalStates),
      "completed",
    );
  });

  it("uses Symphony active states to override a terminal Linear state type", () => {
    assert.equal(
      effectiveLinearStateType("In Progress", "completed", activeStates, terminalStates),
      "started",
    );
  });

  it("falls back to the Linear state type for unclassified states", () => {
    assert.equal(
      effectiveLinearStateType("In Review", "started", activeStates, terminalStates),
      "started",
    );
    assert.equal(
      effectiveLinearStateType("Canceled", "canceled", activeStates, terminalStates),
      "canceled",
    );
  });
});
