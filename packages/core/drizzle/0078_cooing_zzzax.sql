ALTER TABLE `batches` ADD `device_delay_min_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `batches` ADD `device_delay_max_ms` integer DEFAULT 0 NOT NULL;