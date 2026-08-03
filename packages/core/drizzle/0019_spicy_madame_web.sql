CREATE TABLE `blocked_devices` (
	`stable_id` text PRIMARY KEY NOT NULL,
	`label` text,
	`reason` text,
	`blocked_at` integer NOT NULL,
	`blocked_by` text
);
--> statement-breakpoint
CREATE TABLE `deleted_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`stable_id` text NOT NULL,
	`label` text,
	`deleted_at` integer NOT NULL
);
