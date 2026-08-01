CREATE TABLE `tool_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`version` text NOT NULL,
	`active` integer DEFAULT false,
	`sha256` text,
	`installed_at` integer
);
