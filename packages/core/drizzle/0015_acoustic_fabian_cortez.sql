PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`device_id` text,
	`kind` text NOT NULL,
	`label` text,
	`path` text NOT NULL,
	`size_bytes` integer,
	`created_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`("id", "job_id", "device_id", "kind", "label", "path", "size_bytes", "created_at") SELECT "id", "job_id", NULL, "kind", "label", "path", "size_bytes", "created_at" FROM `artifacts`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_artifacts_job` ON `artifacts` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_device` ON `artifacts` (`device_id`,`created_at`);