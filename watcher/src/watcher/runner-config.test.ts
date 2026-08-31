import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveWatcherConfig } from "../config/runtime.ts";
import { requireSlackBotUserId } from "./start-watcher.ts";
import {
  resolveLinearWorkflowStatuses,
  resolveSymphonyWorkflowSettings,
} from "./runtime-config.ts";
import { baseConfig, linearTeams } from "./runner.test-support.ts";

function configWithService(overrides: object) {
  const config = baseConfig();
  return {
    ...config,
    instances: {
      "service-a": { ...config.instances["service-a"], ...overrides },
    },
  };
}

describe("requireSlackBotUserId", () => {
  it("requires Slack to return the bot identity before message consumption starts", async () => {
    assert.equal(
      await requireSlackBotUserId({
        auth: {
          async test() {
            return { user_id: "UBOT" };
          },
        },
      } as never),
      "UBOT",
    );
    await assert.rejects(
      requireSlackBotUserId({
        auth: {
          async test() {
            return {};
          },
        },
      } as never),
      /did not return a bot user ID/,
    );
  });
});

describe("watcher configuration", () => {
  it("resolves and validates pull request status sync", async () => {
    const config = resolveWatcherConfig(
      {
        ...baseConfig(),
        watcher: { pullRequestStatusSync: { closed: " canceled " } },
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.pullRequestStatusSync, { closed: "canceled" });
    assert.deepEqual(
      resolveWatcherConfig(baseConfig(), { requireSlack: false }).pullRequestStatusSync,
      { closed: "Canceled" },
    );
    for (const pullRequestStatusSync of [null, {}, { closed: " " }]) {
      assert.throws(
        () =>
          resolveWatcherConfig(
            {
              ...baseConfig(),
              watcher: { pullRequestStatusSync: pullRequestStatusSync as never },
            },
            { requireSlack: false },
          ),
        /watcher\.pullRequestStatusSync/,
      );
    }
    await assert.rejects(
      resolveLinearWorkflowStatuses(config, async () => ["Todo", "Done"]),
      /watcher\.pullRequestStatusSync\.closed references unknown Linear status "canceled"/,
    );
    const resolved = await resolveLinearWorkflowStatuses(config, async () => ["Todo", "Canceled"]);
    assert.deepEqual(resolved.pullRequestStatusSync, { closed: "canceled" });
  });

  it("uses the service's explicit Linear team ID", () => {
    const config = resolveWatcherConfig(
      {
        linearTeams: {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
          },
        },
        instances: {
          "service-a": {
            port: 4101,
            linearTeam: "workspace-a-eng",
          },
        },
      },
      { requireSlack: false },
    );

    assert.equal(config.linearTeams[config.services[0].linearTeam].teamId, "team-a");
    assert.equal(config.services[0].url, "http://127.0.0.1:4101/api/v1/state");
  });

  it("uses the centrally resolved Slack config", () => {
    assert.deepEqual(
      resolveWatcherConfig(
        {
          ...baseConfig(),
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            channelId: "C123",
          },
        },
        { requireSlack: true },
      ).slack,
      {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        channelId: "C123",
      },
    );
  });

  it("resolves and validates default assignees", () => {
    const config = resolveWatcherConfig(
      {
        ...baseConfig(),
        slack: {
          defaultAssignees: ["<@U123>", "<!SUBTEAM^S123|reviewers>"],
        },
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.defaultAssignees, ["<@U123>", "<!SUBTEAM^S123|reviewers>"]);
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            slack: { defaultAssignees: [123] },
          } as never,
          { requireSlack: false },
        ),
      /defaultAssignees must contain only Slack user or user group mentions/,
    );
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            slack: { defaultAssignees: ["<!subteam^s123>"] },
          },
          { requireSlack: false },
        ),
      /defaultAssignees must contain only Slack user or user group mentions/,
    );
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            slack: { defaultAssignees: [`<@${"X".repeat(2_001)}>`] },
          },
          { requireSlack: false },
        ),
      /defaultAssignees must not exceed 2000 characters combined/,
    );
  });

  it("loads workflow statuses from Linear and validates status-based rules", async () => {
    const unresolved = resolveWatcherConfig(
      {
        linearTeams: {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-id",
          },
        },
        instances: {
          "service-a": {
            port: 4101,
            linearTeam: "workspace-a-eng",
          },
        },
      },
      { requireSlack: false },
    );
    const calls = [];
    const resolved = await resolveLinearWorkflowStatuses(unresolved, async (teamId, options) => {
      calls.push({ teamId, options });
      return ["Todo", "In Progress", "In Review", "Done", "Canceled"];
    });

    assert.deepEqual(calls, [{ teamId: "team-id", options: { apiKey: "lin_test" } }]);
    assert.deepEqual(resolved.linearTeams["workspace-a-eng"].statuses, [
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
    ]);

    await assert.rejects(
      resolveLinearWorkflowStatuses(unresolved, async () => [
        "Canceled",
        ...Array.from({ length: 100 }, (_, index) => `Status ${index}`),
      ]),
      /cannot contain more than 100 statuses/,
    );
  });

  it("loads active and terminal state overrides from each Symphony workflow", async () => {
    const unresolved = resolveWatcherConfig(baseConfig(), { requireSlack: false });
    const paths: string[] = [];
    const resolved = await resolveSymphonyWorkflowSettings(
      unresolved,
      "/app/symphonies",
      async (path) => {
        paths.push(path);
        return `---
tracker:
  active_states: [Todo, In Progress]
  terminal_states: [Done, Ready for Release]
---
`;
      },
    );

    assert.deepEqual(paths, ["/app/symphonies/service-a/elixir/WORKFLOW.md"]);
    assert.deepEqual(resolved.services[0].activeStates, ["Todo", "In Progress"]);
    assert.deepEqual(resolved.services[0].terminalStates, ["Done", "Ready for Release"]);
  });

  it("validates workflow state overrides against the service's Linear team", async () => {
    const unresolved = resolveWatcherConfig(baseConfig(), { requireSlack: false });
    const withOverrides = {
      ...unresolved,
      services: unresolved.services.map((service) => ({
        ...service,
        activeStates: ["Todo", "Merging"],
        terminalStates: ["Done", "Closed", "Cancelled"],
      })),
    };

    await resolveLinearWorkflowStatuses(withOverrides, async () => ["Todo", "Done", "Canceled"]);

    for (const [group, activeStates, terminalStates] of [
      ["active_states", ["Todo", "Ready for realease"], ["Done"]],
      ["terminal_states", ["Todo"], ["Done", "Ready for realease"]],
    ] as const) {
      await assert.rejects(
        resolveLinearWorkflowStatuses(
          {
            ...withOverrides,
            services: withOverrides.services.map((service) => ({
              ...service,
              activeStates,
              terminalStates,
            })),
          },
          async () => ["Todo", "Done", "Canceled"],
        ),
        new RegExp(`${group} references unknown Linear status "Ready for realease" for service-a`),
      );
    }
  });

  it("requires valid review comment settings", () => {
    const config = resolveWatcherConfig(
      {
        ...baseConfig(),
        watcher: {
          reviewComment: {
            inReviewStatus: " In Review ",
            inProgressStatus: " In Progress ",
            reviewReadyDelayMs: 5_000,
            symphonyGitHubLogins: [" symphony-bot ", "symphony-bot"],
          },
        },
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.reviewComment, {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
      reviewReadyDelayMs: 5_000,
      symphonyGitHubLogins: ["symphony-bot"],
    });

    assert.equal(
      resolveWatcherConfig(
        {
          ...baseConfig(),
          watcher: {
            reviewComment: {
              inReviewStatus: "In Review",
              inProgressStatus: "In Progress",
            },
          },
        },
        { requireSlack: false },
      ).reviewComment?.reviewReadyDelayMs,
      10 * 60 * 1_000,
    );
    assert.equal(
      resolveWatcherConfig(
        {
          ...baseConfig(),
          watcher: {
            reviewComment: {
              inReviewStatus: "In Review",
              inProgressStatus: "In Progress",
              reviewReadyDelayMs: 0,
            },
          },
        },
        { requireSlack: false },
      ).reviewComment?.reviewReadyDelayMs,
      0,
    );

    for (const reviewComment of [
      { inReviewStatus: "", inProgressStatus: "In Progress" },
      { inReviewStatus: "In Review", inProgressStatus: "" },
      { inReviewStatus: " ", inProgressStatus: "In Progress" },
      { inReviewStatus: "In Review", inProgressStatus: " " },
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        symphonyGitHubLogins: [" "],
      },
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        reviewReadyDelayMs: -1,
      },
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        reviewReadyDelayMs: Number.POSITIVE_INFINITY,
      },
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        reviewReadyDelayMs: "5000" as never,
      },
      {
        inReviewStatus: "In Review",
        inProgressStatus: "In Progress",
        reviewReadyDelayMs: false as never,
      },
    ]) {
      assert.throws(
        () =>
          resolveWatcherConfig(
            {
              ...baseConfig(),
              watcher: { reviewComment },
            },
            { requireSlack: false },
          ),
        /watcher\.reviewComment/,
      );
    }
  });

  it("resolves and validates global In Review reminder settings", () => {
    assert.deepEqual(
      resolveWatcherConfig(
        { ...baseConfig(), watcher: { inReviewReminder: {} } },
        { requireSlack: false },
      ).inReviewReminder,
      {
        status: "In Review",
        afterDays: 4,
        postAt: "09:00",
        timeZone: "Asia/Tokyo",
      },
    );

    for (const inReviewReminder of [
      { afterDays: 0 },
      { afterDays: 1.5 },
      { postAt: "9:00" },
      { postAt: "24:00" },
      { postAt: " " },
      { status: " " },
      { timeZone: " " },
      { timeZone: "Not/A_Zone" },
    ]) {
      assert.throws(
        () =>
          resolveWatcherConfig(
            { ...baseConfig(), watcher: { inReviewReminder } },
            { requireSlack: false },
          ),
        /watcher\.inReviewReminder/,
      );
    }
  });

  it("resolves and validates TypeScript status hooks", async () => {
    const run = () => "ready";
    const config = resolveWatcherConfig(
      {
        ...configWithService({
          statusHooks: [{ id: " app-distribution ", status: " In Review ", run }],
        }),
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.services[0].statusHooks, [
      { id: "app-distribution", status: "In Review", maxAttempts: 10, run },
    ]);
    await assert.rejects(
      resolveLinearWorkflowStatuses(config, async () => [
        "Todo",
        "In Progress",
        "Done",
        "Canceled",
      ]),
      /instances\.service-a\.statusHooks\[0\]\.status references unknown Linear status "In Review"/,
    );
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...configWithService({
              statusHooks: [{ id: "broken", status: "In Review" } as never],
            }),
          },
          { requireSlack: false },
        ),
      /instances\.service-a\.statusHooks\[0\]\.run must be a function/,
    );
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...configWithService({ statusHooks: [{ status: "In Review", run } as never] }),
          },
          { requireSlack: false },
        ),
      /instances\.service-a\.statusHooks\[0\]\.id must be a non-empty string/,
    );
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...configWithService({
              statusHooks: [
                { id: "duplicate", status: "In Review", run },
                { id: "duplicate", status: "Done", run },
              ],
            }),
          },
          { requireSlack: false },
        ),
      /instances\.service-a\.statusHooks\[1\]\.id must be unique/,
    );
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...configWithService({
              statusHooks: [{ id: "invalid-attempts", status: "In Review", maxAttempts: 0, run }],
            }),
          },
          { requireSlack: false },
        ),
      /instances\.service-a\.statusHooks\[0\]\.maxAttempts must be a positive integer/,
    );
  });

  it("resolves and validates pull request monitors", async () => {
    const run = () => "changed";
    const config = resolveWatcherConfig(
      {
        ...configWithService({
          pullRequestMonitors: [{ id: " review-progress ", run }],
        }),
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.services[0].pullRequestMonitors, [{ id: "review-progress", run }]);
    for (const pullRequestMonitors of [
      [{ id: "", run }],
      [{ id: 42, run }],
      [{ id: true, run }],
      [
        { id: "duplicate", run },
        { id: "duplicate", run },
      ],
      [{ id: "broken" }],
    ]) {
      assert.throws(
        () =>
          resolveWatcherConfig(
            { ...configWithService({ pullRequestMonitors: pullRequestMonitors as never }) },
            { requireSlack: false },
          ),
        /instances\.service-a\.pullRequestMonitors/,
      );
    }
  });

  it("resolves and validates service-specific Slack commands", () => {
    const run = () => "preview ready";
    const config = resolveWatcherConfig(
      {
        ...configWithService({
          slackCommands: [{ command: " Preview-Env ", run }],
        }),
      },
      { requireSlack: false },
    );

    assert.deepEqual(config.services[0].slackCommands, [
      {
        command: "preview-env",
        run,
      },
    ]);
    for (const slackCommands of [
      [{ command: "help", run }],
      [{ command: "not_valid", run }],
      [
        { command: "preview", run },
        { command: "PREVIEW", run },
      ],
      [{ command: "preview" }],
    ]) {
      assert.throws(
        () =>
          resolveWatcherConfig(
            { ...configWithService({ slackCommands: slackCommands as never }) },
            { requireSlack: false },
          ),
        /instances\.service-a\.slackCommands\[\d+\]/,
      );
    }
  });

  it("rejects duplicate ports and non-boolean enabled values", () => {
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            linearTeams: linearTeams(),
            instances: {
              "service-a": { port: 4101, linearTeam: "workspace-a-eng" },
              "service-b": { port: 4101, linearTeam: "workspace-a-eng" },
            },
          },
          { requireSlack: false },
        ),
      /duplicate ports/,
    );

    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            linearTeams: linearTeams(),
            instances: {
              "service-a": {
                port: 4101,
                linearTeam: "workspace-a-eng",
                enabled: "false",
              },
            },
          } as never,
          { requireSlack: false },
        ),
      /enabled must be a boolean/,
    );
  });

  it("validates port and retry boundaries", () => {
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            instances: {
              "service-a": { port: 0, linearTeam: "workspace-a-eng" },
            },
          },
          { requireSlack: false },
        ),
      /port must be an integer from 1 to 65535/,
    );

    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            watcher: {
              endedTaskRetry: { maxAttempts: 0 },
            },
          },
          { requireSlack: false },
        ),
      /maxAttempts must be a positive integer/,
    );

    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            ...baseConfig(),
            watcher: {
              endedTaskRetry: { delayMs: -1 },
            },
          },
          { requireSlack: false },
        ),
      /delayMs must be zero or greater/,
    );

    const config = resolveWatcherConfig(
      {
        ...baseConfig(),
        watcher: {
          endedTaskRetry: { maxAttempts: 1, delayMs: 0 },
        },
        instances: {
          "service-a": { port: 65_535, linearTeam: "workspace-a-eng" },
        },
      },
      { requireSlack: false },
    );
    assert.equal(config.services[0].url, "http://127.0.0.1:65535/api/v1/state");
    assert.equal(config.pollIntervalMs, 3_000);
  });

  it("rejects instances that reference an unknown Linear team", () => {
    assert.throws(
      () =>
        resolveWatcherConfig(
          {
            linearTeams: linearTeams(),
            instances: {
              "service-a": {
                port: 4101,
                linearTeam: "missing-team",
              },
            },
          },
          { requireSlack: false },
        ),
      /must reference a configured Linear team/,
    );
  });
});
