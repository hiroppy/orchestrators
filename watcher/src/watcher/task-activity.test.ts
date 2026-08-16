import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildTaskActivity, isTaskActivityUpdateDue, readGitSummary } from "./task-activity.ts";

describe("task activity", () => {
  it("preserves Symphony's activity message", async () => {
    const activity = await buildTaskActivity({
      last_message: "item started: command execution (rs_example)",
      last_event_at: "2026-08-16T01:18:33Z",
    });

    assert.equal(activity.message, "item started: command execution (rs_example)");
    assert.deepEqual(activity.changedFiles, []);
  });

  it("falls back to the last event and then to Running", async () => {
    const fromEvent = await buildTaskActivity({ last_event: "retrying" });
    assert.equal(fromEvent.message, "retrying");

    const fallback = await buildTaskActivity({});
    assert.equal(fallback.message, "Running");
  });

  it("updates at the 15-second boundary", () => {
    const publishedAt = "2026-08-16T01:00:00.000Z";

    assert.equal(isTaskActivityUpdateDue(undefined, new Date(publishedAt)), true);
    assert.equal(isTaskActivityUpdateDue(publishedAt, new Date("2026-08-16T01:00:14.999Z")), false);
    assert.equal(isTaskActivityUpdateDue(publishedAt, new Date("2026-08-16T01:00:15.000Z")), true);
  });

  it("includes untracked files in the aggregate line count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-activity-git-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(join(directory, "tracked.txt"), "existing\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-m",
          "initial",
        ],
        { cwd: directory },
      );
      await writeFile(join(directory, "tracked.txt"), "existing\nadded\n");
      await writeFile(join(directory, "untracked.txt"), "one\ntwo\nthree\n");

      const summary = await readGitSummary(directory);

      assert.equal(summary.changedFileCount, 2);
      assert.equal(summary.additions, 4);
      assert.equal(summary.deletions, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds work when a workspace has too many untracked files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-activity-many-files-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          writeFile(join(directory, `untracked-${index}.txt`), "one\ntwo\n"),
        ),
      );

      const summary = await readGitSummary(directory, { maxUntrackedFiles: 2 });

      assert.deepEqual(summary, {
        changedFiles: [],
        changedFileCount: 0,
        additions: 0,
        deletions: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to an empty summary when a Git command stalls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-activity-timeout-"));
    try {
      const stalledGit = join(directory, "git-stall");
      await writeFile(stalledGit, "#!/bin/sh\nexec sleep 60\n");
      await chmod(stalledGit, 0o755);

      const startedAt = Date.now();
      const summary = await readGitSummary(directory, {
        gitExecutable: stalledGit,
        timeoutMs: 20,
      });

      assert.deepEqual(summary, {
        changedFiles: [],
        changedFileCount: 0,
        additions: 0,
        deletions: 0,
      });
      assert.ok(Date.now() - startedAt < 1_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
