ALTER TABLE `agents` RENAME TO `nodes`;--> statement-breakpoint
DROP INDEX `idx_agents_created`;--> statement-breakpoint
CREATE INDEX `idx_nodes_created` ON `nodes` (`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `devices` RENAME COLUMN `agent_id` TO `node_id`;
