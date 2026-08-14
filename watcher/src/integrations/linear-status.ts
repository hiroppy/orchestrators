import { normalizeStatus } from "../domain/status.ts";
import { isTransientLinearError, linearRequest } from "./linear-client.ts";
import {
  ISSUE_STATUS_TARGET_QUERY,
  ISSUE_STATUS_UPDATE_MUTATION,
  TEAM_WORKFLOW_STATES_QUERY,
} from "./linear-queries.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const WORKFLOW_STATE_CACHE_TTL_MS = 60 * 60 * 1_000;
const WORKFLOW_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

interface LinearRequestOptions {
  apiKey?: string;
  issueId?: string;
  teamId?: string;
  timeoutMs?: number;
}

interface CachedWorkflowState {
  id: string;
  name: string;
}

interface WorkflowState extends CachedWorkflowState {
  type: string;
  position: number;
}

interface WorkflowStateCacheEntry {
  expiresAt: number;
  states: CachedWorkflowState[];
}

const workflowStatesByTeam = new Map<string, WorkflowStateCacheEntry>();

export async function fetchLinearWorkflowStates(
  teamId: string,
  { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }: LinearRequestOptions,
): Promise<string[]> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const data = await linearRequest<{
    team?: {
      states?: {
        nodes?: WorkflowState[];
      };
    };
  }>(apiKey, TEAM_WORKFLOW_STATES_QUERY, { id: teamId }, timeoutMs);
  if (!data.team) throw new Error(`Linear team not found: ${teamId}`);

  const workflowStates = [...(data.team.states?.nodes ?? [])].sort(
    (left, right) =>
      workflowStateTypeOrder(left.type) - workflowStateTypeOrder(right.type) ||
      left.position - right.position,
  );
  const states = workflowStates.map(({ name }) => name);
  if (states.length === 0) {
    throw new Error(`Linear team has no workflow states: ${teamId}`);
  }
  cacheWorkflowStates(
    teamId,
    workflowStates.map(({ id, name }) => ({ id, name })),
  );
  return states;
}

export async function updateLinearIssueStatus(
  issueIdentifier: string,
  statusName: string,
  { apiKey, issueId, teamId, timeoutMs = DEFAULT_TIMEOUT_MS }: LinearRequestOptions,
): Promise<void> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const normalizedStatus = normalizeStatus(statusName);
  const cachedState = teamId
    ? getCachedWorkflowStates(teamId)?.find(
        ({ name }) => normalizeStatus(name) === normalizedStatus,
      )
    : undefined;
  if (cachedState && issueId) {
    try {
      await mutateIssueStatus(apiKey, issueId, cachedState.id, issueIdentifier, timeoutMs);
      return;
    } catch (error) {
      if (teamId && !isTransientLinearError(error)) workflowStatesByTeam.delete(teamId);
      throw error;
    }
  }

  const target = await fetchIssueStatusTarget(apiKey, issueIdentifier, timeoutMs);
  if (teamId) cacheWorkflowStates(teamId, target.states);
  const state = target.states.find(({ name }) => normalizeStatus(name) === normalizedStatus);
  if (!state) {
    throw new Error(`Linear status not found for ${issueIdentifier}: ${statusName}`);
  }

  await mutateIssueStatus(apiKey, target.issueId, state.id, issueIdentifier, timeoutMs);
}

function cacheWorkflowStates(teamId: string, states: CachedWorkflowState[]): void {
  workflowStatesByTeam.set(teamId, {
    expiresAt: Date.now() + WORKFLOW_STATE_CACHE_TTL_MS,
    states,
  });
}

function getCachedWorkflowStates(teamId: string): CachedWorkflowState[] | undefined {
  const cached = workflowStatesByTeam.get(teamId);
  if (!cached) return undefined;
  if (cached.expiresAt > Date.now()) return cached.states;
  workflowStatesByTeam.delete(teamId);
  return undefined;
}

async function mutateIssueStatus(
  apiKey: string,
  issueId: string,
  stateId: string,
  issueIdentifier: string,
  timeoutMs: number,
): Promise<void> {
  const updated = await linearRequest<{
    issueUpdate?: { success?: boolean };
  }>(
    apiKey,
    ISSUE_STATUS_UPDATE_MUTATION,
    {
      id: issueId,
      stateId,
    },
    timeoutMs,
  );
  if (!updated.issueUpdate?.success) {
    throw new Error(`Linear rejected status update for ${issueIdentifier}.`);
  }
}

async function fetchIssueStatusTarget(
  apiKey: string,
  issueIdentifier: string,
  timeoutMs: number,
): Promise<{ issueId: string; states: Array<{ id: string; name: string }> }> {
  const target = await linearRequest<{
    issue?: {
      id: string;
      team?: { states?: { nodes?: Array<{ id: string; name: string }> } };
    };
  }>(apiKey, ISSUE_STATUS_TARGET_QUERY, { id: issueIdentifier }, timeoutMs);
  if (!target.issue) throw new Error(`Linear issue not found: ${issueIdentifier}`);
  return {
    issueId: target.issue.id,
    states: target.issue.team?.states?.nodes ?? [],
  };
}

function workflowStateTypeOrder(type: string): number {
  const index = WORKFLOW_STATE_TYPES.indexOf(type);
  return index === -1 ? WORKFLOW_STATE_TYPES.length : index;
}
