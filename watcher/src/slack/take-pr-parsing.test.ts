import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGitHubPullRequestUrl } from "./take-pr-parsing.ts";

describe("take-pr parsing", () => {
  it("accepts GitHub PR URLs and Slack-formatted links", () => {
    assert.equal(
      parseGitHubPullRequestUrl("https://github.com/example/widget/pull/42"),
      "https://github.com/example/widget/pull/42",
    );
    assert.equal(
      parseGitHubPullRequestUrl(
        "<https://github.com/example/widget/pull/42|github.com/example/widget/pull/42>",
      ),
      "https://github.com/example/widget/pull/42",
    );
  });

  it("rejects non-PR, non-GitHub, query, fragment, and zero-number URLs", () => {
    for (const value of [
      "https://github.com/example/widget/issues/42",
      "https://example.com/example/widget/pull/42",
      "https://github.com/example/widget/pull/42?diff=split",
      "https://github.com/example/widget/pull/42#discussion",
      "https://github.com/example/widget/pull/0",
      "not-a-url",
    ]) {
      assert.equal(parseGitHubPullRequestUrl(value), undefined, value);
    }
  });
});
