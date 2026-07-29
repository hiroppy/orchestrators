import { defineConfig } from "../config/define.ts";

export default defineConfig({
  linearTeams: {
    "test-workspace-eng": {
      apiKey: "lin_test",
      teamId: "test-team-id",
      baseUrl: "https://linear.app/test-workspace/issue",
    },
  },
  instances: {
    "test-service": {
      port: 4199,
      linearTeam: "test-workspace-eng",
    },
  },
});
