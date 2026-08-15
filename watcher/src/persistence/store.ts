import { asc, and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";

import type { WatcherDatabase } from "./database.ts";
import {
  services,
  statuses,
  taskAssignees,
  taskEvents,
  taskObservations,
  tasks,
} from "./schema.ts";
import { isTerminalLinearState, TERMINAL_LINEAR_STATE_TYPES } from "../domain/linear.ts";
import { normalizeStatus } from "../domain/status.ts";
import type {
  LinearWorkflowStateType,
  ResolvedLinearTeamConfig,
  ServiceDefinition,
  Snapshot,
  SnapshotsByService,
  Task,
  TaskEvent,
  WatcherEvent,
} from "../domain/types.ts";
import {
  ensureStatus,
  issueIdentifierFor,
  observationToRow,
  taskFromRow,
  type TaskEventInput,
} from "./store-helpers.ts";
import {
  addTaskEvent,
  addTaskEvents,
  countTaskEvents,
  countTaskEventsAfterLatest,
  countTaskEventsWithBody,
  getLatestTaskEvent,
  getTaskIdsWithIncompleteEvent,
  getUncompletedTaskEvents,
  hasRecordedPullRequest,
  hasRecordedSlackMessage,
  hasTaskEvent,
} from "./task-event-store.ts";
import { syncDefinitions } from "./definitions.ts";

export type { TaskEventInput } from "./store-helpers.ts";

export const DEFAULT_DATABASE_PATH = "data/watcher/watcher.db";
const TAKE_PR_ACTIVE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_STATUS_BY_BUCKET = {
  running: "running",
  retrying: "Retrying",
  blocked: "Blocked",
} as const;

export interface PendingTakePrRequest {
  id: string;
  pullRequestUrl: string;
  repository: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  headBranch: string;
  baseBranch: string;
  channelId: string;
  threadTs: string;
  requesterSlackUserId?: string;
  createdAt: string;
}

type NewPendingTakePrRequest = Omit<PendingTakePrRequest, "createdAt">;

export class WatcherStore {
  private readonly db: WatcherDatabase;
  private readonly pendingTakePrRequests = new Map<string, PendingTakePrRequest>();

  constructor(db: WatcherDatabase) {
    this.db = db;
  }

  syncDefinitions(
    serviceDefinitions: ServiceDefinition[],
    linearTeams: Record<string, ResolvedLinearTeamConfig>,
    now = new Date(),
  ): void {
    syncDefinitions(this.db, serviceDefinitions, linearTeams, now);
  }

  getSelectableStatuses(serviceName: string): string[] {
    return this.db
      .select({ name: statuses.name })
      .from(statuses)
      .innerJoin(services, eq(statuses.serviceId, services.id))
      .where(
        and(
          eq(services.name, serviceName),
          eq(services.active, true),
          eq(statuses.selectable, true),
        ),
      )
      .orderBy(asc(statuses.sortOrder))
      .all()
      .map(({ name }) => name);
  }

  getSnapshots(): SnapshotsByService {
    const serviceRows = this.db.select().from(services).where(eq(services.active, true)).all();
    const rows = this.db
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

  replaceSnapshots(snapshots: SnapshotsByService, now = new Date()): void {
    const timestamp = now.toISOString();
    const serviceRows = this.db.select().from(services).where(eq(services.active, true)).all();
    const servicesByName = new Map(serviceRows.map((service) => [service.name, service]));
    const activeTaskIds = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(services, eq(tasks.serviceId, services.id))
      .where(eq(services.active, true));

    this.db.transaction((tx) => {
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

  getTasksForLinearSync(
    includedTaskIds: ReadonlySet<string> = new Set(),
    statusTypeOverrides: Record<string, LinearWorkflowStateType> = {},
  ): Task[] {
    const normalizedOverrideStatuses = new Set(Object.keys(statusTypeOverrides));
    const overrideStatusNames =
      normalizedOverrideStatuses.size === 0
        ? []
        : this.db
            .selectDistinct({ name: statuses.name })
            .from(statuses)
            .all()
            .filter(({ name }) => normalizedOverrideStatuses.has(normalizeStatus(name)))
            .map(({ name }) => name);
    const rawStateFilter = or(
      isNull(tasks.linearStateType),
      notInArray(tasks.linearStateType, [...TERMINAL_LINEAR_STATE_TYPES]),
      includedTaskIds.size > 0 ? inArray(tasks.id, [...includedTaskIds]) : undefined,
      overrideStatusNames.length > 0 ? inArray(statuses.name, overrideStatusNames) : undefined,
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
      .where(and(eq(services.active, true), rawStateFilter))
      .all()
      .map((row) => taskFromRow(row.task, row.serviceName, row.statusName, row.observationIssueUrl))
      .filter(
        (task) =>
          includedTaskIds.has(task.id) ||
          task.linearStateType == null ||
          !isTerminalLinearState(task.linearStateType, task.status, statusTypeOverrides),
      );
  }

  upsertTaskFromEvent(event: WatcherEvent, now = new Date()): Task {
    const timestamp = now.toISOString();
    const id = taskIdFor(event.service, event.issueIdentifier);
    const existing = this.getTask(id);
    const service = this.db.select().from(services).where(eq(services.name, event.service)).get();
    if (!service) throw new Error(`Service not found: ${event.service}`);
    const statusName = event.resolvedState ?? event.state ?? existing?.status ?? "Unknown";
    const statusId = ensureStatus(this.db, service.id, statusName, timestamp);
    const pullRequestLabels = JSON.stringify(event.pullRequest?.labels);

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
        pullRequestUrl: event.pullRequest?.url,
        pullRequestNumber: event.pullRequest?.number,
        pullRequestLabels,
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
          pullRequestLabels,
          lastEventAt: event.lastEventAt ?? timestamp,
          updatedAt: timestamp,
        },
      })
      .run();

    return this.getTask(id)!;
  }

  upsertTaskFromEventAtomically(
    event: WatcherEvent,
    createEvent: (task: Task, previousTask: Task | undefined) => TaskEventInput | undefined,
    now = new Date(),
  ): { task: Task; previousTask: Task | undefined; transitionEvent: TaskEvent | undefined } {
    return this.db.transaction(() => {
      const previousTask = this.getTask(taskIdFor(event.service, event.issueIdentifier));
      const task = this.upsertTaskFromEvent(event, now);
      const eventInput = createEvent(task, previousTask);
      const transitionEvent = eventInput ? this.addEvent(eventInput) : undefined;
      return { task, previousTask, transitionEvent };
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

  restoreTaskState(
    taskId: string,
    statusName: string,
    stateType: string | undefined,
    transitionEventId?: number,
    expectedCurrentStatus?: string,
    now = new Date(),
  ): void {
    this.db.transaction(() => {
      if (
        expectedCurrentStatus !== undefined &&
        this.requireTask(taskId).status !== expectedCurrentStatus
      ) {
        return;
      }
      const status = this.db
        .select({ id: statuses.id })
        .from(statuses)
        .innerJoin(tasks, eq(statuses.serviceId, tasks.serviceId))
        .where(and(eq(tasks.id, taskId), eq(statuses.name, statusName)))
        .get();
      if (!status) throw new Error(`Previous status not found for ${taskId}: ${statusName}`);

      this.db
        .update(tasks)
        .set({
          statusId: status.id,
          linearStateType: stateType ?? null,
          updatedAt: now.toISOString(),
        })
        .where(eq(tasks.id, taskId))
        .run();
      if (transitionEventId !== undefined) {
        this.db.delete(taskEvents).where(eq(taskEvents.id, transitionEventId)).run();
      }
    });
  }

  assignTask(taskId: string, slackUserId: string, now = new Date()): boolean {
    const result = this.db
      .insert(taskAssignees)
      .values({
        taskId,
        slackUserId,
        createdAt: now.toISOString(),
      })
      .onConflictDoNothing()
      .run();

    return result.changes > 0;
  }

  unassignTask(taskId: string, slackUserId: string): boolean {
    const result = this.db
      .delete(taskAssignees)
      .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, slackUserId)))
      .run();

    return result.changes > 0;
  }

  getTaskAssignees(taskId: string): string[] {
    return this.db
      .select({ slackUserId: taskAssignees.slackUserId })
      .from(taskAssignees)
      .where(eq(taskAssignees.taskId, taskId))
      .orderBy(asc(taskAssignees.createdAt), asc(taskAssignees.slackUserId))
      .all()
      .map(({ slackUserId }) =>
        slackUserId.startsWith("!subteam^") ? `<${slackUserId}>` : `<@${slackUserId}>`,
      );
  }

  createPendingTakePrRequest(
    request: NewPendingTakePrRequest,
    now = new Date(),
  ): PendingTakePrRequest {
    this.pruneExpiredTakePrRequests(now);
    const existing = this.pendingTakePrRequests.get(request.id);
    if (existing) return existing;
    const pending: PendingTakePrRequest = {
      ...request,
      createdAt: now.toISOString(),
    };
    this.pendingTakePrRequests.set(request.id, pending);
    return pending;
  }

  getPendingTakePrRequest(id: string, now = new Date()): PendingTakePrRequest | undefined {
    this.pruneExpiredTakePrRequests(now);
    return this.pendingTakePrRequests.get(id);
  }

  takePendingTakePrRequest(id: string, now = new Date()): PendingTakePrRequest | undefined {
    const request = this.getPendingTakePrRequest(id, now);
    if (request) this.pendingTakePrRequests.delete(id);
    return request;
  }

  restorePendingTakePrRequest(request: PendingTakePrRequest): void {
    this.pendingTakePrRequests.set(request.id, request);
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

  updateTaskStatusAtomically(
    taskId: string,
    statusName: string,
    createEvents: (task: Task, fromStatus: string) => TaskEventInput | TaskEventInput[] | undefined,
    now = new Date(),
  ): { task: Task; fromStatus: string; transitionEvent: TaskEvent | undefined } {
    return this.db.transaction(() => {
      const transition = this.updateTaskStatus(taskId, statusName, now);
      const events = createEvents(transition.task, transition.fromStatus);
      const transitionEvents = events
        ? (Array.isArray(events) ? events : [events]).map((event) => this.addEvent(event))
        : [];
      return { ...transition, transitionEvent: transitionEvents[0] };
    });
  }

  addEvent(event: TaskEventInput): TaskEvent {
    return addTaskEvent(this.db, event);
  }

  addEvents(events: TaskEventInput[]): TaskEvent[] {
    return addTaskEvents(this.db, events);
  }

  hasRecordedPullRequest(taskId: string, url: string): boolean {
    return hasRecordedPullRequest(this.db, taskId, url);
  }

  hasRecordedSlackMessage(taskId: string, messageTs: string, eventType: string): boolean {
    return hasRecordedSlackMessage(this.db, taskId, messageTs, eventType);
  }

  hasEvent(taskId: string, type: string, body: string): boolean {
    return hasTaskEvent(this.db, taskId, type, body);
  }

  countEvents(taskId: string, type: string): number {
    return countTaskEvents(this.db, taskId, type);
  }

  countEventsWithBody(taskId: string, type: string, body: string): number {
    return countTaskEventsWithBody(this.db, taskId, type, body);
  }

  getLatestEvent(taskId: string, type: string): TaskEvent | undefined {
    return getLatestTaskEvent(this.db, taskId, type);
  }

  getTaskIdsWithIncompleteEvent(pendingType: string, completedType: string): string[] {
    return getTaskIdsWithIncompleteEvent(this.db, pendingType, completedType);
  }

  getUncompletedEvents(pendingType: string, completedType: string, taskId?: string): TaskEvent[] {
    return getUncompletedTaskEvents(this.db, pendingType, completedType, taskId);
  }

  countEventsAfterLatest(taskId: string, type: string, boundaryType: string): number {
    return countTaskEventsAfterLatest(this.db, taskId, type, boundaryType);
  }

  private requireTask(taskId: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private pruneExpiredTakePrRequests(now: Date): void {
    for (const [id, request] of this.pendingTakePrRequests) {
      if (Date.parse(request.createdAt) <= now.getTime() - TAKE_PR_ACTIVE_RETENTION_MS) {
        this.pendingTakePrRequests.delete(id);
      }
    }
  }
}

export function taskIdFor(serviceName: string, issueIdentifier: string): string {
  return `${serviceName}:${issueIdentifier}`;
}
