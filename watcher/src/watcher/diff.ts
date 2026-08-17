import type { EventType } from "orchestrator-config";

import type { Snapshot, SnapshotRow, SnapshotsByService } from "../domain/snapshot.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import type { WatcherRuntimeConfig } from "../config/runtime.ts";

export function normalizeSnapshot(snapshot?: Partial<Snapshot>): Snapshot {
  return {
    running: Array.isArray(snapshot?.running) ? snapshot.running : [],
    retrying: Array.isArray(snapshot?.retrying) ? snapshot.retrying : [],
    blocked: Array.isArray(snapshot?.blocked) ? snapshot.blocked : [],
  };
}

export function diffSnapshots(
  previousByService: SnapshotsByService,
  currentByService: SnapshotsByService,
  config: WatcherRuntimeConfig,
): WatcherEvent[] {
  const events: WatcherEvent[] = [];

  for (const service of config.services ?? []) {
    const serviceName = service.name;
    const previous = normalizeSnapshot(previousByService?.[serviceName]);
    const current = normalizeSnapshot(currentByService?.[serviceName]);
    const previousStatuses = statusIndex(previous);
    const currentStatuses = statusIndex(current);
    const linearBaseUrl = config.linearTeams[service.linearTeam].baseUrl;

    events.push(...diffRunning(serviceName, previousStatuses, current.running, linearBaseUrl));
    events.push(
      ...diffList(serviceName, previousStatuses, "retrying", current.retrying, linearBaseUrl),
    );
    events.push(
      ...diffList(serviceName, previousStatuses, "blocked", current.blocked, linearBaseUrl),
    );
    events.push(...diffEnded(serviceName, previousStatuses, currentStatuses, linearBaseUrl));
  }

  return events;
}

interface StatusEntry {
  status: string;
  row: SnapshotRow;
}

type StatusIndex = Map<string, StatusEntry>;

function diffRunning(
  service: string,
  previousStatuses: StatusIndex,
  currentRows: SnapshotRow[],
  linearBaseUrl?: string,
): WatcherEvent[] {
  const events: WatcherEvent[] = [];

  for (const row of currentRows) {
    const issueIdentifier = issueIdentifierFor(row);
    if (!issueIdentifier) continue;

    const previousStatus = previousStatuses.get(issueIdentifier);
    const currentStatus = runningStatus(row);

    if (!previousStatus) {
      events.push(toEvent("started", service, row, linearBaseUrl));
      continue;
    }

    if (previousStatus.status !== currentStatus) {
      events.push(toEvent("updated", service, row, linearBaseUrl));
    }
  }

  return events;
}

function diffList(
  service: string,
  previousStatuses: StatusIndex,
  type: Extract<EventType, "retrying" | "blocked">,
  currentRows: SnapshotRow[],
  linearBaseUrl?: string,
): WatcherEvent[] {
  const events: WatcherEvent[] = [];

  for (const row of currentRows) {
    const issueIdentifier = issueIdentifierFor(row);
    if (!issueIdentifier) continue;

    if (previousStatuses.get(issueIdentifier)?.status !== type) {
      events.push(toEvent(type, service, row, linearBaseUrl));
    }
  }

  return events;
}

function diffEnded(
  service: string,
  previousStatuses: StatusIndex,
  currentStatuses: StatusIndex,
  linearBaseUrl?: string,
): WatcherEvent[] {
  const events: WatcherEvent[] = [];

  for (const [issueIdentifier, previousStatus] of previousStatuses.entries()) {
    if (!currentStatuses.has(issueIdentifier)) {
      if (issueIdentifier === `watcher:${service}`) {
        events.push({
          type: "recovered",
          service,
          issueIdentifier,
          state: "available",
        });
      } else {
        events.push(toEvent("ended", service, previousStatus.row, linearBaseUrl));
      }
    }
  }

  return events;
}

function statusIndex(snapshot: Snapshot): StatusIndex {
  const statuses: StatusIndex = new Map();

  for (const row of snapshot.running) {
    const issueIdentifier = issueIdentifierFor(row);
    if (issueIdentifier) statuses.set(issueIdentifier, { status: runningStatus(row), row });
  }

  for (const row of snapshot.retrying) {
    const issueIdentifier = issueIdentifierFor(row);
    if (issueIdentifier) statuses.set(issueIdentifier, { status: "retrying", row });
  }

  for (const row of snapshot.blocked) {
    const issueIdentifier = issueIdentifierFor(row);
    if (issueIdentifier) statuses.set(issueIdentifier, { status: "blocked", row });
  }

  return statuses;
}

function runningStatus(row: SnapshotRow): string {
  return row.state ?? "running";
}

function toEvent(
  type: EventType,
  service: string,
  row: SnapshotRow,
  linearBaseUrl?: string,
): WatcherEvent {
  const issueIdentifier = issueIdentifierFor(row);

  return compactObject({
    type,
    service,
    issueIdentifier,
    issueUrl: issueUrlFor(row, issueIdentifier, linearBaseUrl),
    state: row.state ?? null,
    workspacePath: row.workspace_path ?? null,
    startedAt: row.started_at ?? null,
    blockedAt: row.blocked_at ?? null,
    lastEvent: row.last_event ?? null,
    lastEventAt: row.last_event_at ?? row.blocked_at ?? row.due_at ?? null,
    attempt: row.attempt ?? null,
    dueAt: row.due_at ?? null,
    error: row.error ?? null,
  }) as unknown as WatcherEvent;
}

function issueIdentifierFor(row: SnapshotRow): string | null {
  return row?.issue_identifier ?? row?.issueIdentifier ?? null;
}

function compactObject<T extends object>(object: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  );
}

function issueUrlFor(
  row: SnapshotRow,
  issueIdentifier: string | null,
  linearBaseUrl?: string,
): string | null {
  if (row.issue_url) return row.issue_url;
  if (!linearBaseUrl || !issueIdentifier || !/^[A-Z]+-\d+$/.test(issueIdentifier)) return null;
  return `${linearBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(issueIdentifier)}`;
}
