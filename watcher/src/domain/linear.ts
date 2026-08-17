import { normalizeStatus } from "./status.ts";

export interface RelatedIssue {
  identifier: string;
  title: string | null;
  url: string | null;
  state?: string | null;
  stateType?: string | null;
}

export const TERMINAL_LINEAR_STATE_TYPES = ["completed", "canceled", "duplicate"] as const;

export function isTerminalLinearStateType(stateType?: string | null): boolean {
  const normalized = stateType?.trim().toLowerCase();
  return TERMINAL_LINEAR_STATE_TYPES.some((terminalType) => terminalType === normalized);
}

export function enteredTerminalLinearState(
  previousStateType?: string | null,
  currentStateType?: string | null,
): boolean {
  return (
    !isTerminalLinearStateType(previousStateType) && isTerminalLinearStateType(currentStateType)
  );
}

export function effectiveLinearStateType(
  stateName: string | null | undefined,
  stateType: string | null | undefined,
  activeStates: readonly string[],
  terminalStates: readonly string[],
): string | undefined {
  const normalizedState = normalizeStatus(stateName);
  if (
    normalizedState &&
    terminalStates.some((state) => normalizeStatus(state) === normalizedState)
  ) {
    return "completed";
  }
  const normalizedType = normalizeStatus(stateType);
  if (
    normalizedState &&
    activeStates.some((state) => normalizeStatus(state) === normalizedState) &&
    isTerminalLinearStateType(normalizedType)
  ) {
    return "started";
  }
  return normalizedType;
}
