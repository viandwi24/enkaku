CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`title` text,
	`description` text,
	`bundle` text NOT NULL,
	`source` text,
	`bundle_hash` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`verified_at` integer,
	`verify_error` text,
	`verify_error_code` text,
	`manifest` text,
	`reset_packages` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugins_name_version` ON `plugins` (`name`,`version`);--> statement-breakpoint
CREATE INDEX `idx_plugins_status` ON `plugins` (`name`,`status`);--> statement-breakpoint
ALTER TABLE `scripts` ADD `plugin_id` text;--> statement-breakpoint
ALTER TABLE `scripts` ADD `export_id` text;--> statement-breakpoint
CREATE INDEX `idx_scripts_plugin` ON `scripts` (`plugin_id`);