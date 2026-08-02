CREATE TABLE `migration_markers` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `cluster_id` text;--> statement-breakpoint
CREATE INDEX `idx_devices_cluster` ON `devices` (`cluster_id`);