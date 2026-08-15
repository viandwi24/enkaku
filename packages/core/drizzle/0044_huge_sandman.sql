CREATE TABLE `job_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`script_id` text,
	`script_name` text,
	`script_version` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`output` text,
	`output_truncated` text,
	`verdict` text,
	`error` text,
	`error_code` text,
	`resumed_from_job_id` text,
	`resumed_from_node` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_job_nodes_seq` ON `job_nodes` (`job_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_job_nodes_job` ON `job_nodes` (`job_id`,`node_id`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `node_id` text;--> statement-breakpoint
ALTER TABLE `scripts` ADD `kind` text DEFAULT 'script' NOT NULL;