import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SnapshotRow, SnapshotsByService, TaskActivity } from "../domain/types.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "../slack/client-types.ts";
import { reloadStatusTimeline } from "../slack/status-timeline.ts";
import { withTaskCardQueue } from "../slack/task-card-queue.ts";

const execFileAsync = promisify(execFile);
const ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_DISPLAYED_FILES = 3;

export async function publishTaskActivities(
  client: SlackClient,
  store: WatcherStore,
  snapshots: SnapshotsByService,
  now = new Date(),
): Promise<void> {
  for (const [service, snapshot] of Object.entries(snapshots)) {
    const watcherIdentifier = `watcher:${service}`;
    const unavailable = snapshot?.retrying.some(
      (row) => (row.issue_identifier ?? row.issueIdentifier) === watcherIdentifier,
    );
    if (unavailable) continue;

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
            store.markTaskActivityPublished(task.id, new Date());
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

export async function readGitSummary(
  workspacePath: string,
  options: GitCommandOptions = {},
): Promise<GitSummary> {
  try {
    const [status, trackedNumstat, untrackedOutput] = await Promise.all([
      runGit(workspacePath, ["status", "--short", "--untracked-files=all"], options),
      runGit(workspacePath, ["diff", "--numstat", "HEAD", "--"], options),
      runGit(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"], options),
    ]);
    const files = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    const untrackedFiles = untrackedOutput.split("\0").filter(Boolean);
    const untrackedNumstats = await Promise.all(
      untrackedFiles.map((file) =>
        runGit(workspacePath, ["diff", "--no-index", "--numstat", "--", "/dev/null", file], {
          ...options,
          allowDifferences: true,
        }),
      ),
    );
    let additions = 0;
    let deletions = 0;
    for (const line of [trackedNumstat, ...untrackedNumstats].join("\n").split("\n")) {
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

async function runGit(
  workspacePath: string,
  args: string[],
  options: GitCommandOptions,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      options.gitExecutable ?? "git",
      ["-C", workspacePath, ...args],
      {
        timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
    );
    return stdout;
  } catch (error) {
    if (
      options.allowDifferences &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return error.stdout;
    }
    throw error;
  }
}

interface GitCommandOptions {
  gitExecutable?: string;
  timeoutMs?: number;
  allowDifferences?: boolean;
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
