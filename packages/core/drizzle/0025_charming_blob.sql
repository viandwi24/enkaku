CREATE TABLE `workspace_files` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`content` blob NOT NULL,
	`content_type` text DEFAULT 'text/plain' NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_path_unique` ON `workspace_files` (`path`);--> statement-breakpoint
CREATE INDEX `idx_workspace_path` ON `workspace_files` (`path`);