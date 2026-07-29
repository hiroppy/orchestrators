import type {
  EventType,
  InstanceConfig,
  LinearTeamConfig,
  MentionConfig,
  OrchestratorConfig,
  ResolvedLinearTeamConfig,
  ReviewReactionConfig,
  ServiceDefinition,
  SlackConfig,
} from "../domain/types.ts";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_ENDED_TASK_MAX_ATTEMPTS = 2;
const DEFAULT_ENDED_TASK_RETRY_DELAY_MS = 5_000;
const OBSERVABILITY_PATH = "/api/v1/state";
const EVENT_TYPES: EventType[] = [
  "started",
  "updated",
  "retrying",
  "blocked",
  "ended",
  "recovered",
];

interface ResolvedSlackConfig {
  botToken: string;
  appToken: string;
  channelId: string;
}

export interface ResolvedMentionConfig {
  target: string;
  statuses: string[];
  events: EventType[];
}

export interface WatcherRuntimeConfig {
  services: ServiceDefinition[];
  linearTeams: Record<string, LinearTeamConfig>;
  pollIntervalMs: number;
  endedTaskRetry: {
    maxAttempts: number;
    delayMs: number;
  };
  reviewReaction?: ResolvedReviewReactionConfig;
  mention?: ResolvedMentionConfig;
  slack?: ResolvedSlackConfig;
}

export interface ResolvedWatcherRuntimeConfig extends Omit<WatcherRuntimeConfig, "linearTeams"> {
  linearTeams: Record<string, ResolvedLinearTeamConfig>;
}

interface ResolvedReviewReactionConfig extends ReviewReactionConfig {
  reaction: string;
}

export interface SupervisorInstance {
  name: string;
  port: number;
  linearApiKey: string;
}

interface ResolveWatcherOptions {
  requireSlack: boolean;
}

interface ResolvedInstance {
  name: string;
  instance: InstanceConfig;
  linearTeam: LinearTeamConfig;
}

