import type {
  LinearTeamConfig,
  MonitorConfig,
  SlackCommandConfig,
  StatusHookConfig,
} from "orchestrator-config";

export interface ResolvedLinearTeamConfig extends LinearTeamConfig {
  statuses: string[];
}

export interface ServiceDefinition {
  name: string;
  url: string;
  linearTeam: string;
  statusHooks?: StatusHookConfig[];
  monitors?: MonitorConfig[];
  slackCommands?: SlackCommandConfig[];
  activeStates?: string[];
  terminalStates?: string[];
}
