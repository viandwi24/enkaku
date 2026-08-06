CREATE TABLE `ai_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`colour` text,
	`enabled` integer DEFAULT true NOT NULL,
	`connector_id` text,
	`model` text,
	`system_prompt` text,
	`settings` text,
	`tools` text,
	`device_grants` text,
	`workspace_scope` text,
	`permissions` text,
	`owner_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_agents_slug_unique` ON `ai_agents` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_ai_agents_created` ON `ai_agents` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`credential` text,
	`status` text DEFAULT 'unknown',
	`status_message` text,
	`checked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_name_unique` ON `connectors` (`name`);