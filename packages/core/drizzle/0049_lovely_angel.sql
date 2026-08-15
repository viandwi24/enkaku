ALTER TABLE `jobs` ADD `max_concurrent` integer;--> statement-breakpoint
CREATE INDEX `idx_jobs_script_running` ON `jobs` (`status`,`script_name`);