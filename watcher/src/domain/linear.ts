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
