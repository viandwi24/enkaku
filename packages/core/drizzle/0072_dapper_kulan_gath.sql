CREATE TABLE `storage_usage` (
	`kind` text PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL
);
