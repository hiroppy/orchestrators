import type { WatcherDatabase } from "./database.ts";
import type { ResolvedLinearTeamConfig, ServiceDefinition } from "../domain/service.ts";
import type { SnapshotsByService } from "../domain/snapshot.ts";
import type { Task, TaskEvent } from "../domain/task.ts";
import type { WatcherEvent } from "../domain/watcher-event.ts";
import type { TaskEventInput } from "./store-helpers.ts";
import {
  addTaskEvent,
  addTaskEvents,
  countTaskEvents,
  countTaskEventsAfterLatest,
  countTaskEventsWithBody,
  getLatestTaskEvent,
  getLatestDeliveredTaskEventsByType,
  getLatestTaskEventsByType,
  getUndeliveredStatusTimelineEvents,
  hasStatusTimelineEvent,
  getTaskIdsWithIncompleteEvent,
  getUncompletedTaskEvents,
  hasRecordedSlackMessage,
  hasTaskEvent,
  setTaskEventSlackThreadTs,
} from "./task-event-store.ts";
import { syncDefinitions } from "./definitions.ts";
import { assignTask, getTaskAssignees, unassignTask } from "./assignee-store.ts";
import { getSelectableStatuses } from "./status-store.ts";
import { getSnapshots, replaceSnapshots } from "./snapshot-store.ts";
import { TaskStore } from "./task-store.ts";
import {
  PendingTakePrStore,
  type NewPendingTakePrRequest,
  type PendingTakePrRequest,
} from "./pending-take-pr-store.ts";

export type { TaskEventInput } from "./store-helpers.ts";

export const DEFAULT_DATABASE_PATH = "data/watcher/watcher.db";
export type { PendingTakePrRequest } from "./pending-take-pr-store.ts";

export class WatcherStore {
  private readonly db: WatcherDatabase;
  private readonly pendingTakePrStore = new PendingTakePrStore();
  private readonly taskStore: TaskStore;

  constructor(db: WatcherDatabase) {
    this.db = db;
    this.taskStore = new TaskStore(db);
  }

  syncDefinitions(
    serviceDefinitions: ServiceDefinition[],
    linearTeams: Record<string, ResolvedLinearTeamConfig>,
    now = new Date(),
  ): void {
    syncDefinitions(this.db, serviceDefinitions, linearTeams, now);
  }

  getSelectableStatuses(serviceName: string): string[] {
    return getSelectableStatuses(this.db, serviceName);
  }

  getSnapshots(): SnapshotsByService {
    return getSnapshots(this.db);
  }

  replaceSnapshots(snapshots: SnapshotsByService, now = new Date()): void {
    replaceSnapshots(this.db, snapshots, now);
  }

  getTask(id: string): Task | undefined {
    return this.taskStore.getTask(id);
  }

  getTaskBySlackThread(channel: string, threadTs: string): Task | undefined {
    return this.taskStore.getTaskBySlackThread(channel, threadTs);
  }

  getTasksForLinearSync(
    includedTaskIds: ReadonlySet<string> = new Set(),
    includedStatusesByService: ReadonlyMap<string, readonly string[]> = new Map(),
    includeTerminalTasks = false,
  ): Task[] {
    return this.taskStore.getTasksForLinearSync(
      includedTaskIds,
      includedStatusesByService,
      includeTerminalTasks,
    );
  }

  upsertTaskFromEvent(event: WatcherEvent, now = new Date()): Task {
    return this.taskStore.upsertTaskFromEvent(event, now);
  }

  upsertTaskFromEventAtomically(
    event: WatcherEvent,
    createEvent: (task: Task, previousTask: Task | undefined) => TaskEventInput | undefined,
    now = new Date(),
  ): { task: Task; previousTask: Task | undefined } {
    return this.taskStore.upsertTaskFromEventAtomically(event, createEvent, now);
  }

  setParentMessage(
    taskId: string,
    channel: string,
    ts: string,
    summary: string,
    now = new Date(),
  ): Task {
    return this.taskStore.setParentMessage(taskId, channel, ts, summary, now);
  }

