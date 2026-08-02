CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text,
	`script_id` text NOT NULL,
	`params` text,
	`concurrency` integer DEFAULT 0 NOT NULL,
	`order` text DEFAULT 'as-listed' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_batches_created` ON `batches` (`created_at`);--> statement-breakpoint
CREATE TABLE `clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tags` text NOT NULL,
	`device_ids` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `batch_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `batch_seq` integer;--> statement-breakpoint
CREATE INDEX `idx_jobs_batch` ON `jobs` (`batch_id`,`batch_seq`);