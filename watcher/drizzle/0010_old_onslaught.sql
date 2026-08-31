ALTER TABLE `tasks` ADD `status_changed_at` text;--> statement-breakpoint
UPDATE `tasks`
SET `status_changed_at` = coalesce(
  (
    SELECT `task_events`.`created_at`
    FROM `task_events`
    WHERE `task_events`.`task_id` = `tasks`.`id`
      AND `task_events`.`to_status_id` = `tasks`.`status_id`
    ORDER BY `task_events`.`created_at` DESC, `task_events`.`id` DESC
    LIMIT 1
  ),
  `tasks`.`updated_at`,
  `tasks`.`created_at`
);
