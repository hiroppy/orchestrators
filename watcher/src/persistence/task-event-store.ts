import { and, asc, count, desc, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type { TaskEvent } from "../domain/types.ts";
import type { WatcherDatabase } from "./database.ts";
import { services, statuses, taskEvents, tasks } from "./schema.ts";
import { insertTaskEvent, type TaskEventInput } from "./store-helpers.ts";

export function addTaskEvent(db: WatcherDatabase, event: TaskEventInput): TaskEvent {
  return insertTaskEvent(db, event);
}

export function addTaskEvents(db: WatcherDatabase, events: TaskEventInput[]): TaskEvent[] {
  return db.transaction((tx) => events.map((event) => insertTaskEvent(tx, event)));
}

export function hasRecordedSlackMessage(
  db: WatcherDatabase,
  taskId: string,
  messageTs: string,
  eventType: string,
): boolean {
  return (
    db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.taskId, taskId),
          eq(taskEvents.slackThreadTs, messageTs),
          eq(taskEvents.type, eventType),
        ),
      )
      .get() !== undefined
  );
}

export function hasTaskEvent(
  db: WatcherDatabase,
  taskId: string,
  type: string,
  body: string,
): boolean {
  return (
    db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(
        and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, type), eq(taskEvents.body, body)),
      )
      .get() !== undefined
  );
}

export function countTaskEvents(db: WatcherDatabase, taskId: string, type: string): number {
  return (
    db
      .select({ value: count() })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, type)))
      .get()?.value ?? 0
  );
}

export function countTaskEventsWithBody(
  db: WatcherDatabase,
  taskId: string,
  type: string,
  body: string,
): number {
  return (
    db
      .select({ count: count() })
      .from(taskEvents)
      .where(
        and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, type), eq(taskEvents.body, body)),
      )
      .get()?.count ?? 0
  );
}

export function getLatestTaskEvent(
  db: WatcherDatabase,
  taskId: string,
  type: string,
): TaskEvent | undefined {
  const fromStatuses = alias(statuses, "event_from_status");
  const toStatuses = alias(statuses, "event_to_status");
  const row = db
    .select({ event: taskEvents, fromStatus: fromStatuses.name, toStatus: toStatuses.name })
    .from(taskEvents)
    .leftJoin(fromStatuses, eq(taskEvents.fromStatusId, fromStatuses.id))
    .leftJoin(toStatuses, eq(taskEvents.toStatusId, toStatuses.id))
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, type)))
    .orderBy(desc(taskEvents.id))
    .get();
  return row ? eventFromRow(row) : undefined;
}

export function getLatestTaskEventsByType(
  db: WatcherDatabase,
  taskId: string,
  type: string,
  limit: number,
): TaskEvent[] {
  const fromStatuses = alias(statuses, "typed_event_from_status");
  const toStatuses = alias(statuses, "typed_event_to_status");
  return db
    .select({ event: taskEvents, fromStatus: fromStatuses.name, toStatus: toStatuses.name })
    .from(taskEvents)
    .leftJoin(fromStatuses, eq(taskEvents.fromStatusId, fromStatuses.id))
    .leftJoin(toStatuses, eq(taskEvents.toStatusId, toStatuses.id))
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, type)))
    .orderBy(desc(taskEvents.id))
    .limit(limit)
    .all()
    .map(eventFromRow);
}

export function getTaskIdsWithIncompleteEvent(
  db: WatcherDatabase,
  pendingType: string,
  completedType: string,
): string[] {
  const rows = db
    .select({
      taskId: taskEvents.taskId,
      latestPending: sql<
        number | null
      >`max(case when ${taskEvents.type} = ${pendingType} then ${taskEvents.id} end)`,
      latestCompleted: sql<number>`coalesce(max(case when ${taskEvents.type} = ${completedType} then ${taskEvents.id} end), 0)`,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(services, eq(tasks.serviceId, services.id))
    .where(and(inArray(taskEvents.type, [pendingType, completedType]), eq(services.active, true)))
    .groupBy(taskEvents.taskId)
    .all();

  return rows.flatMap(({ taskId, latestPending, latestCompleted }) =>
    latestPending !== null && latestPending > latestCompleted ? [taskId] : [],
  );
}

export function getUncompletedTaskEvents(
  db: WatcherDatabase,
  pendingType: string,
  completedType: string,
  taskId?: string,
): TaskEvent[] {
  const completed = alias(taskEvents, "completed_task_events");
  const fromStatuses = alias(statuses, "pending_from_status");
  const toStatuses = alias(statuses, "pending_to_status");
  const conditions = [
    eq(taskEvents.type, pendingType),
    notExists(
      db
        .select({ id: completed.id })
        .from(completed)
        .where(
          and(
            eq(completed.type, completedType),
            eq(completed.body, sql`cast(${taskEvents.id} as text)`),
          ),
        ),
    ),
  ];
  if (taskId) conditions.push(eq(taskEvents.taskId, taskId));

  return db
    .select({ event: taskEvents, fromStatus: fromStatuses.name, toStatus: toStatuses.name })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(services, eq(tasks.serviceId, services.id))
    .leftJoin(fromStatuses, eq(taskEvents.fromStatusId, fromStatuses.id))
    .leftJoin(toStatuses, eq(taskEvents.toStatusId, toStatuses.id))
    .where(and(...conditions, eq(services.active, true)))
    .orderBy(asc(taskEvents.id))
    .all()
    .map(eventFromRow);
}

export function countTaskEventsAfterLatest(
  db: WatcherDatabase,
  taskId: string,
  type: string,
  boundaryType: string,
): number {
  const latestBoundaryId = db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, boundaryType)))
    .orderBy(desc(taskEvents.id))
    .get()?.id;

  return (
    db
      .select({ value: count() })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.taskId, taskId),
          eq(taskEvents.type, type),
          latestBoundaryId === undefined ? undefined : gt(taskEvents.id, latestBoundaryId),
        ),
      )
      .get()?.value ?? 0
  );
}

function eventFromRow({
  event,
  fromStatus,
  toStatus,
}: {
  event: typeof taskEvents.$inferSelect;
  fromStatus: string | null;
  toStatus: string | null;
}): TaskEvent {
  return {
    id: event.id,
    taskId: event.taskId,
    type: event.type,
    actor: event.actor ?? undefined,
    statusEventType: event.statusEventType ?? undefined,
    statusEventLabel: event.statusEventLabel ?? undefined,
    statusEventError: event.statusEventError ?? undefined,
    fromStatus: fromStatus ?? undefined,
    toStatus: toStatus ?? undefined,
    body: event.body ?? undefined,
    slackThreadTs: event.slackThreadTs ?? undefined,
    createdAt: event.createdAt,
  };
}
