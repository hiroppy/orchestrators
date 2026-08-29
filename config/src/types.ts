import type { ChatPostMessageArguments, WebClient } from "@slack/web-api";

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
  statusHooks?: StatusHookConfig[];
  monitors?: MonitorConfig[];
  slackCommands?: SlackCommandConfig[];
}

export interface SlackConfig {
  botToken?: string;
  appToken?: string;
  channelId?: string;
  defaultAssignees?: string[];
}

export interface ReviewCommentConfig {
  inReviewStatus: string;
  inProgressStatus: string;
  reviewReadyDelayMs?: number;
  symphonyGitHubLogins?: string[];
}

export interface PullRequestContext {
  url: string;
  number?: number | null;
  title?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
  mergeable?: string | null;
  labels?: string[];
  checks?: PullRequestCheckContext[];
}

export interface PullRequestCheckContext {
  name: string;
  workflowName?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
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
  pullRequest?: PullRequestContext;
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

export interface MonitorContext {
  event: "issue.monitored";
  service: string;
  issue: {
    identifier: string;
    url?: string;
    title?: string | null;
    status: string;
  };
  pullRequest: PullRequestContext;
  previousPullRequest: PullRequestContext;
}

export type MonitorHelpers = StatusHookHelpers;

export interface MonitorConfig {
  id: string;
  status: string;
  run: (context: MonitorContext, helpers: MonitorHelpers) => string | void | Promise<string | void>;
}

export interface SlackCommandContext {
  service: string;
  command: string;
  args: string[];
  user?: string;
  issue: {
    identifier: string;
    url?: string;
    title: string;
    status: string;
  };
  pullRequest?: PullRequestContext;
}

export interface SlackCommandHelpers {
  slack: {
    client: WebClient;
    channelId: string;
    messageTs: string;
    threadTs: string;
    postMessage: (message: StatusHookSlackPostMessage) => Promise<void>;
    postThreadMessage: (message: StatusHookSlackThreadMessage) => Promise<void>;
  };
}

export interface SlackCommandConfig {
  command: string;
  run: (
    context: SlackCommandContext,
    helpers: SlackCommandHelpers,
  ) => string | void | Promise<string | void>;
}

export interface WatcherSettings {
  endedTaskRetry?: {
    maxAttempts?: number;
    delayMs?: number;
  };
  reviewComment?: ReviewCommentConfig;
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
