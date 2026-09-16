CREATE TABLE `adb_shortcuts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cmd` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_adb_shortcuts_cmd` ON `adb_shortcuts` (`cmd`);--> statement-breakpoint
CREATE INDEX `idx_adb_shortcuts_position` ON `adb_shortcuts` (`position`,`id`);