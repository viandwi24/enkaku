CREATE TABLE `farm_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `quarantine_reason` text;