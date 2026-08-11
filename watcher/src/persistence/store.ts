import { asc, and, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";

import type { WatcherDatabase } from "./database.ts";
import {
  pendingTakePrRequests,
  services,
  statuses,
  taskNotificationMentions,
  taskObservations,
  tasks,
} from "./schema.ts";
import { TERMINAL_LINEAR_STATE_TYPES } from "../domain/linear.ts";
import type {
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
const TAKE_PR_PROCESSING_LEASE_MS = 5 * 60 * 1_000;
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
  headBranch: string;
  baseBranch: string;
  channelId: string;
  threadTs: string;
  requesterSlackUserId?: string;
  status: "pending" | "processing" | "created" | "completed";
  selectedService?: string;
  linearIssueIdentifier?: string;
  linearIssueUrl?: string;
  createdAt: string;
  updatedAt: string;
}

type NewPendingTakePrRequest = Omit<
  PendingTakePrRequest,
  | "status"
  | "selectedService"
  | "linearIssueIdentifier"
  | "linearIssueUrl"
  | "createdAt"
  | "updatedAt"
>;

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

  getTasksForLinearSync(includedTaskIds: ReadonlySet<string> = new Set()): Task[] {
    const activeOrIncluded = or(
      isNull(tasks.linearStateType),
      notInArray(tasks.linearStateType, [...TERMINAL_LINEAR_STATE_TYPES]),
      includedTaskIds.size > 0 ? inArray(tasks.id, [...includedTaskIds]) : undefined,
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
        pullRequestUrl: event.pullRequest?.url,
        pullRequestNumber: event.pullRequest?.number,
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
  ): { task: Task; previousTask: Task | undefined } {
    return this.db.transaction(() => {
      const previousTask = this.getTask(taskIdFor(event.service, event.issueIdentifier));
      const task = this.upsertTaskFromEvent(event, now);
      const transitionEvent = createEvent(task, previousTask);
      if (transitionEvent) this.addEvent(transitionEvent);
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

  assignTaskNotificationMention(taskId: string, slackUserId: string, now = new Date()): boolean {
    const result = this.db
      .insert(taskNotificationMentions)
      .values({
        taskId,
        slackUserId,
        createdAt: now.toISOString(),
      })
      .onConflictDoNothing()
      .run();

    return result.changes > 0;
  }

  getTaskNotificationMentions(taskId: string): string[] {
    return this.db
      .select({ slackUserId: taskNotificationMentions.slackUserId })
      .from(taskNotificationMentions)
      .where(eq(taskNotificationMentions.taskId, taskId))
      .orderBy(asc(taskNotificationMentions.createdAt), asc(taskNotificationMentions.slackUserId))
      .all()
      .map(({ slackUserId }) => `<@${slackUserId}>`);
  }

  createPendingTakePrRequest(
    request: NewPendingTakePrRequest,
    now = new Date(),
  ): PendingTakePrRequest {
    const timestamp = now.toISOString();
    this.db
      .insert(pendingTakePrRequests)
      .values({
        ...request,
        requesterSlackUserId: request.requesterSlackUserId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.requirePendingTakePrRequest(request.id);
  }

  getPendingTakePrRequest(id: string): PendingTakePrRequest | undefined {
    const row = this.db
      .select()
      .from(pendingTakePrRequests)
      .where(eq(pendingTakePrRequests.id, id))
      .get();
    return row ? pendingTakePrRequestFromRow(row) : undefined;
  }

  claimPendingTakePrRequest(
    id: string,
    selectedService: string,
    now = new Date(),
  ): PendingTakePrRequest | undefined {
    return this.db.transaction(() => {
      const request = this.getPendingTakePrRequest(id);
      if (!request || !takePrRequestCanBeClaimed(request, selectedService, now)) return undefined;

      const staleBefore = new Date(now.getTime() - TAKE_PR_PROCESSING_LEASE_MS).toISOString();

      const result = this.db
        .update(pendingTakePrRequests)
        .set({
          status: "processing",
          selectedService,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(pendingTakePrRequests.id, id),
            or(
              eq(pendingTakePrRequests.status, "pending"),
              and(
                eq(pendingTakePrRequests.status, "created"),
                eq(pendingTakePrRequests.selectedService, selectedService),
              ),
              and(
                eq(pendingTakePrRequests.status, "processing"),
                eq(pendingTakePrRequests.selectedService, selectedService),
                lte(pendingTakePrRequests.updatedAt, staleBefore),
              ),
            ),
          ),
        )
        .run();
      if (result.changes === 0) return undefined;
      return this.requirePendingTakePrRequest(id);
    });
  }

  releasePendingTakePrRequest(id: string, now = new Date()): void {
    this.db
      .update(pendingTakePrRequests)
      .set({
        status: "pending",
        selectedService: null,
        updatedAt: now.toISOString(),
      })
      .where(and(eq(pendingTakePrRequests.id, id), eq(pendingTakePrRequests.status, "processing")))
      .run();
  }

  markPendingTakePrIssueCreated(
    id: string,
    linearIssueIdentifier: string,
    linearIssueUrl: string,
    now = new Date(),
  ): void {
    this.db
      .update(pendingTakePrRequests)
      .set({
        status: "created",
        linearIssueIdentifier,
        linearIssueUrl,
        updatedAt: now.toISOString(),
      })
      .where(and(eq(pendingTakePrRequests.id, id), eq(pendingTakePrRequests.status, "processing")))
      .run();
  }

  restorePendingTakePrIssueCreated(id: string, now = new Date()): void {
    this.db
      .update(pendingTakePrRequests)
      .set({ status: "created", updatedAt: now.toISOString() })
      .where(and(eq(pendingTakePrRequests.id, id), eq(pendingTakePrRequests.status, "processing")))
      .run();
  }

  completePendingTakePrRequest(id: string, linearIssueUrl: string, now = new Date()): void {
    this.db
      .update(pendingTakePrRequests)
      .set({
        status: "completed",
        linearIssueUrl,
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(pendingTakePrRequests.id, id),
          or(
            eq(pendingTakePrRequests.status, "created"),
            eq(pendingTakePrRequests.status, "processing"),
          ),
        ),
      )
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

  updateTaskStatusAtomically(
    taskId: string,
    statusName: string,
    createEvent: (task: Task, fromStatus: string) => TaskEventInput | undefined,
    now = new Date(),
  ): { task: Task; fromStatus: string } {
    return this.db.transaction(() => {
      const transition = this.updateTaskStatus(taskId, statusName, now);
      const event = createEvent(transition.task, transition.fromStatus);
      if (event) this.addEvent(event);
      return transition;
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

  private requirePendingTakePrRequest(id: string): PendingTakePrRequest {
    const request = this.getPendingTakePrRequest(id);
    if (!request) throw new Error(`Pending take-pr request not found: ${id}`);
    return request;
  }
}

function pendingTakePrRequestFromRow(
  row: typeof pendingTakePrRequests.$inferSelect,
): PendingTakePrRequest {
  return {
    ...row,
    requesterSlackUserId: row.requesterSlackUserId ?? undefined,
    selectedService: row.selectedService ?? undefined,
    linearIssueIdentifier: row.linearIssueIdentifier ?? undefined,
    linearIssueUrl: row.linearIssueUrl ?? undefined,
  };
}

function takePrRequestCanBeClaimed(
  request: PendingTakePrRequest,
  selectedService: string,
  now: Date,
): boolean {
  if (request.status === "pending") return true;
  if (request.status === "created") return request.selectedService === selectedService;
  if (request.status !== "processing") return false;
  return (
    request.selectedService === selectedService &&
    Date.parse(request.updatedAt) <= now.getTime() - TAKE_PR_PROCESSING_LEASE_MS
  );
}

export function taskIdFor(serviceName: string, issueIdentifier: string): string {
  return `${serviceName}:${issueIdentifier}`;
}
