import {
  DEFAULT_REVIEW_READY_DELAY_MS,
  type InstanceConfig,
  type LinearTeamConfig,
  type OrchestratorConfig,
  type ReviewCommentConfig,
  type SlackConfig,
  type SlackCommandConfig,
  type StatusHookConfig,
} from "orchestrator-config";

import { isSlackAssigneeMention } from "../slack/assignee.ts";
import type {
  ResolvedSlackConfig,
  SupervisorInstance,
  WatcherRuntimeConfig,
} from "./runtime-types.ts";
import { validateEndedTaskRetry, validateInstance, validateLinearTeam } from "./validation.ts";

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_ENDED_TASK_MAX_ATTEMPTS = 2;
const DEFAULT_ENDED_TASK_RETRY_DELAY_MS = 5_000;
const DEFAULT_STATUS_HOOK_MAX_ATTEMPTS = 10;
const MAX_ASSIGNEES_LENGTH = 2_000;
const OBSERVABILITY_PATH = "/api/v1/state";
const BUILT_IN_SLACK_COMMANDS = new Set(["assign", "help", "status", "take-pr", "unassign"]);
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
    statusHooks: resolveStatusHooks(instance.statusHooks, name),
    slackCommands: resolveSlackCommands(instance.slackCommands, name),
  }));
  const endedTaskRetry = {
    maxAttempts: Number(
      config.watcher?.endedTaskRetry?.maxAttempts ?? DEFAULT_ENDED_TASK_MAX_ATTEMPTS,
    ),
    delayMs: Number(config.watcher?.endedTaskRetry?.delayMs ?? DEFAULT_ENDED_TASK_RETRY_DELAY_MS),
  };

  validateEndedTaskRetry(endedTaskRetry);
  const reviewComment = resolveReviewCommentConfig(config.watcher?.reviewComment);
  return {
    services,
    linearTeams: referencedLinearTeams(config.linearTeams, instances),
    pollIntervalMs: POLL_INTERVAL_MS,
    endedTaskRetry,
    reviewComment,
    defaultAssignees: resolveDefaultAssignees(config.slack?.defaultAssignees),
    slack: resolveSlackConfig(config.slack, requireSlack),
  };
}

function resolveSlackCommands(
  config: SlackCommandConfig[] | undefined,
  service: string,
): SlackCommandConfig[] {
  if (config === undefined) return [];
  if (!Array.isArray(config)) {
    throw new Error(`instances.${service}.slackCommands must be an array.`);
  }

  const commands = new Set<string>();
  return config.map((slackCommand, index) => {
    const label = `instances.${service}.slackCommands[${index}]`;
    if (!slackCommand || typeof slackCommand !== "object" || Array.isArray(slackCommand)) {
      throw new Error(`${label} must be an object.`);
    }
    const command = slackCommand.command?.trim().toLowerCase();
    if (!command || !/^[a-z0-9][a-z0-9-]*$/.test(command)) {
      throw new Error(
        `${label}.command must contain only lowercase letters, numbers, and hyphens.`,
      );
    }
    if (BUILT_IN_SLACK_COMMANDS.has(command)) {
      throw new Error(`${label}.command conflicts with built-in command: ${command}`);
    }
    if (commands.has(command)) throw new Error(`${label}.command must be unique: ${command}`);
    commands.add(command);
    if (typeof slackCommand.run !== "function") {
      throw new Error(`${label}.run must be a function.`);
    }
    return { command, run: slackCommand.run };
  });
}

function resolveStatusHooks(
  config: StatusHookConfig[] | undefined,
  service: string,
): StatusHookConfig[] {
  if (config === undefined) return [];
  if (!Array.isArray(config)) {
    throw new Error(`instances.${service}.statusHooks must be an array.`);
  }

  const ids = new Set<string>();
  return config.map((hook, index) => {
    const label = `instances.${service}.statusHooks[${index}]`;
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

function resolveReviewCommentConfig(
  config: ReviewCommentConfig | undefined,
): ReviewCommentConfig | undefined {
  if (!config) return undefined;

  const inReviewStatus = config.inReviewStatus?.trim();
  const inProgressStatus = config.inProgressStatus?.trim();
  const reviewReadyDelayMs = config.reviewReadyDelayMs ?? DEFAULT_REVIEW_READY_DELAY_MS;
  if (!inReviewStatus) {
    throw new Error("watcher.reviewComment.inReviewStatus must be a non-empty string.");
  }
  if (!inProgressStatus) {
    throw new Error("watcher.reviewComment.inProgressStatus must be a non-empty string.");
  }
  if (
    typeof reviewReadyDelayMs !== "number" ||
    !Number.isFinite(reviewReadyDelayMs) ||
    reviewReadyDelayMs < 0
  ) {
    throw new Error(
      "watcher.reviewComment.reviewReadyDelayMs must be a finite number zero or greater.",
    );
  }

  const symphonyGitHubLogins = config.symphonyGitHubLogins?.map((login) => login.trim());
  if (symphonyGitHubLogins?.some((login) => !login)) {
    throw new Error(
      "watcher.reviewComment.symphonyGitHubLogins must contain only non-empty strings.",
    );
  }

  return {
    inReviewStatus,
    inProgressStatus,
    reviewReadyDelayMs,
    ...(symphonyGitHubLogins ? { symphonyGitHubLogins: [...new Set(symphonyGitHubLogins)] } : {}),
  };
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

function observabilityUrl(port: number): string {
  return `http://127.0.0.1:${port}${OBSERVABILITY_PATH}`;
}
