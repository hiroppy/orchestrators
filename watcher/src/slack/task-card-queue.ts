import { withQueue } from "./async-queue.ts";

const taskCardQueues = new Map<string, Promise<void>>();

export function withTaskCardQueue<T>(taskId: string, run: () => Promise<T>): Promise<T> {
  return withQueue(taskCardQueues, taskId, run);
}
