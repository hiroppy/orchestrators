import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { TERMINAL_LINEAR_STATE_TYPES } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { Task } from "../domain/task.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import type { WatcherDatabase } from "./database.ts";
import { services, statuses, taskObservations, tasks } from "./schema.ts";
import { ensureStatus, taskFromRow, type TaskEventInput } from "./store-helpers.ts";
import { addTaskEvent } from "./task-event-store.ts";

type TaskStoreDatabase = Parameters<typeof ensureStatus>[0];

export class TaskStore {
  private readonly db: WatcherDatabase;

  constructor(db: WatcherDatabase) {
    this.db = db;
  }

  getTask(id: string, db: TaskStoreDatabase = this.db): Task | undefined {
    const row = db
      .select({
        task: tasks,
        serviceName: services.name,
        statusName: statuses.name,
        observationIssueUrl: taskObservations.issueUrl,
      })
      .from(tasks)
      .innerJoin(services, eq(tasks.serviceId, services.id))
      .innerJoin(statuses, eq(tasks.statusId, statuses.id))
      .leftJoin(taskObservations, eq(tasks.id, taskObservations.taskId))
      .where(eq(tasks.id, id))
      .get();

    return row
      ? taskFromRow(row.task, row.serviceName, row.statusName, row.observationIssueUrl)
      : undefined;
  }

  getTaskBySlackThread(channel: string, threadTs: string): Task | undefined {
    const row = this.db
      .select({
        task: tasks,
        serviceName: services.name,
        statusName: statuses.name,
        observationIssueUrl: taskObservations.issueUrl,
      })
      .from(tasks)
      .innerJoin(services, eq(tasks.serviceId, services.id))
      .innerJoin(statuses, eq(tasks.statusId, statuses.id))
      .leftJoin(taskObservations, eq(tasks.id, taskObservations.taskId))
      .where(and(eq(tasks.parentChannelId, channel), eq(tasks.parentMessageTs, threadTs)))
      .get();

    return row
      ? taskFromRow(row.task, row.serviceName, row.statusName, row.observationIssueUrl)
      : undefined;
  }

  getTasksForLinearSync(
    includedTaskIds: ReadonlySet<string> = new Set(),
    includedStatusesByService: ReadonlyMap<string, readonly string[]> = new Map(),
    includeTerminalTasks = false,
  ): Task[] {
    const includedStatusConditions = [...includedStatusesByService].flatMap(
      ([serviceName, statusNames]) => {
        const normalizedStatusNames = [...new Set(statusNames.map(normalizeStatus))];
        if (normalizedStatusNames.length === 0) return [];
        return [
          and(
            eq(services.name, serviceName),
            inArray(sql<string>`lower(trim(${statuses.name}))`, normalizedStatusNames),
          ),
        ];
      },
    );
    const activeOrIncluded = includeTerminalTasks
      ? undefined
      : or(
          isNull(tasks.linearStateType),
          notInArray(tasks.linearStateType, [...TERMINAL_LINEAR_STATE_TYPES]),
          includedTaskIds.size > 0 ? inArray(tasks.id, [...includedTaskIds]) : undefined,
          ...includedStatusConditions,
        );

    return this.db
      .select({
        task: tasks,
        serviceName: services.name,
        statusName: statuses.name,
        observationIssueUrl: taskObservations.issueUrl,
      })
      .from(tasks)
      .innerJoin(services, eq(tasks.serviceId, services.id))
      .innerJoin(statuses, eq(tasks.statusId, statuses.id))
      .leftJoin(taskObservations, eq(tasks.id, taskObservations.taskId))
      .where(and(eq(services.active, true), activeOrIncluded))
      .all()
      .map((row) =>
        taskFromRow(row.task, row.serviceName, row.statusName, row.observationIssueUrl),
      );
  }

  upsertTaskFromEvent(
    event: WatcherEvent,
    now = new Date(),
    db: TaskStoreDatabase = this.db,
  ): Task {
    const timestamp = now.toISOString();
    const id = taskIdFor(event.service, event.issueIdentifier);
    const existing = this.getTask(id, db);
    const service = db.select().from(services).where(eq(services.name, event.service)).get();
    if (!service) throw new Error(`Service not found: ${event.service}`);
    const statusName = event.resolvedState ?? event.state ?? existing?.status ?? "Unknown";
    const statusId = ensureStatus(db, service.id, statusName, timestamp);
    const pullRequestLabels = JSON.stringify(event.pullRequest?.labels);

    db.insert(tasks)
      .values({
        id,
        serviceId: service.id,
        issueIdentifier: event.issueIdentifier,
        title: event.issueTitle ?? event.issueIdentifier,
        statusId,
        linearStateType: event.resolvedStateType,
        linkUrl: event.issueUrl,
        pullRequestUrl: event.pullRequest?.url,
        pullRequestNumber: event.pullRequest?.number,
        pullRequestTitle: event.pullRequest?.title,
        pullRequestLabels,
        pullRequestHeadRefOid: event.pullRequest?.headRefOid,
        lastEventAt: event.lastEventAt ?? timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: tasks.id,
        set: {
          title: event.issueTitle ?? existing?.title ?? event.issueIdentifier,
          statusId,
          linearStateType: event.resolvedStateType ?? existing?.linearStateType,
          linkUrl: event.issueUrl ?? existing?.linkUrl,
          pullRequestUrl: event.pullRequest?.url ?? existing?.pullRequest?.url,
          pullRequestNumber: event.pullRequest?.number ?? existing?.pullRequest?.number,
          pullRequestTitle: event.pullRequest?.title ?? existing?.pullRequest?.title,
          pullRequestLabels,
          pullRequestHeadRefOid: event.pullRequest?.headRefOid ?? existing?.pullRequest?.headRefOid,
          lastEventAt: event.lastEventAt ?? timestamp,
          updatedAt: timestamp,
        },
      })
      .run();

    return this.getTask(id, db)!;
  }

