CREATE TABLE `agent_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL
);
