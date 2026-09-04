ALTER TABLE `artifacts` RENAME COLUMN "job_id" TO "run_id";--> statement-breakpoint
ALTER TABLE `job_events` RENAME COLUMN "job_id" TO "run_id";--> statement-breakpoint
ALTER TABLE `schedules` RENAME COLUMN "last_batch_id" TO "batch_id";--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`device_id` text NOT NULL,
	`script_name` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`heartbeat_expires_at` integer,
	`expires_at` integer,
	`not_before` integer,
	`batch_repeat` integer,
	`paced_delay_ms` integer,
	`result` text,
	`error` text,
	`failure_class` text,
	`error_phase` text,
	`infra_attempts` integer DEFAULT 0 NOT NULL,
	`peak_rss_bytes` integer,
	`max_concurrent` integer,
	`runtime_override` text,
	`result_status` text,
	`result_bytes` integer,
	`result_summary` text,
	`result_issues` text,
	`resumed_from_run_id` text,
	`resumed_from_step` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_job_runs_seq` ON `job_runs` (`job_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_job_runs_job` ON `job_runs` (`job_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_job_runs_claim` ON `job_runs` (`status`,`device_id`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_job_runs_script_running` ON `job_runs` (`status`,`script_name`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`step_id` text NOT NULL,
	`kind` text NOT NULL,
	`job_id` text,
	`job_run_id` text,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`output` text,
	`output_truncated` text,
	`verdict` text,
	`error` text,
	`error_code` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_steps_seq` ON `workflow_steps` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_workflow_steps_run` ON `workflow_steps` (`run_id`,`step_id`);--> statement-breakpoint
DROP INDEX `idx_artifacts_job`;--> statement-breakpoint
CREATE INDEX `idx_artifacts_run` ON `artifacts` (`run_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `artifacts` DROP COLUMN `node_id`;--> statement-breakpoint
DROP INDEX `idx_job_events_seq`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_job_events_seq` ON `job_events` (`run_id`,`seq`);--> statement-breakpoint
ALTER TABLE `job_events` DROP COLUMN `node_id`;--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_fire_outcome` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_fire_detail` text;--> statement-breakpoint
-- plan 211 §4.10: the old `jobs` table is kept, renamed, rather than dropped,
-- so `migrateJobsToRuns` (the boot data step) can still read every execution
-- column verbatim after this structural migration has applied. It also keeps
-- `job_nodes`, `job_resumes` and `schedule_runs` around for the same reason
-- (the boot step reads their rows before dropping them itself). Hand-corrected
-- after `drizzle-kit generate`'s own `__new_jobs` rebuild was found to SELECT
-- columns that do not exist on the pre-migration table (plan 211 §11 records
-- the discrepancy) — this file replaces that broken INSERT with one that maps
-- old columns to new ones explicitly.
DROP INDEX `idx_jobs_claim`;--> statement-breakpoint
DROP INDEX `idx_jobs_device`;--> statement-breakpoint
DROP INDEX `idx_jobs_batch`;--> statement-breakpoint
DROP INDEX `idx_jobs_created`;--> statement-breakpoint
DROP INDEX `idx_jobs_trigger_key`;--> statement-breakpoint
DROP INDEX `idx_jobs_root`;--> statement-breakpoint
DROP INDEX `idx_jobs_triggered_by`;--> statement-breakpoint
DROP INDEX `idx_jobs_script_running`;--> statement-breakpoint
ALTER TABLE `jobs` RENAME TO `jobs_pre_211`;--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'script' NOT NULL,
	`script_id` text,
	`workflow_name` text,
	`workflow_doc` text,
	`device_id` text NOT NULL,
	`params` text,
	`batch_id` text,
	`batch_seq` integer,
	`schedule_id` text,
	`parent_workflow_job_id` text,
	`step_seq` integer,
	`script_name` text,
	`script_version` text,
	`triggered_by_job_id` text,
	`root_job_id` text,
	`depth` integer DEFAULT 0,
	`trigger_key` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`latest_run_id` text,
	`run_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- `COALESCE("created_at", unixepoch())` guards a real gap in the PRE-211
-- physical schema: `jobs.created_at` was declared `.notNull()` at the
-- Drizzle level but the column itself was never rebuilt NOT NULL at the SQL
-- level (`0002_complex_anthem.sql` created it nullable, and no migration
-- since ever tightened it) — an old row inserted without the app's own
-- insert-time default (any raw SQL, including a hand-seeded test fixture)
-- can carry a genuine NULL here. The new `jobs.created_at` IS NOT NULL at
-- the SQL level (finally matching the schema), so this is the one place
-- that gap must be closed, not carried forward as a migration crash.
INSERT INTO `jobs` ("id", "kind", "script_id", "workflow_name", "workflow_doc", "device_id", "params", "batch_id", "batch_seq", "schedule_id", "parent_workflow_job_id", "step_seq", "script_name", "script_version", "triggered_by_job_id", "root_job_id", "depth", "trigger_key", "created_by", "created_at", "latest_run_id", "run_count")
SELECT "id", 'script', "script_id", NULL, "workflow_doc", "device_id", "params", "batch_id", "batch_seq", NULL, NULL, NULL, "script_name", "script_version", "triggered_by_job_id", "root_job_id", "depth", "trigger_key", NULL, COALESCE("created_at", unixepoch()), NULL, 0
FROM `jobs_pre_211`;--> statement-breakpoint
CREATE INDEX `idx_jobs_device` ON `jobs` (`device_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_batch` ON `jobs` (`batch_id`,`batch_seq`);--> statement-breakpoint
CREATE INDEX `idx_jobs_created` ON `jobs` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_schedule` ON `jobs` (`schedule_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_parent` ON `jobs` (`parent_workflow_job_id`,`step_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_jobs_trigger_key` ON `jobs` (`root_job_id`,`trigger_key`) WHERE "jobs"."trigger_key" is not null;--> statement-breakpoint
CREATE INDEX `idx_jobs_root` ON `jobs` (`root_job_id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_triggered_by` ON `jobs` (`triggered_by_job_id`);
