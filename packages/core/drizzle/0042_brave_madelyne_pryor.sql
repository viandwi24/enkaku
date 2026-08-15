CREATE TABLE `device_endpoints` (
	`stable_id` text NOT NULL,
	`address` text NOT NULL,
	`medium` text,
	`source` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_connected_at` integer,
	`last_attempt_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`conflict_stable_id` text,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`stable_id`, `address`)
);
