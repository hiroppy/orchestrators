import { relations } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Normalized watcher persistence schema. */
export const services = sqliteTable(
  "services",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("services_name_unique").on(table.name)],
);

export const statuses = sqliteTable(
  "statuses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order"),
    selectable: integer("selectable", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("statuses_service_name_unique").on(table.serviceId, table.name),
    index("statuses_service_selectable_order").on(
      table.serviceId,
      table.selectable,
      table.sortOrder,
    ),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id),
    issueIdentifier: text("issue_identifier").notNull(),
    title: text("title").notNull(),
    statusId: integer("status_id")
      .notNull()
      .references(() => statuses.id),
    linearStateType: text("linear_state_type"),
    linkUrl: text("link_url"),
    parentChannelId: text("parent_channel_id"),
    parentMessageTs: text("parent_message_ts"),
    lastRenderedSummary: text("last_rendered_summary"),
    lastEventAt: text("last_event_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tasks_service_issue_unique").on(table.serviceId, table.issueIdentifier),
    index("tasks_status_id_idx").on(table.statusId),
  ],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actor: text("actor"),
    fromStatusId: integer("from_status_id").references(() => statuses.id),
    toStatusId: integer("to_status_id").references(() => statuses.id),
    body: text("body"),
    slackThreadTs: text("slack_thread_ts"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("task_events_task_created_idx").on(table.taskId, table.createdAt),
    index("task_events_from_status_idx").on(table.fromStatusId),
    index("task_events_to_status_idx").on(table.toStatusId),
  ],
);

export const taskObservations = sqliteTable(
  "task_observations",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    bucket: text("bucket", { enum: ["running", "retrying", "blocked"] }).notNull(),
    trackerStatusId: integer("tracker_status_id").references(() => statuses.id),
    issueUrl: text("issue_url"),
    lastMessage: text("last_message"),
    error: text("error"),
    workspacePath: text("workspace_path"),
    startedAt: text("started_at"),
    blockedAt: text("blocked_at"),
    turnCount: integer("turn_count"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    lastEvent: text("last_event"),
    lastEventAt: text("last_event_at"),
    attempt: integer("attempt"),
    dueAt: text("due_at"),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId] }),
    index("task_observations_bucket_idx").on(table.bucket),
    index("task_observations_tracker_status_idx").on(table.trackerStatusId),
  ],
);

export const servicesRelations = relations(services, ({ many }) => ({
  tasks: many(tasks),
  statuses: many(statuses),
}));

export const statusesRelations = relations(statuses, ({ one, many }) => ({
  service: one(services, {
    fields: [statuses.serviceId],
    references: [services.id],
  }),
  tasks: many(tasks),
  observations: many(taskObservations),
  eventsFrom: many(taskEvents, { relationName: "eventFromStatus" }),
  eventsTo: many(taskEvents, { relationName: "eventToStatus" }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  service: one(services, {
    fields: [tasks.serviceId],
    references: [services.id],
  }),
  status: one(statuses, {
    fields: [tasks.statusId],
    references: [statuses.id],
  }),
  observation: one(taskObservations),
  events: many(taskEvents),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [taskEvents.taskId],
    references: [tasks.id],
  }),
  fromStatus: one(statuses, {
    relationName: "eventFromStatus",
    fields: [taskEvents.fromStatusId],
    references: [statuses.id],
  }),
  toStatus: one(statuses, {
    relationName: "eventToStatus",
    fields: [taskEvents.toStatusId],
    references: [statuses.id],
  }),
}));

export const taskObservationsRelations = relations(taskObservations, ({ one }) => ({
  task: one(tasks, {
    fields: [taskObservations.taskId],
    references: [tasks.id],
  }),
  trackerStatus: one(statuses, {
    fields: [taskObservations.trackerStatusId],
    references: [statuses.id],
  }),
}));
