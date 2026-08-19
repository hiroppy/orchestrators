import type { LinearTeamConfig, StatusHookConfig } from "orchestrator-config";

export interface ResolvedLinearTeamConfig extends LinearTeamConfig {
  statuses: string[];
}

export interface ServiceDefinition {
  name: string;
  url: string;
  linearTeam: string;
  statusHooks?: StatusHookConfig[];
  activeStates?: string[];
  terminalStates?: string[];
}
