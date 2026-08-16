import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { SnapshotRow, SnapshotsByService, TaskActivity } from "../domain/types.ts";
import { taskIdFor, type WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "../slack/client-types.ts";
import { publishStatusTimeline, reloadStatusTimeline } from "../slack/status-timeline.ts";
import { withTaskCardQueue } from "../slack/task-card-queue.ts";

const execFileAsync = promisify(execFile);
const ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;
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
          let published = await reloadStatusTimeline(client, store, task.id);
          if (
            !published &&
            store.getLatestEventsByType(task.id, "status_timeline", 1).length === 0
          ) {
            await publishStatusTimeline(client, store, {
              taskId: task.id,
              fallbackText: `${task.status} → ${task.status}`,
              event: {
                fromStatus: task.status,
                toStatus: task.status,
                occurredAt: now.toISOString(),
                source: { type: "automatic", label: "Running" },
              },
            });
            published = true;
          }
          if (published) {
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
    const untrackedAdditions = await countUntrackedLines(workspacePath, untrackedFiles, options);
    let additions = 0;
    let deletions = 0;
    for (const line of trackedNumstat.split("\n")) {
      const [added, deleted] = line.split("\t");
      if (/^\d+$/.test(added ?? "")) additions += Number(added);
      if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
    }
    additions += untrackedAdditions;
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

async function countUntrackedLines(
  workspacePath: string,
  files: string[],
  options: GitCommandOptions,
): Promise<number> {
  if (files.length > (options.maxUntrackedFiles ?? MAX_UNTRACKED_FILES)) {
    throw new Error("Too many untracked files to summarize.");
  }

  const workspaceRoot = `${resolve(workspacePath)}${sep}`;
  let remainingBytes = options.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES;
  let additions = 0;
  for (const file of files) {
    const path = resolve(workspacePath, file);
    if (!path.startsWith(workspaceRoot)) throw new Error("Untracked path escapes the workspace.");

    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(64 * 1024, remainingBytes + 1));
      let fileBytes = 0;
      let fileAdditions = 0;
      let lastByte: number | undefined;
      let binary = false;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        if (bytesRead > remainingBytes)
          throw new Error("Untracked files are too large to summarize.");
        remainingBytes -= bytesRead;
        fileBytes += bytesRead;
        lastByte = buffer[bytesRead - 1];
        for (let index = 0; index < bytesRead; index += 1) {
          if (buffer[index] === 0) binary = true;
          if (buffer[index] === 10) fileAdditions += 1;
        }
      }
      if (!binary) additions += fileAdditions + Number(fileBytes > 0 && lastByte !== 10);
    } finally {
      await handle.close();
    }
  }
  return additions;
}

async function runGit(
  workspacePath: string,
  args: string[],
  options: GitCommandOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(
    options.gitExecutable ?? "git",
    ["-C", workspacePath, ...args],
    {
      timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    },
  );
  return stdout;
}

interface GitCommandOptions {
  gitExecutable?: string;
  timeoutMs?: number;
  maxUntrackedBytes?: number;
  maxUntrackedFiles?: number;
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
