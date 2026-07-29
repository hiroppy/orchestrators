import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSupervisorConfig, type SupervisorInstance } from "../config/runtime.ts";
import type { OrchestratorConfig } from "../domain/types.ts";

const currentFile = fileURLToPath(import.meta.url);
const sourceDirectory = dirname(dirname(currentFile));
const watcherDirectory = dirname(sourceDirectory);
const rootDirectory = dirname(watcherDirectory);
const RESTART_DELAY_MS = 5_000;

export interface ServiceRuntime {
  name: string;
  workingDirectory: string;
  logsRoot: string;
  port: number;
  linearApiKey: string;
}

export async function startSymphonies(config: OrchestratorConfig): Promise<void> {
  const runtimes = enabledServiceRuntimes(resolveSupervisorConfig(config));

  const stop = await superviseServices(runtimes);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

interface SupervisorOptions {
  spawnProcess?: typeof spawn;
  restartDelayMs?: number;
  reportError?: (serviceName: string, error: unknown) => void;
}

export async function superviseServices(
  runtimes: ServiceRuntime[],
  options: SupervisorOptions = {},
): Promise<() => void> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS;
  const reportError =
    options.reportError ??
    ((serviceName, error) => console.error(`Failed to start ${serviceName}:`, error));
  const children = new Map<string, ChildProcess>();
  const restartTimers = new Map<string, NodeJS.Timeout>();
  let stopping = false;

  const scheduleRestart = (runtime: ServiceRuntime): void => {
    if (stopping || restartTimers.has(runtime.name)) return;

    const timer = setTimeout(() => {
      restartTimers.delete(runtime.name);
      void start(runtime);
    }, restartDelayMs);
    restartTimers.set(runtime.name, timer);
  };

  const start = async (runtime: ServiceRuntime): Promise<void> => {
    if (stopping) return;

    let stdout: number | undefined;
    let stderr: number | undefined;
    let child: ChildProcess | undefined;

    try {
      await mkdir(runtime.logsRoot, { recursive: true });
      stdout = openSync(resolve(runtime.logsRoot, "stdout.log"), "a");
      stderr = openSync(resolve(runtime.logsRoot, "stderr.log"), "a");
      child = spawnProcess(
        "./bin/symphony",
        [
          "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
          "--logs-root",
          runtime.logsRoot,
          "--port",
          String(runtime.port),
          "./WORKFLOW.md",
        ],
        {
          cwd: runtime.workingDirectory,
          env: {
            ...process.env,
            LINEAR_API_KEY: runtime.linearApiKey,
          },
          stdio: ["ignore", stdout, stderr],
        },
      );
    } catch (error) {
      reportError(runtime.name, error);
      scheduleRestart(runtime);
      return;
    } finally {
      if (stdout !== undefined) closeSync(stdout);
      if (stderr !== undefined) closeSync(stderr);
    }

    children.set(runtime.name, child);
    child.once("error", (error) => {
      reportError(runtime.name, error);
    });
    child.once("close", () => {
      if (children.get(runtime.name) === child) {
        children.delete(runtime.name);
      }
      scheduleRestart(runtime);
    });
  };

  for (const runtime of runtimes) await start(runtime);

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    for (const timer of restartTimers.values()) clearTimeout(timer);
    restartTimers.clear();
    for (const child of children.values()) child.kill("SIGTERM");
  };

  return stop;
}

export function enabledServiceRuntimes(
  instances: SupervisorInstance[],
  root = rootDirectory,
): ServiceRuntime[] {
  return instances.map((instance) => ({
    ...instance,
    workingDirectory: resolve(root, "symphonies", instance.name, "elixir"),
    logsRoot: resolve(root, "data", "symphony", "logs", instance.name),
  }));
}
