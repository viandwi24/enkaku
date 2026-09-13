ALTER TABLE `workflows` ADD `plugin_name` text;--> statement-breakpoint
CREATE INDEX `idx_workflows_plugin_name` ON `workflows` (`plugin_name`);