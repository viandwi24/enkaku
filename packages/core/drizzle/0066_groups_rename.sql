ALTER TABLE `clusters` RENAME TO `groups`;--> statement-breakpoint
DROP INDEX `idx_clusters_created`;--> statement-breakpoint
CREATE INDEX `idx_groups_created` ON `groups` (`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `devices` RENAME COLUMN `cluster_id` TO `group_id`;--> statement-breakpoint
DROP INDEX `idx_devices_cluster`;--> statement-breakpoint
CREATE INDEX `idx_devices_group` ON `devices` (`group_id`);--> statement-breakpoint
ALTER TABLE `batches` RENAME COLUMN `cluster_id` TO `group_id`;--> statement-breakpoint
ALTER TABLE `schedules` RENAME COLUMN `cluster_id` TO `group_id`;--> statement-breakpoint
DROP TABLE `command_run_members`;--> statement-breakpoint
DROP TABLE `command_runs`;--> statement-breakpoint
DROP TABLE `saved_commands`;
