import type { ChatPostMessageArguments } from "@slack/web-api";

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

export interface NotificationsConfig {
  statuses?: string[];
  events?: EventType[];
}

export interface SlackConfig {
  botToken?: string;
  appToken?: string;
  channelId?: string;
  defaultAssignees?: string[];
  notifications?: NotificationsConfig;
}

export interface ReviewReactionConfig {
  inReviewStatus: string;
  inProgressStatus: string;
  reaction: string;
  maxRequeues: number;
}

export interface StatusHookContext {
  event: "issue.status_changed";
  service: string;
  issue: {
    identifier: string;
    url?: string;
    title?: string | null;
  };
  transition: {
    from: string;
    to: string;
  };
  pullRequest?: {
    url: string;
    number?: number | null;
    title?: string | null;
    state?: string | null;
    isDraft?: boolean | null;
    reviewDecision?: string | null;
    headRefName?: string | null;
    headRefOid?: string | null;
    labels?: string[];
  };
}

export interface StatusHookHelpers {
  slack: {
    postMessage: (message: StatusHookSlackPostMessage) => Promise<void>;
    postThreadMessage: (message: StatusHookSlackThreadMessage) => Promise<void>;
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K & keyof T> : never;

export type StatusHookSlackPostMessage = DistributiveOmit<
  ChatPostMessageArguments,
  "channel" | "thread_ts" | "reply_broadcast" | "token"
>;

export type StatusHookSlackThreadMessage = DistributiveOmit<
  ChatPostMessageArguments,
  "channel" | "thread_ts" | "token"
>;

export interface StatusHookConfig {
  id: string;
  status: string;
  maxAttempts?: number;
  run: (
    context: StatusHookContext,
    helpers: StatusHookHelpers,
  ) => string | void | Promise<string | void>;
}

export interface WatcherSettings {
  pollIntervalMs?: number;
  endedTaskRetry?: {
    maxAttempts?: number;
    delayMs?: number;
  };
  reviewReaction?: ReviewReactionConfig;
  statusHooks?: StatusHookConfig[];
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
