CREATE TABLE `script_param_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`script_name` text NOT NULL,
	`name` text NOT NULL,
	`params` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_param_sets_script_name` ON `script_param_sets` (`script_name`,`name`);