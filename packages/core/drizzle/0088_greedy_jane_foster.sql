ALTER TABLE `groups` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_groups_position` ON `groups` (`position`,`id`);--> statement-breakpoint
-- Backfill: every existing group takes the place it already had on the Devices
-- strip, which read `created_at` DESC, `id` DESC before this column existed.
UPDATE `groups` SET `position` = (
	SELECT COUNT(*) FROM `groups` AS `g2`
	WHERE `g2`.`created_at` > `groups`.`created_at`
		OR (`g2`.`created_at` = `groups`.`created_at` AND `g2`.`id` > `groups`.`id`)
);
