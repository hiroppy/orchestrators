import type { LinearWorkflowStateType } from "orchestrator-config";

export const TERMINAL_LINEAR_STATE_TYPES = ["completed", "canceled", "duplicate"] as const;

export function isTerminalLinearStateType(stateType?: string | null): boolean {
  const normalized = stateType?.trim().toLowerCase();
  return TERMINAL_LINEAR_STATE_TYPES.some((terminalType) => terminalType === normalized);
}

export function isTerminalLinearState(
  stateType: string | null | undefined,
  status: string | null | undefined,
  statusTypeOverrides: Record<string, LinearWorkflowStateType>,
): boolean {
  return isTerminalLinearStateType(
    effectiveLinearStateType(stateType, status, statusTypeOverrides),
  );
}

export function effectiveLinearStateType(
  stateType: string | null | undefined,
  status: string | null | undefined,
  statusTypeOverrides: Record<string, LinearWorkflowStateType>,
): string | null | undefined {
  const normalizedStatus = status?.trim().toLowerCase();
  return (
    Object.entries(statusTypeOverrides).find(
      ([configuredStatus]) => configuredStatus.trim().toLowerCase() === normalizedStatus,
    )?.[1] ?? stateType
  );
}

export function enteredTerminalLinearState(
  previousStateType?: string | null,
  currentStateType?: string | null,
  previousStatus?: string | null,
  currentStatus?: string | null,
  statusTypeOverrides: Record<string, LinearWorkflowStateType> = {},
): boolean {
  return (
    !isTerminalLinearState(previousStateType, previousStatus, statusTypeOverrides) &&
    isTerminalLinearState(currentStateType, currentStatus, statusTypeOverrides)
  );
}
