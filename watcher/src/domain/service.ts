import type { LinearTeamConfig } from "orchestrator-config";

export interface ResolvedLinearTeamConfig extends LinearTeamConfig {
  statuses: string[];
}

export interface ServiceDefinition {
  name: string;
  url: string;
  linearTeam: string;
  activeStates?: string[];
  terminalStates?: string[];
}
