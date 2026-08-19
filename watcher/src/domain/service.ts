import type { LinearTeamConfig, SlackCommandConfig, StatusHookConfig } from "orchestrator-config";

export interface ResolvedLinearTeamConfig extends LinearTeamConfig {
  statuses: string[];
}

export interface ServiceDefinition {
  name: string;
  url: string;
  linearTeam: string;
  statusHooks?: StatusHookConfig[];
  slackCommands?: SlackCommandConfig[];
  activeStates?: string[];
  terminalStates?: string[];
}
