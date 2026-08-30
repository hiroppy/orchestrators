import type {
  LinearTeamConfig,
  PullRequestStatusSyncConfig,
  ReviewCommentConfig,
  StatusHookConfig,
} from "orchestrator-config";
import type { ResolvedLinearTeamConfig, ServiceDefinition } from "../domain/service.ts";

export interface ResolvedSlackConfig {
  botToken: string;
  appToken: string;
  channelId: string;
}

export interface WatcherRuntimeConfig {
  services: ServiceDefinition[];
  linearTeams: Record<string, LinearTeamConfig>;
  pollIntervalMs: number;
  endedTaskRetry: { maxAttempts: number; delayMs: number };
  pullRequestStatusSync?: PullRequestStatusSyncConfig;
  reviewComment?: ReviewCommentConfig;
  defaultAssignees: string[];
  slack?: ResolvedSlackConfig;
}

export interface ResolvedWatcherRuntimeConfig extends Omit<WatcherRuntimeConfig, "linearTeams"> {
  linearTeams: Record<string, ResolvedLinearTeamConfig>;
}

export type ResolvedStatusHookConfig = StatusHookConfig;

export interface SupervisorInstance {
  name: string;
  port: number;
  linearApiKey: string;
}
