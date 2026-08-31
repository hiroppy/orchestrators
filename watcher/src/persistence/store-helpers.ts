import { and, eq } from "drizzle-orm";

import type { WatcherDatabase } from "./database.ts";
import { statuses, taskEvents, taskObservations, tasks } from "./schema.ts";
import type { SnapshotRow } from "../domain/snapshot.ts";
import type { Task, TaskActivity, TaskEvent } from "../domain/task.ts";

export type TaskEventInput = {
  taskId: string;
  type: string;
  actor?: string;
  statusEventType?: "automatic" | "manual";
  statusEventLabel?: string;
  statusEventError?: string;
  statusEventKey?: string;
  fromStatus?: string;
  toStatus?: string;
  body?: string;
  slackThreadTs?: string;
  createdAt?: Date;
};

type Transaction = Parameters<WatcherDatabase["transaction"]>[0] extends (tx: infer T) => unknown
  ? T
  : never;

export function ensureStatus(
  db: WatcherDatabase | Transaction,
  serviceId: number,
  name: string,
  timestamp: string,
): number {
  db.insert(statuses)
    .values({
      serviceId,
      name,
      selectable: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing()
    .run();
  return db
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.serviceId, serviceId), eq(statuses.name, name)))
    .get()!.id;
}

export function insertTaskEvent(
  db: WatcherDatabase | Transaction,
  event: TaskEventInput,
): TaskEvent {
  const timestamp = (event.createdAt ?? new Date()).toISOString();
  const task = db
    .select({ serviceId: tasks.serviceId })
    .from(tasks)
    .where(eq(tasks.id, event.taskId))
    .get();
  if (!task) throw new Error(`Task not found: ${event.taskId}`);

  const fromStatusId = event.fromStatus
    ? ensureStatus(db, task.serviceId, event.fromStatus, timestamp)
    : undefined;
  const toStatusId = event.toStatus
    ? ensureStatus(db, task.serviceId, event.toStatus, timestamp)
    : undefined;
  const result = db
    .insert(taskEvents)
    .values({
      taskId: event.taskId,
      type: event.type,
      actor: event.actor,
      statusEventType: event.statusEventType,
      statusEventLabel: event.statusEventLabel,
      statusEventError: event.statusEventError,
      statusEventKey: event.statusEventKey,
      fromStatusId,
      toStatusId,
      body: event.body,
      slackThreadTs: event.slackThreadTs,
      createdAt: timestamp,
    })
    .run();

  return {
    id: Number(result.lastInsertRowid),
    taskId: event.taskId,
    type: event.type,
    actor: event.actor,
    statusEventType: event.statusEventType,
    statusEventLabel: event.statusEventLabel,
    statusEventError: event.statusEventError,
    statusEventKey: event.statusEventKey,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    body: event.body,
    slackThreadTs: event.slackThreadTs,
    createdAt: timestamp,
  };
}

export function taskFromRow(
  row: typeof tasks.$inferSelect,
  serviceName: string,
  statusName: string,
  observationIssueUrl: string | null,
): Task {
  return compactObject({
    id: row.id,
    serviceName,
    issueIdentifier: row.issueIdentifier,
    title: row.title,
    status: statusName,
    linearStateType: row.linearStateType,
    linkUrl: row.linkUrl ?? observationIssueUrl,
    pullRequest: row.pullRequestUrl
      ? {
          url: row.pullRequestUrl,
          ...(row.pullRequestNumber === null ? {} : { number: row.pullRequestNumber }),
          ...(row.pullRequestTitle === null ? {} : { title: row.pullRequestTitle }),
          ...(row.pullRequestLabels === null
            ? {}
            : { labels: JSON.parse(row.pullRequestLabels) as string[] }),
        }
      : undefined,
    parentChannelId: row.parentChannelId,
    parentMessageTs: row.parentMessageTs,
    lastRenderedSummary: row.lastRenderedSummary,
    lastEventAt: row.lastEventAt,
    currentActivity: row.currentActivity
      ? (JSON.parse(row.currentActivity) as TaskActivity)
      : undefined,
    activityPublishedAt: row.activityPublishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }) as unknown as Task;
}

export function observationToRow(
  issueIdentifier: string,
  row: typeof taskObservations.$inferSelect,
  trackerStatus: string | null,
): SnapshotRow {
  return compactObject({
    issue_identifier: issueIdentifier,
    issue_url: row.issueUrl,
    state: trackerStatus,
    error: row.error,
    workspace_path: row.workspacePath,
    started_at: row.startedAt,
    blocked_at: row.blockedAt,
    last_event: row.lastEvent,
    last_event_at: row.lastEventAt,
    attempt: row.attempt,
    due_at: row.dueAt,
  }) as unknown as SnapshotRow;
}

export function issueIdentifierFor(row: SnapshotRow): string | undefined {
  return row.issue_identifier ?? row.issueIdentifier;
}

function compactObject<T extends object>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  ) as T;
}
