import { normalizeStatus } from "../domain/status.ts";
import { linearRequest } from "./linear-client.ts";
import {
  ISSUE_STATUS_TARGET_QUERY,
  ISSUE_STATUS_UPDATE_MUTATION,
  TEAM_WORKFLOW_STATES_QUERY,
} from "./linear-queries.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const WORKFLOW_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

interface LinearRequestOptions {
  apiKey?: string;
  timeoutMs?: number;
}

export async function fetchLinearWorkflowStates(
  teamId: string,
  { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }: LinearRequestOptions,
): Promise<string[]> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const data = await linearRequest<{
    team?: {
      states?: {
        nodes?: Array<{ name: string; type: string; position: number }>;
      };
    };
  }>(apiKey, TEAM_WORKFLOW_STATES_QUERY, { id: teamId }, timeoutMs);
  if (!data.team) throw new Error(`Linear team not found: ${teamId}`);

  const states = [...(data.team.states?.nodes ?? [])]
    .sort(
      (left, right) =>
        workflowStateTypeOrder(left.type) - workflowStateTypeOrder(right.type) ||
        left.position - right.position,
    )
    .map(({ name }) => name);
  if (states.length === 0) {
    throw new Error(`Linear team has no workflow states: ${teamId}`);
  }
  return states;
}

export async function updateLinearIssueStatus(
  issueIdentifier: string,
  statusName: string,
  { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }: LinearRequestOptions,
): Promise<void> {
  if (!apiKey) throw new Error("Linear API key is not configured.");

  const target = await linearRequest<{
    issue?: {
      id: string;
      team?: {
        states?: { nodes?: Array<{ id: string; name: string }> };
      };
    };
  }>(apiKey, ISSUE_STATUS_TARGET_QUERY, { id: issueIdentifier }, timeoutMs);
  const issue = target.issue;
  if (!issue) throw new Error(`Linear issue not found: ${issueIdentifier}`);

  const normalizedStatus = normalizeStatus(statusName);
  const state = issue.team?.states?.nodes?.find(
    ({ name }) => normalizeStatus(name) === normalizedStatus,
  );
  if (!state) {
    throw new Error(`Linear status not found for ${issueIdentifier}: ${statusName}`);
  }

  const updated = await linearRequest<{
    issueUpdate?: { success?: boolean };
  }>(
    apiKey,
    ISSUE_STATUS_UPDATE_MUTATION,
    {
      id: issue.id,
      stateId: state.id,
    },
    timeoutMs,
  );
  if (!updated.issueUpdate?.success) {
    throw new Error(`Linear rejected status update for ${issueIdentifier}.`);
  }
}

function workflowStateTypeOrder(type: string): number {
  const index = WORKFLOW_STATE_TYPES.indexOf(type);
  return index === -1 ? WORKFLOW_STATE_TYPES.length : index;
}
