ALTER TABLE `jobs` ADD `triggered_by_job_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `root_job_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `depth` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `jobs` ADD `trigger_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_jobs_trigger_key` ON `jobs` (`root_job_id`,`trigger_key`) WHERE "jobs"."trigger_key" is not null;--> statement-breakpoint
CREATE INDEX `idx_jobs_root` ON `jobs` (`root_job_id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_triggered_by` ON `jobs` (`triggered_by_job_id`);