  upsertTaskFromEventAtomically(
    event: WatcherEvent,
    createEvent: (task: Task, previousTask: Task | undefined) => TaskEventInput | undefined,
    now = new Date(),
  ): { task: Task; previousTask: Task | undefined } {
    return this.db.transaction((tx) => {
      const previousTask = this.getTask(taskIdFor(event.service, event.issueIdentifier), tx);
      const task = this.upsertTaskFromEvent(event, now, tx);
      const transitionEvent = createEvent(task, previousTask);
      if (transitionEvent) addTaskEvent(tx, transitionEvent);
      return { task, previousTask };
    });
  }

  setParentMessage(
    taskId: string,
    channel: string,
    ts: string,
    summary: string,
    now = new Date(),
  ): Task {
    this.db
      .update(tasks)
      .set({
        parentChannelId: channel,
        parentMessageTs: ts,
        lastRenderedSummary: summary,
        updatedAt: now.toISOString(),
      })
      .where(eq(tasks.id, taskId))
      .run();

    return this.requireTask(taskId);
  }

  setRenderedSummary(taskId: string, summary: string, now = new Date()): void {
    this.db
      .update(tasks)
      .set({
        lastRenderedSummary: summary,
        updatedAt: now.toISOString(),
      })
      .where(eq(tasks.id, taskId))
      .run();
  }

  setTaskLinearStateType(taskId: string, stateType: string | undefined, now = new Date()): void {
    this.db
      .update(tasks)
      .set({
        linearStateType: stateType ?? null,
        updatedAt: now.toISOString(),
      })
      .where(eq(tasks.id, taskId))
      .run();
  }

  setTaskPullRequest(taskId: string, pullRequest: Task["pullRequest"], now = new Date()): void {
    this.db
      .update(tasks)
      .set({
        pullRequestUrl: pullRequest?.url ?? null,
        pullRequestNumber: pullRequest?.number ?? null,
        pullRequestTitle: pullRequest?.title ?? null,
        pullRequestLabels: pullRequest ? JSON.stringify(pullRequest.labels ?? []) : null,
        pullRequestHeadRefOid: pullRequest?.headRefOid ?? null,
        updatedAt: now.toISOString(),
      })
      .where(eq(tasks.id, taskId))
      .run();
  }

  updateTaskStatus(
    taskId: string,
    statusName: string,
    now = new Date(),
    db: TaskStoreDatabase = this.db,
  ): {
    task: Task;
    fromStatus: string;
  } {
    const existing = this.requireTask(taskId, db);
    const timestamp = now.toISOString();
    const status = db
      .select({ id: statuses.id })
      .from(statuses)
      .innerJoin(tasks, eq(statuses.serviceId, tasks.serviceId))
      .where(
        and(eq(tasks.id, taskId), eq(statuses.name, statusName), eq(statuses.selectable, true)),
      )
      .get();
    if (!status) {
      throw new Error(`Status is not configured for ${existing.serviceName}: ${statusName}`);
    }
    db.update(tasks)
      .set({
        statusId: status.id,
        linearStateType: null,
        updatedAt: timestamp,
      })
      .where(eq(tasks.id, taskId))
      .run();

    return { task: this.requireTask(taskId, db), fromStatus: existing.status };
  }

  updateTaskStatusAtomically(
    taskId: string,
    statusName: string,
    createEvents: (task: Task, fromStatus: string) => TaskEventInput | TaskEventInput[] | undefined,
    now = new Date(),
  ): { task: Task; fromStatus: string } {
    return this.db.transaction((tx) => {
      const transition = this.updateTaskStatus(taskId, statusName, now, tx);
      const events = createEvents(transition.task, transition.fromStatus);
      if (events) {
        for (const event of Array.isArray(events) ? events : [events]) addTaskEvent(tx, event);
      }
      return transition;
    });
  }

  setTaskActivity(taskId: string, activity: Task["currentActivity"]): void {
    const update = activity
      ? { currentActivity: JSON.stringify(activity) }
      : { currentActivity: null, activityPublishedAt: null };
    this.db.update(tasks).set(update).where(eq(tasks.id, taskId)).run();
  }

  markTaskActivityPublished(taskId: string, publishedAt: Date): void {
    this.db
      .update(tasks)
      .set({ activityPublishedAt: publishedAt.toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
  }

  private requireTask(taskId: string, db: TaskStoreDatabase = this.db): Task {
    const task = this.getTask(taskId, db);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
}

export function taskIdFor(serviceName: string, issueIdentifier: string): string {
  return `${serviceName}:${issueIdentifier}`;
}