export function resolveWatcherConfig(
  config: OrchestratorConfig,
  { requireSlack }: ResolveWatcherOptions,
): WatcherRuntimeConfig {
  const instances = resolveEnabledInstances(config);
  const services = instances.map(({ name, instance }) => ({
    name,
    url: observabilityUrl(instance.port),
    linearTeam: instance.linearTeam,
  }));
  const pollIntervalMs = Number(config.watcher?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const endedTaskRetry = {
    maxAttempts: Number(
      config.watcher?.endedTaskRetry?.maxAttempts ?? DEFAULT_ENDED_TASK_MAX_ATTEMPTS,
    ),
    delayMs: Number(config.watcher?.endedTaskRetry?.delayMs ?? DEFAULT_ENDED_TASK_RETRY_DELAY_MS),
  };

  validatePollInterval(pollIntervalMs);
  validateEndedTaskRetry(endedTaskRetry);
  const reviewReaction = resolveReviewReactionConfig(config.watcher?.reviewReaction);

  return {
    services,
    linearTeams: referencedLinearTeams(config.linearTeams, instances),
    pollIntervalMs,
    endedTaskRetry,
    reviewReaction,
    mention: resolveMentionConfig(config.slack?.mention),
    slack: resolveSlackConfig(config.slack, requireSlack),
  };
}

function resolveReviewReactionConfig(
  config: ReviewReactionConfig | undefined,
): ResolvedReviewReactionConfig | undefined {
  if (!config) return undefined;

  const inReviewStatus = config.inReviewStatus?.trim();
  const inProgressStatus = config.inProgressStatus?.trim();
  const reaction = config.reaction?.trim();
  if (!inReviewStatus) {
    throw new Error("watcher.reviewReaction.inReviewStatus must be a non-empty string.");
  }
  if (!inProgressStatus) {
    throw new Error("watcher.reviewReaction.inProgressStatus must be a non-empty string.");
  }
  if (!reaction) {
    throw new Error("watcher.reviewReaction.reaction must be a non-empty string.");
  }
  if (!Number.isInteger(config.maxRequeues) || config.maxRequeues < 1) {
    throw new Error("watcher.reviewReaction.maxRequeues must be a positive integer.");
  }

  return { inReviewStatus, inProgressStatus, reaction, maxRequeues: config.maxRequeues };
}

export function resolveSupervisorConfig(config: OrchestratorConfig): SupervisorInstance[] {
  return resolveEnabledInstances(config).map(({ name, instance, linearTeam }) => ({
    name,
    port: instance.port,
    linearApiKey: linearTeam.apiKey,
  }));
}

function resolveEnabledInstances(config: OrchestratorConfig): ResolvedInstance[] {
  if (
    !config.instances ||
    typeof config.instances !== "object" ||
    Array.isArray(config.instances)
  ) {
    throw new Error("config.instances must be an object of named instances.");
  }
  if (
    !config.linearTeams ||
    typeof config.linearTeams !== "object" ||
    Array.isArray(config.linearTeams)
  ) {
    throw new Error("config.linearTeams must be an object of named Linear teams.");
  }

  const entries = Object.entries(config.instances).filter(
    ([, instance]) => instance?.enabled !== false,
  );
  if (entries.length === 0) {
    throw new Error("config.instances must contain at least one enabled instance.");
  }

  const resolved = entries.map(([name, instance]) => {
    validateInstance(name, instance);
    const linearTeam = config.linearTeams[instance.linearTeam];
    if (!linearTeam) {
      throw new Error(`Instance ${name} must reference a configured Linear team via linearTeam.`);
    }
    validateLinearTeam(instance.linearTeam, linearTeam);
    return { name, instance, linearTeam };
  });

  const ports = resolved.map(({ instance }) => instance.port);
  if (new Set(ports).size !== ports.length) {
    throw new Error("Enabled instances cannot contain duplicate ports.");
  }

  return resolved;
}

function referencedLinearTeams(
  linearTeams: Record<string, LinearTeamConfig>,
  instances: ResolvedInstance[],
): Record<string, LinearTeamConfig> {
  return Object.fromEntries(
    [...new Set(instances.map(({ instance }) => instance.linearTeam))].map((teamId) => [
      teamId,
      linearTeams[teamId],
    ]),
  );
}

function resolveMentionConfig(
  mention: MentionConfig | undefined,
): ResolvedMentionConfig | undefined {
  if (!mention) return undefined;

  const target = mention.target?.trim();
  if (!target) throw new Error("slack.mention.target must be a non-empty Slack mention.");

  const statuses = mention.statuses ?? [];
  const events = mention.events ?? [];
  if (!Array.isArray(statuses)) {
    throw new Error("slack.mention.statuses must be an array.");
  }
  if (!Array.isArray(events)) {
    throw new Error("slack.mention.events must be an array.");
  }
  validateStatuses("slack.mention.statuses", statuses);

  const unknownEvents = events.filter((event) => !EVENT_TYPES.includes(event));
  if (unknownEvents.length > 0) {
    throw new Error(`slack.mention.events contains unknown events: ${unknownEvents.join(", ")}`);
  }

  return { target, statuses, events };
}

function resolveSlackConfig(
  slack: SlackConfig | undefined,
  required: boolean,
): ResolvedSlackConfig | undefined {
  const values = {
    botToken: slack?.botToken,
    appToken: slack?.appToken,
    channelId: slack?.channelId,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => `slack.${name}`);

  if (missing.length > 0) {
    if (!required) return undefined;
    throw new Error(`Missing required config values: ${missing.join(", ")}`);
  }

  return values as ResolvedSlackConfig;
}

function validateInstance(name: string, instance: InstanceConfig): void {
  if (!name.trim()) throw new Error("config.instances names must not be empty.");
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    throw new Error(`config.instances.${name} must be an object.`);
  }
  if (!Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65_535) {
    throw new Error(`Instance ${name} port must be an integer from 1 to 65535.`);
  }
  if (!instance.linearTeam?.trim()) {
    throw new Error(`Instance ${name} must define linearTeam.`);
  }
  if (instance.enabled !== undefined && typeof instance.enabled !== "boolean") {
    throw new Error(`Instance ${name} enabled must be a boolean.`);
  }
}

function validateLinearTeam(teamId: string, team: LinearTeamConfig): void {
  if (!teamId.trim()) throw new Error("config.linearTeams IDs must not be empty.");
  if (!team || typeof team !== "object" || Array.isArray(team)) {
    throw new Error(`config.linearTeams.${teamId} must be an object.`);
  }
  if (!team.apiKey?.trim()) {
    throw new Error(`config.linearTeams.${teamId}.apiKey must be a non-empty string.`);
  }
  if (!team.teamId?.trim()) {
    throw new Error(`config.linearTeams.${teamId}.teamId must be a non-empty string.`);
  }
}

function validatePollInterval(pollIntervalMs: number): void {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 5_000) {
    throw new Error("watcher.pollIntervalMs must be at least 5000.");
  }
}

function validateEndedTaskRetry(retry: { maxAttempts: number; delayMs: number }): void {
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw new Error("watcher.endedTaskRetry.maxAttempts must be a positive integer.");
  }
  if (!Number.isFinite(retry.delayMs) || retry.delayMs < 0) {
    throw new Error("watcher.endedTaskRetry.delayMs must be zero or greater.");
  }
}

export function validateStatuses(label: string, statuses: string[]): void {
  if (statuses.length > 100) {
    throw new Error(`${label} cannot contain more than 100 statuses.`);
  }
  if (new Set(statuses).size !== statuses.length) {
    throw new Error(`${label} cannot contain duplicate statuses.`);
  }
  if (statuses.some((status) => !status.trim() || status.length > 75)) {
    throw new Error(`${label} must contain non-empty names no longer than 75 characters.`);
  }
}

function observabilityUrl(port: number): string {
  return `http://127.0.0.1:${port}${OBSERVABILITY_PATH}`;
}
