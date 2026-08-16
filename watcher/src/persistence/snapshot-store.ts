import { eq, inArray } from "drizzle-orm";

import type { Snapshot, SnapshotsByService } from "../domain/snapshot.ts";
import type { WatcherDatabase } from "./database.ts";
import { services, statuses, taskObservations, tasks } from "./schema.ts";
import { ensureStatus, issueIdentifierFor, observationToRow } from "./store-helpers.ts";
import { taskIdFor } from "./task-store.ts";

const DEFAULT_STATUS_BY_BUCKET = {
  running: "running",
  retrying: "Retrying",
  blocked: "Blocked",
} as const;

export function getSnapshots(db: WatcherDatabase): SnapshotsByService {
  const serviceRows = db.select().from(services).where(eq(services.active, true)).all();
  const rows = db
    .select({
      task: tasks,
      observation: taskObservations,
      trackerStatus: statuses.name,
    })
    .from(taskObservations)
    .innerJoin(tasks, eq(taskObservations.taskId, tasks.id))
    .innerJoin(services, eq(tasks.serviceId, services.id))
    .leftJoin(statuses, eq(taskObservations.trackerStatusId, statuses.id))
    .where(eq(services.active, true))
    .all();
  const snapshots: Record<string, Snapshot> = Object.fromEntries(
    serviceRows.map((service) => [
      service.name,
      { running: [], retrying: [], blocked: [] } satisfies Snapshot,
    ]),
  );
  const servicesById = new Map(serviceRows.map((service) => [service.id, service.name]));

  for (const row of rows) {
    const serviceName = servicesById.get(row.task.serviceId);
    if (!serviceName) continue;
    const snapshot = snapshots[serviceName];
    snapshot[row.observation.bucket].push(
      observationToRow(row.task.issueIdentifier, row.observation, row.trackerStatus),
    );
  }

  return snapshots;
}
export function replaceSnapshots(
  db: WatcherDatabase,
  snapshots: SnapshotsByService,
  now = new Date(),
): void {
  const timestamp = now.toISOString();
  const serviceRows = db.select().from(services).where(eq(services.active, true)).all();
  const servicesByName = new Map(serviceRows.map((service) => [service.name, service]));
  const activeTaskIds = db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(services, eq(tasks.serviceId, services.id))
    .where(eq(services.active, true));

  db.transaction((tx) => {
    tx.delete(taskObservations).where(inArray(taskObservations.taskId, activeTaskIds)).run();

    for (const [serviceName, snapshot] of Object.entries(snapshots)) {
      const service = servicesByName.get(serviceName);
      if (!service || !snapshot) continue;

      for (const bucket of ["running", "retrying", "blocked"] as const) {
        for (const row of snapshot[bucket]) {
          const issueIdentifier = issueIdentifierFor(row);
          if (!issueIdentifier) continue;
          const taskId = taskIdFor(serviceName, issueIdentifier);
          const statusName = row.state ?? DEFAULT_STATUS_BY_BUCKET[bucket];
          const statusId = ensureStatus(tx, service.id, statusName, timestamp);

          tx.insert(tasks)
            .values({
              id: taskId,
              serviceId: service.id,
              issueIdentifier,
              title: issueIdentifier,
              statusId,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoNothing()
            .run();

          tx.insert(taskObservations)
            .values({
              taskId,
              bucket,
              trackerStatusId: row.state ? statusId : null,
              issueUrl: row.issue_url,
              error: row.error,
              workspacePath: row.workspace_path,
              startedAt: row.started_at,
              blockedAt: row.blocked_at,
              lastEvent: row.last_event,
              lastEventAt: row.last_event_at,
              attempt: row.attempt,
              dueAt: row.due_at,
              observedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: taskObservations.taskId,
              set: {
                bucket,
                trackerStatusId: row.state ? statusId : null,
                issueUrl: row.issue_url ?? null,
                error: row.error ?? null,
                workspacePath: row.workspace_path ?? null,
                startedAt: row.started_at ?? null,
                blockedAt: row.blocked_at ?? null,
                lastEvent: row.last_event ?? null,
                lastEventAt: row.last_event_at ?? null,
                attempt: row.attempt ?? null,
                dueAt: row.due_at ?? null,
                observedAt: timestamp,
              },
            })
            .run();
        }
      }
    }
  });
}
