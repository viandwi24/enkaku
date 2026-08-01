CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`device_id` text NOT NULL,
	`params` text,
	`priority` integer DEFAULT 0,
	`status` text DEFAULT 'queued',
	`lease_expires_at` integer,
	`result` text,
	`error` text,
	`created_at` integer,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_claim` ON `jobs` (`status`,`device_id`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_device` ON `jobs` (`device_id`,`created_at`);