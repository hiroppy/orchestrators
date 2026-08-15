import { LINEAR_WORKFLOW_STATE_TYPES } from "orchestrator-config";

import type {
  EventType,
  InstanceConfig,
  LinearTeamConfig,
  LinearWorkflowStateType,
  NotificationsConfig,
  OrchestratorConfig,
  ResolvedLinearTeamConfig,
  ReviewReactionConfig,
  ServiceDefinition,
  SlackConfig,
  StatusHookConfig,
} from "../domain/types.ts";
import { isSlackAssigneeMention } from "../domain/slack-assignee.ts";
import { normalizeStatus } from "../domain/status.ts";

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_ENDED_TASK_MAX_ATTEMPTS = 2;
const DEFAULT_ENDED_TASK_RETRY_DELAY_MS = 5_000;
const DEFAULT_STATUS_HOOK_MAX_ATTEMPTS = 10;
const MAX_ASSIGNEES_LENGTH = 2_000;
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

export interface ResolvedNotificationConfig {
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
  statusHooks: ResolvedStatusHookConfig[];
  statusTypeOverrides: Record<string, LinearWorkflowStateType>;
  defaultAssignees: string[];
  notifications?: ResolvedNotificationConfig;
  slack?: ResolvedSlackConfig;
}

export interface ResolvedWatcherRuntimeConfig extends Omit<WatcherRuntimeConfig, "linearTeams"> {
  linearTeams: Record<string, ResolvedLinearTeamConfig>;
}

interface ResolvedReviewReactionConfig extends ReviewReactionConfig {
  reaction: string;
}

export type ResolvedStatusHookConfig = StatusHookConfig;

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
  const endedTaskRetry = {
    maxAttempts: Number(
      config.watcher?.endedTaskRetry?.maxAttempts ?? DEFAULT_ENDED_TASK_MAX_ATTEMPTS,
    ),
    delayMs: Number(config.watcher?.endedTaskRetry?.delayMs ?? DEFAULT_ENDED_TASK_RETRY_DELAY_MS),
  };

  validateEndedTaskRetry(endedTaskRetry);
  const reviewReaction = resolveReviewReactionConfig(config.watcher?.reviewReaction);
  const statusHooks = resolveStatusHooks(config.watcher?.statusHooks);
  const statusTypeOverrides = resolveStatusTypeOverrides(config.watcher?.statusTypeOverrides);

  return {
    services,
    linearTeams: referencedLinearTeams(config.linearTeams, instances),
    pollIntervalMs: POLL_INTERVAL_MS,
    endedTaskRetry,
    reviewReaction,
    statusHooks,
    statusTypeOverrides,
    defaultAssignees: resolveDefaultAssignees(config.slack?.defaultAssignees),
    notifications: resolveNotificationConfig(config.slack?.notifications),
    slack: resolveSlackConfig(config.slack, requireSlack),
  };
}

function resolveStatusTypeOverrides(
  overrides: Record<string, LinearWorkflowStateType> | undefined,
): Record<string, LinearWorkflowStateType> {
  if (overrides === undefined) return {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("watcher.statusTypeOverrides must be an object.");
  }
  const entries = Object.entries(overrides).map(
    ([status, stateType]) => [normalizeStatus(status), stateType] as const,
  );
  validateStatuses(
    "watcher.statusTypeOverrides",
    entries.map(([status]) => status),
  );
  for (const [status, stateType] of entries) {
    if (!LINEAR_WORKFLOW_STATE_TYPES.includes(stateType)) {
      throw new Error(
        `watcher.statusTypeOverrides[${JSON.stringify(status)}] must be a valid Linear workflow state type.`,
      );
    }
  }
  return Object.fromEntries(entries);
}

function resolveStatusHooks(config: StatusHookConfig[] | undefined): ResolvedStatusHookConfig[] {
  if (config === undefined) return [];
  if (!Array.isArray(config)) {
    throw new Error("watcher.statusHooks must be an array.");
  }

  const ids = new Set<string>();
  return config.map((hook, index) => {
    const label = `watcher.statusHooks[${index}]`;
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
      throw new Error(`${label} must be an object.`);
    }
    const id = hook.id?.trim();
    if (!id) throw new Error(`${label}.id must be a non-empty string.`);
    if (ids.has(id)) throw new Error(`${label}.id must be unique: ${id}`);
    ids.add(id);
    const status = hook.status?.trim();
    if (!status) throw new Error(`${label}.status must be a non-empty string.`);
    const maxAttempts = hook.maxAttempts ?? DEFAULT_STATUS_HOOK_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`${label}.maxAttempts must be a positive integer.`);
    }
    if (typeof hook.run !== "function") throw new Error(`${label}.run must be a function.`);
    return { id, status, maxAttempts, run: hook.run };
  });
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

function resolveDefaultAssignees(assignees: string[] | undefined): string[] {
  if (assignees === undefined) return [];
  if (
    !Array.isArray(assignees) ||
    assignees.some((assignee) => !isSlackAssigneeMention(assignee))
  ) {
    throw new Error("slack.defaultAssignees must contain only Slack user or user group mentions.");
  }
  if (assignees.join(" ").length > MAX_ASSIGNEES_LENGTH) {
    throw new Error(
      `slack.defaultAssignees must not exceed ${MAX_ASSIGNEES_LENGTH} characters combined.`,
    );
  }
  return [...new Set(assignees)];
}

function resolveNotificationConfig(
  notification: NotificationsConfig | undefined,
): ResolvedNotificationConfig | undefined {
  if (!notification) return undefined;

  const statuses = notification.statuses ?? [];
  const events = notification.events ?? [];
  if (!Array.isArray(statuses)) {
    throw new Error("slack.notifications.statuses must be an array.");
  }
  if (!Array.isArray(events)) {
    throw new Error("slack.notifications.events must be an array.");
  }
  validateStatuses("slack.notifications.statuses", statuses);

  const unknownEvents = events.filter((event) => !EVENT_TYPES.includes(event));
  if (unknownEvents.length > 0) {
    throw new Error(
      `slack.notifications.events contains unknown events: ${unknownEvents.join(", ")}`,
    );
  }

  return { statuses, events };
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
