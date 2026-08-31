import { defineConfig } from "orchestrator-config";

export default defineConfig({
  watcher: {
    // Posts a daily summary of stale In Review tasks to the global Slack channel.
    inReviewReminder: {
      status: "In Review",
      afterDays: 4,
      postAt: "09:00",
      timeZone: "Asia/Tokyo",
    },
    // Requeues a Linear issue when a new inline review comment appears on its GitHub PR.
    // Remove this block to disable comment-based requeueing.
    reviewComment: {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
      reviewReadyDelayMs: 10 * 60 * 1_000,
      symphonyGitHubLogins: ["your-symphony-account"],
    },
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN ?? "", // xoxb-...
    appToken: process.env.SLACK_APP_TOKEN ?? "", // xapp-...
    channelId: process.env.SLACK_CHANNEL_ID ?? "",
    defaultAssignees: ["<@UXXXXXXXX>"],
  },
  linearTeams: {
    "workspace-a-eng": {
      apiKey: process.env.LINEAR_API_KEY_WORKSPACE_A_ENG ?? "",
      teamId: process.env.LINEAR_TEAM_ID_WORKSPACE_A_ENG ?? "",
      baseUrl: "https://linear.app/workspace-a/issue",
    },
  },
  instances: {
    "service-a": {
      enabled: true,
      port: 4105,
      linearTeam: "workspace-a-eng",
      // Put local TypeScript hooks in ./hooks and import them from config.ts.
      statusHooks: [],
      // Run every 30 seconds for active tracked tasks with a pull request.
      pullRequestMonitors: [],
      // Put local TypeScript commands in ./commands and import them from config.ts.
      // They run only when mentioned from a tracked task thread for this service.
      slackCommands: [],
    },
  },
});
