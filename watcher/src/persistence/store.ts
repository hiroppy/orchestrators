import { and, asc, count, desc, eq, gt, inArray, ne, notInArray } from "drizzle-orm";

import type { WatcherDatabase } from "./database.ts";
import { services, statuses, taskEvents, taskObservations, tasks } from "./schema.ts";
import { isTerminalLinearStateType } from "../domain/linear.ts";
import type {
  ResolvedLinearTeamConfig,
  ServiceDefinition,
  Snapshot,
  SnapshotRow,
  SnapshotsByService,
  Task,
  TaskEvent,
  WatcherEvent,
} from "../domain/types.ts";

export const DEFAULT_DATABASE_PATH = "data/watcher/watcher.db";
type TaskEventInput = {
  taskId: string;
  type: string;
  actor?: string;
  fromStatus?: string;
  toStatus?: string;
  body?: string;
  slackThreadTs?: string;
  createdAt?: Date;
};
const DEFAULT_STATUS_BY_BUCKET = {
  running: "running",
  retrying: "Retrying",
  blocked: "Blocked",
} as const;

export class WatcherStore {
  private readonly db: WatcherDatabase;

  constructor(db: WatcherDatabase) {
    this.db = db;
  }

  syncDefinitions(
    serviceDefinitions: ServiceDefinition[],
    linearTeams: Record<string, ResolvedLinearTeamConfig>,
    now = new Date(),
  ): void {
    const timestamp = now.toISOString();

    this.db.transaction((tx) => {
      for (const service of serviceDefinitions) {
        tx.insert(services)
          .values({
            name: service.name,
            url: service.url,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: services.name,
            set: { url: service.url, updatedAt: timestamp },
          })
          .run();
      }

      for (const definition of serviceDefinitions) {
        const service = tx.select().from(services).where(eq(services.name, definition.name)).get()!;
        tx.update(statuses)
          .set({
            selectable: false,
            sortOrder: null,
            updatedAt: timestamp,
          })
          .where(eq(statuses.serviceId, service.id))
          .run();

        linearTeams[definition.linearTeam].statuses.forEach((name, sortOrder) => {
          tx.insert(statuses)
            .values({
              serviceId: service.id,
              name,
              sortOrder,
              selectable: true,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: [statuses.serviceId, statuses.name],
              set: { sortOrder, selectable: true, updatedAt: timestamp },
            })
            .run();
        });
      }
    });
  }

  getSelectableStatuses(serviceName: string): string[] {
    return this.db
      .select({ name: statuses.name })
      .from(statuses)
      .innerJoin(services, eq(statuses.serviceId, services.id))
      .where(and(eq(services.name, serviceName), eq(statuses.selectable, true)))
      .orderBy(asc(statuses.sortOrder))
      .all()
      .map(({ name }) => name);
  }

