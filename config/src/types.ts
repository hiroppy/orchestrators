export type EventType = "started" | "updated" | "retrying" | "blocked" | "ended" | "recovered";

export interface LinearTeamConfig {
  apiKey: string;
  teamId: string;
  baseUrl?: string;
}

export interface InstanceConfig {
  port: number;
  linearTeam: string;
  enabled?: boolean;
}

export interface MentionConfig {
  target: string;
  statuses?: string[];
  events?: EventType[];
}

export interface SlackConfig {
  botToken?: string;
  appToken?: string;
  channelId?: string;
  mention?: MentionConfig;
}

export interface ReviewReactionConfig {
  inReviewStatus: string;
  inProgressStatus: string;
  reaction: string;
  maxRequeues: number;
}

export interface WatcherSettings {
  pollIntervalMs?: number;
  endedTaskRetry?: {
    maxAttempts?: number;
    delayMs?: number;
  };
  reviewReaction?: ReviewReactionConfig;
}

export interface OrchestratorConfig {
  instances: Record<string, InstanceConfig>;
  linearTeams: Record<string, LinearTeamConfig>;
  watcher?: WatcherSettings;
  slack?: SlackConfig;
}

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
