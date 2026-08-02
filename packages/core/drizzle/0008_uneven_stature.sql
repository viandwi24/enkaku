CREATE TABLE `device_tags` (
	`device_id` text NOT NULL,
	`tag` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `tag`)
);
--> statement-breakpoint
CREATE INDEX `idx_device_tags_tag` ON `device_tags` (`tag`);