  getSnapshots(): SnapshotsByService {
    const serviceRows = this.db.select().from(services).all();
    const rows = this.db
      .select({
        task: tasks,
        observation: taskObservations,
        trackerStatus: statuses.name,
      })
      .from(taskObservations)
      .innerJoin(tasks, eq(taskObservations.taskId, tasks.id))
      .leftJoin(statuses, eq(taskObservations.trackerStatusId, statuses.id))
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

  replaceSnapshots(snapshots: SnapshotsByService, now = new Date()): void {
    const timestamp = now.toISOString();
    const serviceRows = this.db.select().from(services).all();
    const servicesByName = new Map(serviceRows.map((service) => [service.name, service]));

    this.db.transaction((tx) => {
      const observedTaskIds: string[] = [];

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
                lastMessage: row.last_message,
                error: row.error,
                workspacePath: row.workspace_path,
                startedAt: row.started_at,
                blockedAt: row.blocked_at,
                turnCount: row.turn_count,
                inputTokens: row.tokens?.input_tokens ?? row.tokens?.inputTokens,
                outputTokens: row.tokens?.output_tokens ?? row.tokens?.outputTokens,
                totalTokens: row.tokens?.total_tokens ?? row.tokens?.totalTokens,
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
                  lastMessage: row.last_message ?? null,
                  error: row.error ?? null,
                  workspacePath: row.workspace_path ?? null,
                  startedAt: row.started_at ?? null,
                  blockedAt: row.blocked_at ?? null,
                  turnCount: row.turn_count ?? null,
                  inputTokens: row.tokens?.input_tokens ?? row.tokens?.inputTokens ?? null,
                  outputTokens: row.tokens?.output_tokens ?? row.tokens?.outputTokens ?? null,
                  totalTokens: row.tokens?.total_tokens ?? row.tokens?.totalTokens ?? null,
                  lastEvent: row.last_event ?? null,
                  lastEventAt: row.last_event_at ?? null,
                  attempt: row.attempt ?? null,
                  dueAt: row.due_at ?? null,
                  observedAt: timestamp,
                },
              })
              .run();
            observedTaskIds.push(taskId);
          }
        }
      }

      if (observedTaskIds.length === 0) {
        tx.delete(taskObservations).run();
      } else {
        tx.delete(taskObservations)
          .where(notInArray(taskObservations.taskId, observedTaskIds))
          .run();
      }
    });
  }

  getTask(id: string): Task | undefined {
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

  getTasks(): Task[] {
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
      .all()
      .map((row) =>
        taskFromRow(row.task, row.serviceName, row.statusName, row.observationIssueUrl),
      );
  }

  getTasksForLinearSync(): Task[] {
    return this.getTasks().filter((task) => !isTerminalLinearStateType(task.linearStateType));
  }

  upsertTaskFromEvent(event: WatcherEvent, now = new Date()): Task {
    const timestamp = now.toISOString();
    const id = taskIdFor(event.service, event.issueIdentifier);
    const existing = this.getTask(id);
    const service = this.db.select().from(services).where(eq(services.name, event.service)).get();
    if (!service) throw new Error(`Service not found: ${event.service}`);
    const statusName = event.resolvedState ?? event.state ?? existing?.status ?? "Unknown";
    const statusId = ensureStatus(this.db, service.id, statusName, timestamp);

    this.db
      .insert(tasks)
      .values({
        id,
        serviceId: service.id,
        issueIdentifier: event.issueIdentifier,
        title: event.issueTitle ?? event.issueIdentifier,
        statusId,
        linearStateType: event.resolvedStateType,
        linkUrl: event.issueUrl,
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
          lastEventAt: event.lastEventAt ?? timestamp,
          updatedAt: timestamp,
        },
      })
      .run();

    return this.getTask(id)!;
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

  updateTaskStatus(
    taskId: string,
    statusName: string,
    now = new Date(),
  ): {
    task: Task;
    fromStatus: string;
  } {
    const existing = this.requireTask(taskId);
    const timestamp = now.toISOString();
    const status = this.db
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
    this.db
      .update(tasks)
      .set({
        statusId: status.id,
        linearStateType: null,
        updatedAt: timestamp,
      })
      .where(eq(tasks.id, taskId))
      .run();

    return { task: this.requireTask(taskId), fromStatus: existing.status };
  }

  addEvent(event: TaskEventInput): TaskEvent {
    return insertTaskEvent(this.db, event);
  }

  addEvents(events: TaskEventInput[]): TaskEvent[] {
    return this.db.transaction((tx) => events.map((event) => insertTaskEvent(tx, event)));
  }

  hasRecordedPullRequest(taskId: string, url: string): boolean {
    return this.db
      .select({ body: taskEvents.body })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), ne(taskEvents.type, "workpad_replied")))
      .all()
      .some(({ body }) => body?.includes(url));
  }

  hasRecordedSlackMessage(taskId: string, messageTs: string, eventType: string): boolean {
    return (
      this.db
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

  countEvents(taskId: string, type: string): number {
    return (
      this.db
        .select({ value: count() })
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, type)))
        .get()?.value ?? 0
    );
  }

  getLatestEvent(taskId: string, type: string): TaskEvent | undefined {
    const event = this.db
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, type)))
      .orderBy(desc(taskEvents.id))
      .get();
    if (!event) return undefined;

    const statusName = (statusId: number | null): string | undefined =>
      statusId === null
        ? undefined
        : this.db
            .select({ name: statuses.name })
            .from(statuses)
            .where(eq(statuses.id, statusId))
            .get()?.name;

    return {
      id: event.id,
      taskId: event.taskId,
      type: event.type,
      actor: event.actor ?? undefined,
      fromStatus: statusName(event.fromStatusId),
      toStatus: statusName(event.toStatusId),
      body: event.body ?? undefined,
      slackThreadTs: event.slackThreadTs ?? undefined,
      createdAt: event.createdAt,
    };
  }

  getTaskIdsWithIncompleteEvent(pendingType: string, completedType: string): string[] {
    const latestPending = new Map<string, number>();
    const latestCompleted = new Map<string, number>();
    const rows = this.db
      .select({ id: taskEvents.id, taskId: taskEvents.taskId, type: taskEvents.type })
      .from(taskEvents)
      .where(inArray(taskEvents.type, [pendingType, completedType]))
      .orderBy(asc(taskEvents.id))
      .all();

    for (const event of rows) {
      const target = event.type === pendingType ? latestPending : latestCompleted;
      target.set(event.taskId, event.id);
    }

    return [...latestPending].flatMap(([taskId, pendingId]) =>
      pendingId > (latestCompleted.get(taskId) ?? 0) ? [taskId] : [],
    );
  }

  countEventsAfterLatest(taskId: string, type: string, boundaryType: string): number {
    const latestBoundaryId = this.db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, boundaryType)))
      .orderBy(desc(taskEvents.id))
      .get()?.id;

    return (
      this.db
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

  private requireTask(taskId: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
}

export function taskIdFor(serviceName: string, issueIdentifier: string): string {
  return `${serviceName}:${issueIdentifier}`;
}

type Transaction = Parameters<WatcherDatabase["transaction"]>[0] extends (tx: infer T) => unknown
  ? T
  : never;

function ensureStatus(
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

function insertTaskEvent(db: WatcherDatabase | Transaction, event: TaskEventInput): TaskEvent {
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
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    body: event.body,
    slackThreadTs: event.slackThreadTs,
    createdAt: timestamp,
  };
}

function taskFromRow(
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
    parentChannelId: row.parentChannelId,
    parentMessageTs: row.parentMessageTs,
    lastRenderedSummary: row.lastRenderedSummary,
    lastEventAt: row.lastEventAt,
    updatedAt: row.updatedAt,
  }) as unknown as Task;
}

function observationToRow(
  issueIdentifier: string,
  row: typeof taskObservations.$inferSelect,
  trackerStatus: string | null,
): SnapshotRow {
  const tokens = compactObject({
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    total_tokens: row.totalTokens,
  });

  return compactObject({
    issue_identifier: issueIdentifier,
    issue_url: row.issueUrl,
    state: trackerStatus,
    last_message: row.lastMessage,
    error: row.error,
    workspace_path: row.workspacePath,
    started_at: row.startedAt,
    blocked_at: row.blockedAt,
    turn_count: row.turnCount,
    tokens: Object.keys(tokens).length > 0 ? tokens : null,
    last_event: row.lastEvent,
    last_event_at: row.lastEventAt,
    attempt: row.attempt,
    due_at: row.dueAt,
  }) as unknown as SnapshotRow;
}

function issueIdentifierFor(row: SnapshotRow): string | undefined {
  return row.issue_identifier ?? row.issueIdentifier;
}

function compactObject<T extends object>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  ) as T;
}
