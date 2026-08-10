import type { ServiceDefinition, Snapshot, SnapshotsByService } from "../domain/types.ts";
import { normalizeSnapshot } from "./diff.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface CollectSnapshotsOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export async function collectSnapshots(
  services: ServiceDefinition[],
  previous: SnapshotsByService = {},
  options: CollectSnapshotsOptions = {},
): Promise<SnapshotsByService> {
  const fetchService = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const entries = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await fetchService(service.url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = await response.json();
        if (!isSnapshot(snapshot)) throw new Error("Invalid observability snapshot");
        return [service.name, snapshot] as const;
      } catch (error) {
        return [
          service.name,
          serviceUnavailableSnapshot(service, previous[service.name], error),
        ] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<Snapshot>;
  return (
    Array.isArray(snapshot.running) &&
    Array.isArray(snapshot.retrying) &&
    Array.isArray(snapshot.blocked)
  );
}

function serviceUnavailableSnapshot(
  service: ServiceDefinition,
  previous: Snapshot | undefined,
  error: unknown,
): Snapshot {
  const message = error instanceof Error ? error.message : String(error);
  const snapshot = normalizeSnapshot(previous);
  const watcherIdentifier = `watcher:${service.name}`;

  return {
    running: snapshot.running,
    retrying: [
      ...snapshot.retrying.filter(
        (row) => (row.issue_identifier ?? row.issueIdentifier) !== watcherIdentifier,
      ),
      {
        issue_identifier: watcherIdentifier,
        state: "unavailable",
        error: `${service.url} ${message}`,
      },
    ],
    blocked: snapshot.blocked,
  };
}
