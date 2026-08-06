CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`context` text,
	`source` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_created` ON `notifications` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `schedule_agent_targets` (
	`schedule_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`prompt` text NOT NULL,
	`thread_mode` text DEFAULT 'new' NOT NULL,
	`thread_id` text,
	`on_approval_required` text DEFAULT 'deny' NOT NULL,
	`last_agent_run_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_schedule_agent_targets_schedule` ON `schedule_agent_targets` (`schedule_id`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`secret_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_status` text,
	`last_attempt_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_endpoints_name_unique` ON `webhook_endpoints` (`name`);--> statement-breakpoint
ALTER TABLE `agent_threads` ADD `on_approval_required` text DEFAULT 'pause' NOT NULL;