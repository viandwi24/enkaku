CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`token_hash` text,
	`credential_hash` text,
	`status` text DEFAULT 'pending',
	`version` text,
	`platform` text,
	`last_seen` integer,
	`created_at` integer
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `tenant_id` text;