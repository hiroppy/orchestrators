CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_name_unique` ON `services` (`name`);--> statement-breakpoint
CREATE TABLE `statuses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer,
	`selectable` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statuses_service_name_unique` ON `statuses` (`service_id`,`name`);--> statement-breakpoint
CREATE INDEX `statuses_service_selectable_order` ON `statuses` (`service_id`,`selectable`,`sort_order`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text,
	`from_status_id` integer,
	`to_status_id` integer,
	`body` text,
	`slack_thread_ts` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_status_id`) REFERENCES `statuses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_status_id`) REFERENCES `statuses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_events_task_created_idx` ON `task_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_events_from_status_idx` ON `task_events` (`from_status_id`);--> statement-breakpoint
CREATE INDEX `task_events_to_status_idx` ON `task_events` (`to_status_id`);--> statement-breakpoint
CREATE TABLE `task_observations` (
	`task_id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`tracker_status_id` integer,
	`issue_url` text,
	`last_message` text,
	`error` text,
	`workspace_path` text,
	`started_at` text,
	`blocked_at` text,
	`turn_count` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`last_event` text,
	`last_event_at` text,
	`attempt` integer,
	`due_at` text,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracker_status_id`) REFERENCES `statuses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_observations_bucket_idx` ON `task_observations` (`bucket`);--> statement-breakpoint
CREATE INDEX `task_observations_tracker_status_idx` ON `task_observations` (`tracker_status_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` integer NOT NULL,
	`issue_identifier` text NOT NULL,
	`title` text NOT NULL,
	`status_id` integer NOT NULL,
	`linear_state_type` text,
	`link_url` text,
	`parent_channel_id` text,
	`parent_message_ts` text,
	`last_rendered_summary` text,
	`last_event_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`status_id`) REFERENCES `statuses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_service_issue_unique` ON `tasks` (`service_id`,`issue_identifier`);--> statement-breakpoint
CREATE INDEX `tasks_status_id_idx` ON `tasks` (`status_id`);