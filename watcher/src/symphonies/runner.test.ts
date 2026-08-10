import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { enabledServiceRuntimes, superviseServices, type ServiceRuntime } from "./runner.ts";
import { resolveSupervisorConfig } from "../config/runtime.ts";

describe("enabledServiceRuntimes", () => {
  it("uses conventions and excludes disabled services", () => {
    const runtimes = enabledServiceRuntimes(
      resolveSupervisorConfig({
        instances: {
          enabled: {
            enabled: true,
            port: 5101,
            linearTeam: "workspace-a-eng",
          },
          disabled: {
            enabled: false,
            port: 5102,
            linearTeam: "workspace-a-eng",
          },
        },
        linearTeams: linearTeams(),
      }),
      "/repo",
    );

    assert.deepEqual(
      runtimes.map(({ name, port, workingDirectory, logsRoot }) => ({
        name,
        port,
        workingDirectory,
        logsRoot,
      })),
      [
        {
          name: "enabled",
          port: 5101,
          workingDirectory: "/repo/symphonies/enabled/elixir",
          logsRoot: "/repo/data/symphony/logs/enabled",
        },
      ],
    );
  });

  it("starts the Symphony executable directly", async () => {
    await withRuntime(async (runtime) => {
      let command: string | undefined;
      let args: readonly string[] | undefined;
      let spawnOptions: { stdio?: unknown } | undefined;
      const child = fakeChild();
      const stop = await superviseServices([runtime], {
        spawnProcess: ((
          spawnCommand: string,
          spawnArgs: readonly string[],
          options: { stdio?: unknown },
        ) => {
          command = spawnCommand;
          args = spawnArgs;
          spawnOptions = options;
          return child;
        }) as never,
      });

      stop();

      assert.equal(command, "./bin/symphony");
      assert.deepEqual(args, [
        "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
        "--logs-root",
        runtime.logsRoot,
        "--port",
        "5101",
        "./WORKFLOW.md",
      ]);
      assert.equal(Array.isArray(spawnOptions?.stdio), true);
      assert.equal(spawnOptions?.stdio?.[1], "ignore");
      assert.equal(typeof spawnOptions?.stdio?.[2], "number");
      assert.equal(child.killed, true);
    });
  });

  it("restarts a service after spawn emits error and close", async () => {
    await withRuntime(async (runtime) => {
      let spawnCount = 0;
      const errors: unknown[] = [];
      const children: FakeChild[] = [];
      const stop = await superviseServices([runtime], {
        restartDelayMs: 0,
        reportError: (_serviceName, error) => errors.push(error),
        spawnProcess: (() => {
          spawnCount += 1;
          const child = fakeChild();
          children.push(child);
          if (spawnCount === 1) {
            queueMicrotask(() => {
              child.emit("error", new Error("spawn failed"));
              child.emit("close", 1);
            });
          }
          return child;
        }) as never,
      });

      await wait(10);
      stop();

      assert.equal(spawnCount, 2);
      assert.equal(errors.length, 1);
      assert.equal(children[1].killed, true);
    });
  });

  it("cancels a pending restart when the supervisor stops", async () => {
    await withRuntime(async (runtime) => {
      let spawnCount = 0;
      const stop = await superviseServices([runtime], {
        restartDelayMs: 20,
        reportError: () => {},
        spawnProcess: (() => {
          spawnCount += 1;
          const child = fakeChild();
          queueMicrotask(() => child.emit("close", 1));
          return child;
        }) as never,
      });

      await wait(0);
      stop();
      await wait(30);

      assert.equal(spawnCount, 1);
    });
  });

  it("rejects duplicate ports before starting services", () => {
    assert.throws(
      () =>
        resolveSupervisorConfig({
          instances: {
            "service-a": {
              port: 5101,
              linearTeam: "workspace-a-eng",
            },
            "service-b": {
              port: 5101,
              linearTeam: "workspace-a-eng",
            },
          },
          linearTeams: linearTeams(),
        }),
      /duplicate ports/,
    );
  });

  it("uses team metadata without loading Watcher workflow statuses", () => {
    assert.deepEqual(
      resolveSupervisorConfig({
        instances: {
          "service-a": {
            port: 5101,
            linearTeam: "workspace-a-eng",
          },
        },
        linearTeams: {
          "workspace-a-eng": {
            apiKey: "lin_test",
            teamId: "team-a",
          },
        },
      }).map(({ name, port }) => ({ name, port })),
      [
        {
          name: "service-a",
          port: 5101,
        },
      ],
    );
  });
});

interface FakeChild extends EventEmitter {
  killed: boolean;
  kill(): boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

async function withRuntime(run: (runtime: ServiceRuntime) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "symphony-supervisor-"));

  try {
    await run({
      name: "service-a",
      port: 5101,
      linearApiKey: "lin_test",
      workingDirectory: directory,
      logsRoot: join(directory, "logs"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function linearTeams() {
  return {
    "workspace-a-eng": {
      apiKey: "lin_test",
      teamId: "team-a",
      statuses: ["Todo", "In Progress", "Done"],
    },
  };
}
