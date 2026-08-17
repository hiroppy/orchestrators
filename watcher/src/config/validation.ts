import type { InstanceConfig, LinearTeamConfig } from "orchestrator-config";

export function validateInstance(name: string, instance: InstanceConfig): void {
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

export function validateLinearTeam(teamId: string, team: LinearTeamConfig): void {
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

export function validateEndedTaskRetry(retry: { maxAttempts: number; delayMs: number }): void {
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
