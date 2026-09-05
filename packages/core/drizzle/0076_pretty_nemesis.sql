ALTER TABLE `script_param_sets` RENAME COLUMN "script_name" TO "owner_name";--> statement-breakpoint
DROP INDEX `idx_param_sets_script_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_param_sets_owner` ON `script_param_sets` (`kind`,`owner_name`,`name`);