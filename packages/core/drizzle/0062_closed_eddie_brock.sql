CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at_ms` integer NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`phase` text,
	`node_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`duration_ms` integer,
	`ok` integer,
	`error_code` text,
	`meta` text,
	`frame_hash` text,
	`frame_status` text,
	`ui_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_job_events_seq` ON `job_events` (`job_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_job_events_at` ON `job_events` (`at_ms`);