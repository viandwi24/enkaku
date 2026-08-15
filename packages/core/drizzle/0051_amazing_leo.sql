CREATE TABLE `command_run_members` (
	`run_id` text NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`exit_code` integer,
	`duration_ms` integer,
	`stdout` text,
	`stderr` text,
	`truncated` integer DEFAULT false NOT NULL,
	`output_hash` text,
	`skip_code` text,
	`skip_message` text,
	`error` text,
	`stage_index` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`run_id`, `device_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_command_members_run` ON `command_run_members` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `command_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`cmd` text NOT NULL,
	`target` text NOT NULL,
	`saved_command_id` text,
	`stage_first_n` integer DEFAULT 0 NOT NULL,
	`stage` integer DEFAULT 1 NOT NULL,
	`concurrency` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`acknowledged` integer DEFAULT false NOT NULL,
	`created_by` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_command_runs_user` ON `command_runs` (`created_by`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_command_runs_at` ON `command_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `saved_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cmd` text NOT NULL,
	`default_target` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_commands_name` ON `saved_commands` (`name`);--> statement-breakpoint
ALTER TABLE `batches` ADD `skipped` text;