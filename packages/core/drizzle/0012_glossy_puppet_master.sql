CREATE INDEX `idx_agents_created` ON `agents` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_clusters_created` ON `clusters` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_devices_label` ON `devices` (`label`,`id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_created` ON `jobs` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_schedules_created` ON `schedules` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_created` ON `scripts` (`created_at`,`id`);