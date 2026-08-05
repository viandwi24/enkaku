CREATE TABLE `discovered_devices` (
	`stable_id` text PRIMARY KEY NOT NULL,
	`serial` text NOT NULL,
	`label` text,
	`android_version` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL
);
