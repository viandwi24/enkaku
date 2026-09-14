ALTER TABLE `batches` ADD `sequential` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `batch_wave` integer;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `held` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `sequential` integer DEFAULT false NOT NULL;