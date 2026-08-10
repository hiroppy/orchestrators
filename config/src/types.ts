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

export interface MentionsConfig {
  targets?: string[];
  statuses?: string[];
  events?: EventType[];
}

export interface SlackConfig {
  botToken?: string;
  appToken?: string;
  channelId?: string;
  mentions?: MentionsConfig;
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
  };
}

export interface StatusHookHelpers {
  slack: {
    postMessage: (text: string, options?: StatusHookSlackMessageOptions) => Promise<void>;
    postThreadMessage: (
      text: string,
      options?: StatusHookSlackThreadMessageOptions,
    ) => Promise<void>;
  };
}

export interface StatusHookSlackMessageOptions {
  blocks?: unknown[];
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
  mrkdwn?: boolean;
}

export interface StatusHookSlackThreadMessageOptions extends StatusHookSlackMessageOptions {
  replyBroadcast?: boolean;
}

export interface StatusHookConfig {
  status: string;
  run: (
    context: StatusHookContext,
    helpers: StatusHookHelpers,
  ) => string | void | Promise<string | void>;
  timeoutMs?: number;
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
