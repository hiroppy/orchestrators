import type { InstanceConfig, LinearTeamConfig, OrchestratorConfig } from "../domain/types.ts";

type InstanceWithLinearTeam<TLinear extends Record<string, LinearTeamConfig>> = Omit<
  InstanceConfig,
  "linearTeam"
> & { linearTeam: Extract<keyof TLinear, string> };

export type OrchestratorConfigInput<TLinear extends Record<string, LinearTeamConfig>> = Omit<
  OrchestratorConfig,
  "linearTeams" | "instances"
> & {
  linearTeams: TLinear;
  instances: Record<string, InstanceWithLinearTeam<TLinear>>;
};

export function defineConfig<const TLinear extends Record<string, LinearTeamConfig>>(
  config: OrchestratorConfigInput<TLinear>,
): OrchestratorConfig {
  return config;
}
