import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SnapshotRow, SnapshotsByService, TaskActivity } from "../domain/types.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "../slack/client-types.ts";
import { reloadStatusTimeline } from "../slack/status-timeline.ts";
import { withTaskCardQueue } from "../slack/task-card-queue.ts";

const execFileAsync = promisify(execFile);
const ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const MAX_DISPLAYED_FILES = 3;

export async function publishTaskActivities(
  client: SlackClient,
  store: WatcherStore,
  snapshots: SnapshotsByService,
  now = new Date(),
): Promise<void> {
  for (const [service, snapshot] of Object.entries(snapshots)) {
    for (const row of snapshot?.running ?? []) {
      const identifier = row.issue_identifier ?? row.issueIdentifier;
      if (!identifier) continue;
      const task = store.getTask(taskIdFor(service, identifier));
      if (!task?.parentMessageTs || !isTaskActivityUpdateDue(task.activityPublishedAt, now)) {
        continue;
      }
      try {
        const activity = await buildTaskActivity(row);
        await withTaskCardQueue(task.id, async () => {
          store.setTaskActivity(task.id, activity);
          if (await reloadStatusTimeline(client, store, task.id)) {
            store.markTaskActivityPublished(task.id, now);
          }
        });
      } catch (error) {
        console.error(`Failed to publish task activity for ${task.id}:`, error);
      }
    }
  }
}

export async function buildTaskActivity(row: SnapshotRow): Promise<TaskActivity> {
  const git = row.workspace_path ? await readGitSummary(row.workspace_path) : emptyGitSummary();
  return {
    message: row.last_message ?? row.last_event ?? "Running",
    ...git,
  };
}

export function isTaskActivityUpdateDue(publishedAt: string | undefined, now: Date): boolean {
  return !publishedAt || now.getTime() - Date.parse(publishedAt) >= ACTIVITY_UPDATE_INTERVAL_MS;
}

async function readGitSummary(workspacePath: string): Promise<GitSummary> {
  try {
    const [{ stdout: status }, { stdout: numstat }] = await Promise.all([
      execFileAsync("git", ["-C", workspacePath, "status", "--short", "--untracked-files=all"]),
      execFileAsync("git", ["-C", workspacePath, "diff", "--numstat", "HEAD", "--"]),
    ]);
    const files = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.split("\n")) {
      const [added, deleted] = line.split("\t");
      if (/^\d+$/.test(added ?? "")) additions += Number(added);
      if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
    }
    return {
      changedFiles: files.slice(0, MAX_DISPLAYED_FILES),
      changedFileCount: files.length,
      additions,
      deletions,
    };
  } catch {
    return emptyGitSummary();
  }
}

interface GitSummary {
  changedFiles: string[];
  changedFileCount: number;
  additions: number;
  deletions: number;
}

function emptyGitSummary(): GitSummary {
  return { changedFiles: [], changedFileCount: 0, additions: 0, deletions: 0 };
}
