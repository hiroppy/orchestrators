import {
  validateStatuses,
  type ResolvedWatcherRuntimeConfig,
  type WatcherRuntimeConfig,
} from "../config/runtime.ts";
import type { ResolvedLinearTeamConfig } from "../domain/types.ts";
import { normalizeStatus } from "../domain/status.ts";
import { fetchLinearWorkflowStates } from "../integrations/linear.ts";

export function linearTeamForService(
  config: ResolvedWatcherRuntimeConfig,
  serviceName: string,
): ResolvedLinearTeamConfig | undefined {
  const service = config.services.find(({ name }) => name === serviceName);
  return service ? config.linearTeams[service.linearTeam] : undefined;
}

export async function resolveLinearWorkflowStatuses(
  config: WatcherRuntimeConfig,
  fetchStates: typeof fetchLinearWorkflowStates = fetchLinearWorkflowStates,
): Promise<ResolvedWatcherRuntimeConfig> {
  const entries = await Promise.all(
    Object.entries(config.linearTeams).map(async ([name, team]) => {
      const statuses = await fetchStates(team.teamId, { apiKey: team.apiKey });
      validateStatuses(`Linear workflow states for ${name}`, statuses);
      return [name, { ...team, statuses }] as const;
    }),
  );
  const resolved = {
    ...config,
    linearTeams: Object.fromEntries(entries),
  } satisfies ResolvedWatcherRuntimeConfig;

  validateStatusRules(resolved);
  return resolved;
}

function validateStatusRules(config: ResolvedWatcherRuntimeConfig): void {
  const rules: Array<[label: string, status: string]> = [];
  if (config.reviewComment) {
    rules.push(
      ["watcher.reviewComment.inReviewStatus", config.reviewComment.inReviewStatus],
      ["watcher.reviewComment.inProgressStatus", config.reviewComment.inProgressStatus],
    );
  }
  for (const [index, hook] of config.statusHooks.entries()) {
    rules.push([`watcher.statusHooks[${index}].status`, hook.status]);
  }

  for (const [label, expected] of rules) {
    const normalizedExpected = normalizeStatus(expected);
    for (const [teamName, team] of Object.entries(config.linearTeams)) {
      if (team.statuses.some((status) => normalizeStatus(status) === normalizedExpected)) continue;
      throw new Error(`${label} references unknown Linear status "${expected}" for ${teamName}.`);
    }
  }
}
