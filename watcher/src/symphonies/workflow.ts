import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

export interface SymphonyWorkflowConfig {
  tracker?: {
    provider?: {
      project_slug?: unknown;
      [key: string]: unknown;
    };
    active_states?: unknown;
    terminal_states?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function parseWorkflowFrontmatter(workflow: string): SymphonyWorkflowConfig | undefined {
  const lines = workflow.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const closingDelimiter = lines.indexOf("---", 1);
  const frontmatterEnd = closingDelimiter === -1 ? lines.length : closingDelimiter;
  const frontmatter = lines.slice(1, frontmatterEnd).join("\n");

  try {
    const document: unknown = parseYaml(frontmatter);
    return isRecord(document) ? document : undefined;
  } catch {
    return undefined;
  }
}

export function workflowPathFor(symphoniesDirectory: string, serviceName: string): string {
  const root = resolve(symphoniesDirectory);
  const workflowPath = resolve(root, serviceName, "elixir/WORKFLOW.md");
  const pathFromRoot = relative(root, workflowPath);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Service name cannot resolve outside the symphonies directory: ${serviceName}`);
  }
  return workflowPath;
}

export async function readWorkflow(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`WORKFLOW.md could not be read for ${path.split("/").at(-3) ?? "service"}.`);
  }
}

export function trackerStatesFromWorkflow(
  workflow: string,
): { activeStates: string[]; terminalStates: string[] } | undefined {
  const tracker = parseWorkflowFrontmatter(workflow)?.tracker;
  const activeStates = normalizedStateNames(tracker?.active_states);
  const terminalStates = normalizedStateNames(tracker?.terminal_states);
  if (!activeStates || !terminalStates) return undefined;
  const normalizedActiveStates = new Set(activeStates.map(normalizeStateName));
  if (terminalStates.some((state) => normalizedActiveStates.has(normalizeStateName(state)))) {
    return undefined;
  }
  return { activeStates, terminalStates };
}

function isRecord(value: unknown): value is SymphonyWorkflowConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedStateNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((state) => typeof state !== "string" || !state.trim())) return undefined;
  return value.map((state) => state.trim());
}

function normalizeStateName(value: string): string {
  return value.toLowerCase();
}
