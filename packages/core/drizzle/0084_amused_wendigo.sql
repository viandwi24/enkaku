CREATE TABLE `schedule_workflow_targets` (
	`schedule_id` text PRIMARY KEY NOT NULL,
	`workflow_name` text NOT NULL,
	`params` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_schedule_workflow_targets_schedule` ON `schedule_workflow_targets` (`schedule_id`);--> statement-breakpoint
ALTER TABLE `schedules` ADD `device_delay_min_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `device_delay_max_ms` integer DEFAULT 0 NOT NULL;