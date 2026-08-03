ALTER TABLE `jobs` ADD `failure_class` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `infra_attempts` integer DEFAULT 0;