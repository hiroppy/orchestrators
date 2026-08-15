ALTER TABLE `task_events` ADD `status_event_type` text;--> statement-breakpoint
ALTER TABLE `task_events` ADD `status_event_label` text;--> statement-breakpoint
ALTER TABLE `task_events` ADD `status_event_error` text;--> statement-breakpoint
ALTER TABLE `task_events` ADD `status_event_key` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pull_request_title` text;
