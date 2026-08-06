CREATE TABLE `agent_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`target_run_id` text NOT NULL,
	`from_run_id` text,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`delivered_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_inbox_target` ON `agent_inbox` (`target_run_id`,`delivered_at`);--> statement-breakpoint
CREATE TABLE `agent_spawn_grants` (
	`parent_agent_id` text NOT NULL,
	`child_agent_id` text NOT NULL,
	PRIMARY KEY(`parent_agent_id`, `child_agent_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_spawn_grants_child` ON `agent_spawn_grants` (`child_agent_id`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `parent_run_id` text;--> statement-breakpoint
-- Every pre-existing row is its own root (a plain, non-spawned run) — SQLite requires a DEFAULT to
-- add a NOT NULL column to a non-empty table, so this backfills every existing row to be its own
-- root before the column is ever relied on as NOT NULL (dev-only data; plan 67 §4.1).
ALTER TABLE `agent_runs` ADD `root_run_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `agent_runs` SET `root_run_id` = `id` WHERE `root_run_id` = '';--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `depth` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `awaited` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_runs_root` ON `agent_runs` (`root_run_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_parent` ON `agent_runs` (`parent_run_id`);