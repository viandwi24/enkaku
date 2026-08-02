CREATE TABLE `device_events` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`stream` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text,
	`meta` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_device_events_tail` ON `device_events` (`device_id`,`stream`,`at`);--> statement-breakpoint
CREATE INDEX `idx_device_events_at` ON `device_events` (`at`);