CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`doc` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflows_name` ON `workflows` (`name`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `workflow_doc` text;--> statement-breakpoint
ALTER TABLE `scripts` DROP COLUMN `kind`;