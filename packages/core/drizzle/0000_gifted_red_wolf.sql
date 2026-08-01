CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`stable_id` text NOT NULL,
	`serial` text NOT NULL,
	`label` text NOT NULL,
	`owner_id` text,
	`android_version` text,
	`api_level` integer,
	`screen_w` integer,
	`screen_h` integer,
	`density` integer,
	`transport` text DEFAULT 'adb-usb',
	`display` text DEFAULT 'scrcpy',
	`input` text DEFAULT 'scrcpy-uhid',
	`inspection` text DEFAULT 'ui-server',
	`battery` text,
	`settings` text,
	`status` text DEFAULT 'offline',
	`last_seen` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_stable_id_unique` ON `devices` (`stable_id`);