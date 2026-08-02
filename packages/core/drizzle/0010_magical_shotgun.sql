CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`fired_at` integer,
	`outcome` text NOT NULL,
	`batch_id` text,
	`detail` text,
	`missed_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_schedule_runs_sched` ON `schedule_runs` (`schedule_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`script_id` text NOT NULL,
	`params` text,
	`cluster_id` text,
	`device_ids` text,
	`concurrency` integer DEFAULT 0 NOT NULL,
	`order` text DEFAULT 'as-listed' NOT NULL,
	`on_overlap` text DEFAULT 'skip' NOT NULL,
	`queue_timeout_sec` integer,
	`catch_up` text DEFAULT 'skip' NOT NULL,
	`jitter_sec` integer DEFAULT 0 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`last_fired_at` integer,
	`last_batch_id` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_schedules_enabled` ON `schedules` (`enabled`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `expires_at` integer;