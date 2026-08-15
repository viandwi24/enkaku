ALTER TABLE `batches` ADD `repeat_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `batches` ADD `interval_min_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `batches` ADD `interval_max_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `batches` ADD `device_interval_ms` integer DEFAULT 0 NOT NULL;