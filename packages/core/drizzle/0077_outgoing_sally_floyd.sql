CREATE TABLE `virtual_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`console_port` integer NOT NULL,
	`spec` text NOT NULL,
	`message` text,
	`created_at` integer NOT NULL,
	`started_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `virtual_devices_name_unique` ON `virtual_devices` (`name`);