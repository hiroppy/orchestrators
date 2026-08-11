CREATE TABLE `pending_take_pr_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_url` text NOT NULL,
	`repository` text NOT NULL,
	`pull_request_title` text NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_ts` text NOT NULL,
	`requester_slack_user_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`selected_service` text,
	`linear_issue_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_take_pr_requests_status_idx` ON `pending_take_pr_requests` (`status`);