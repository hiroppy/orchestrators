ALTER TABLE `task_notification_mentions` RENAME TO `task_assignees`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_assignees` (
	`task_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `slack_user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_assignees`("task_id", "slack_user_id", "created_at") SELECT "task_id", "slack_user_id", "created_at" FROM `task_assignees`;--> statement-breakpoint
DROP TABLE `task_assignees`;--> statement-breakpoint
ALTER TABLE `__new_task_assignees` RENAME TO `task_assignees`;--> statement-breakpoint
PRAGMA foreign_keys=ON;