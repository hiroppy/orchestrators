import assert from "node:assert/strict";

import type { WatcherStore } from "../persistence/store.ts";
import { fakeClient } from "./app.test-support.ts";
import { handleTakePrMention, type TakePrOptions } from "./take-pr.ts";

export const pullRequest = {
  url: "https://github.com/example/widget/pull/42",
  number: 42,
  title: "Fix the widget",
  body: "## Summary\n\nFixes the widget regression.",
  repository: "example/widget",
  headRefName: "fix/widget",
  baseRefName: "main",
  state: "OPEN",
};

export function takePrOptions(overrides: Partial<TakePrOptions> = {}): TakePrOptions {
  return {
    authorizedChannelId: "C123",
    services: [
      { name: "service-a", url: "https://service.test/state", linearTeam: "workspace-a-eng" },
    ],
    linearTeams: {
      "workspace-a-eng": {
        apiKey: "lin_test",
        teamId: "team-a",
        statuses: ["Todo", "In Progress", "Done"],
      },
    },
    symphoniesDirectory: "/workspace/symphonies",
    findPullRequest: async () => pullRequest,
    createRequestId: () => "request123",
    readWorkflow: async () => `---
tracker:
  kind: linear
  provider:
    project_slug: project-123
---
`,
    ...overrides,
  };
}

export async function createPending(
  store: WatcherStore,
  calls: Array<{ method: string; args: Record<string, unknown> }>,
  options: TakePrOptions,
): Promise<void> {
  await handleTakePrMention(
    { channel: "C123", ts: "10.000", user: "U123" },
    [pullRequest.url],
    fakeClient(calls),
    { error: (error) => assert.fail(String(error)) },
    store,
    options,
  );
}

export function selectionBody(serviceIndex = 0, userId = "U123"): unknown {
  return {
    user: { id: userId },
    state: {
      values: {
        "take-pr:request123": {
          take_pr_service_select: {
            selected_option: { value: `request123:i${serviceIndex}` },
          },
        },
      },
    },
  };
}
