CREATE TABLE `agent_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_approvals_run` ON `agent_approvals` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_approvals_status` ON `agent_approvals` (`status`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_messages_seq` ON `agent_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_run` ON `agent_messages` (`run_id`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stop_reason` text,
	`error_class` text,
	`error` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`usage` text,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_thread` ON `agent_runs` (`thread_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `agent_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`title` text,
	`origin` text DEFAULT 'chat' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_threads_agent` ON `agent_threads` (`agent_id`,`created_at`);