CREATE TABLE `network_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`username` text,
	`secret` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `network_credentials_name_unique` ON `network_credentials` (`name`);