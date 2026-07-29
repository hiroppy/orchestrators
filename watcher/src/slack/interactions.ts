export const TASK_STATUS_ACTION_ID = "task_status_select";

export function taskIdFromBlockId(blockId?: string): string | undefined {
  if (!blockId?.startsWith("task:")) return undefined;
  try {
    return decodeURIComponent(blockId.slice("task:".length).split(":", 1)[0]);
  } catch {
    return undefined;
  }
}

export function taskBlockId(taskId: string, status: string): string {
  return `task:${encodeURIComponent(taskId)}:${encodeURIComponent(status)}`;
}
