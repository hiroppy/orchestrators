import { defineConfig } from "orchestrator-config";

export default defineConfig({
  watcher: {
    // Requeues a Linear issue when a new inline review comment appears on its GitHub PR.
    // Remove this block to disable comment-based requeueing.
    reviewComment: {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
    },
    // Put local TypeScript hooks in ./hooks and import them from config.ts.
    // A hook's returned string is posted back to the task's Slack thread.
    // Failed hooks are attempted 10 times by default; set maxAttempts per hook to override it.
    statusHooks: [],
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN ?? "", // xoxb-...
    appToken: process.env.SLACK_APP_TOKEN ?? "", // xapp-...
    channelId: process.env.SLACK_CHANNEL_ID ?? "",
    defaultAssignees: ["<@UXXXXXXXX>"],
    notifications: {
      statuses: ["In Review"],
      events: ["blocked"],
    },
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
    },
  },
});
