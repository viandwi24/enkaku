CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`path` text NOT NULL,
	`size_bytes` integer,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_job` ON `artifacts` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`bundle` text NOT NULL,
	`params_schema` text,
	`enabled` integer DEFAULT true,
	`created_by` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scripts_name_version` ON `scripts` (`name`,`version`);