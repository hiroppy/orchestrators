import type { JsonValue, PullRequestMonitorConfig } from "orchestrator-config";

import type { Task } from "./task.ts";

interface PullRequestMonitorTrigger {
  command: string;
  args: string[];
  user?: string;
  metadata?: JsonValue;
}

export type PullRequestMonitorStarter = (
  task: Task,
  monitor: PullRequestMonitorConfig,
  trigger: PullRequestMonitorTrigger,
) => void | Promise<void>;