  setRenderedSummary(taskId: string, summary: string, now = new Date()): void {
    this.taskStore.setRenderedSummary(taskId, summary, now);
  }

  setTaskLinearStateType(taskId: string, stateType: string | undefined, now = new Date()): void {
    this.taskStore.setTaskLinearStateType(taskId, stateType, now);
  }

  setTaskPullRequest(taskId: string, pullRequest: Task["pullRequest"], now = new Date()): void {
    this.taskStore.setTaskPullRequest(taskId, pullRequest, now);
  }

  assignTask(taskId: string, slackUserId: string, now = new Date()): boolean {
    return assignTask(this.db, taskId, slackUserId, now);
  }

  unassignTask(taskId: string, slackUserId: string): boolean {
    return unassignTask(this.db, taskId, slackUserId);
  }

  getTaskAssignees(taskId: string): string[] {
    return getTaskAssignees(this.db, taskId);
  }

  createPendingTakePrRequest(
    request: NewPendingTakePrRequest,
    now = new Date(),
  ): PendingTakePrRequest {
    return this.pendingTakePrStore.create(request, now);
  }

  getPendingTakePrRequest(id: string, now = new Date()): PendingTakePrRequest | undefined {
    return this.pendingTakePrStore.get(id, now);
  }

  takePendingTakePrRequest(id: string, now = new Date()): PendingTakePrRequest | undefined {
    return this.pendingTakePrStore.take(id, now);
  }

  restorePendingTakePrRequest(request: PendingTakePrRequest): void {
    this.pendingTakePrStore.restore(request);
  }

  updateTaskStatus(
    taskId: string,
    statusName: string,
    now = new Date(),
  ): { task: Task; fromStatus: string } {
    return this.taskStore.updateTaskStatus(taskId, statusName, now);
  }

  updateTaskStatusAtomically(
    taskId: string,
    statusName: string,
    createEvents: (task: Task, fromStatus: string) => TaskEventInput | TaskEventInput[] | undefined,
    now = new Date(),
  ): { task: Task; fromStatus: string } {
    return this.taskStore.updateTaskStatusAtomically(taskId, statusName, createEvents, now);
  }

  addEvent(event: TaskEventInput): TaskEvent {
    return addTaskEvent(this.db, event);
  }

  addEvents(events: TaskEventInput[]): TaskEvent[] {
    return addTaskEvents(this.db, events);
  }

  hasRecordedSlackMessage(taskId: string, messageTs: string, eventType: string): boolean {
    return hasRecordedSlackMessage(this.db, taskId, messageTs, eventType);
  }

  hasEvent(taskId: string, type: string, body: string): boolean {
    return hasTaskEvent(this.db, taskId, type, body);
  }

  hasStatusTimelineEvent(taskId: string, statusEventKey: string): boolean {
    return hasStatusTimelineEvent(this.db, taskId, statusEventKey);
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

  getLatestEventsByType(taskId: string, type: string, limit: number): TaskEvent[] {
    return getLatestTaskEventsByType(this.db, taskId, type, limit);
  }

  getLatestDeliveredEventsByType(taskId: string, type: string, limit: number): TaskEvent[] {
    return getLatestDeliveredTaskEventsByType(this.db, taskId, type, limit);
  }

  getUndeliveredStatusTimelineEvents(): TaskEvent[] {
    return getUndeliveredStatusTimelineEvents(this.db);
  }

  setTaskEventSlackThreadTs(eventId: number, slackThreadTs: string): void {
    setTaskEventSlackThreadTs(this.db, eventId, slackThreadTs);
  }

  setTaskActivity(taskId: string, activity: Task["currentActivity"]): void {
    this.taskStore.setTaskActivity(taskId, activity);
  }

  markTaskActivityPublished(taskId: string, publishedAt: Date): void {
    this.taskStore.markTaskActivityPublished(taskId, publishedAt);
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
}

export { taskIdFor } from "./task-store.ts";
