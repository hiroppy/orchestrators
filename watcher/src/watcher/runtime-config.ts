import {
  validateStatuses,
  type ResolvedWatcherRuntimeConfig,
  type WatcherRuntimeConfig,
} from "../config/runtime.ts";
import type { ResolvedLinearTeamConfig } from "../domain/types.ts";
import { effectiveLinearStateType } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import { fetchLinearWorkflowStates } from "../integrations/linear.ts";
import {
  readWorkflow,
  trackerStatesFromWorkflow,
  workflowPathFor,
} from "../symphonies/workflow.ts";

type ReadWorkflow = (path: string) => Promise<string>;

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

export async function resolveSymphonyWorkflowSettings(
  config: WatcherRuntimeConfig,
  symphoniesDirectory: string,
  read: ReadWorkflow = readWorkflow,
): Promise<WatcherRuntimeConfig> {
  const services = await Promise.all(
    config.services.map(async (service) => {
      const path = workflowPathFor(symphoniesDirectory, service.name);
      const trackerStates = trackerStatesFromWorkflow(await read(path));
      if (!trackerStates) {
        throw new Error(
          `WORKFLOW.md does not define valid tracker.active_states and tracker.terminal_states for ${service.name}.`,
        );
      }
      return { ...service, ...trackerStates };
    }),
  );
  return { ...config, services };
}

export function effectiveLinearStateTypeForService(
  config: ResolvedWatcherRuntimeConfig,
  serviceName: string,
  stateName: string | null | undefined,
  stateType: string | null | undefined,
): string | undefined {
  const service = config.services.find(({ name }) => name === serviceName);
  return effectiveLinearStateType(
    stateName,
    stateType,
    service?.activeStates ?? [],
    service?.terminalStates ?? [],
  );
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
