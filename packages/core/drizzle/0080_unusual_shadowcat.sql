CREATE TABLE `device_labels` (
	`device_id` text NOT NULL,
	`label_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `label_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_device_labels_label` ON `device_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_labels_name` ON `labels` (`name`);--> statement-breakpoint
CREATE INDEX `idx_labels_created` ON `labels` (`created_at`,`id`);--> statement-breakpoint
INSERT INTO `labels` (`id`, `name`, `color`, `description`, `created_at`) SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))), t.tag, CASE ((row_number() OVER (ORDER BY t.tag)) - 1) % 8 WHEN 0 THEN 'slate' WHEN 1 THEN 'blue' WHEN 2 THEN 'green' WHEN 3 THEN 'amber' WHEN 4 THEN 'red' WHEN 5 THEN 'purple' WHEN 6 THEN 'pink' ELSE 'teal' END, NULL, t.first_at FROM (SELECT `tag` AS tag, min(`at`) AS first_at FROM `device_tags` GROUP BY `tag`) t;--> statement-breakpoint
INSERT INTO `device_labels` (`device_id`, `label_id`, `at`) SELECT dt.`device_id`, l.`id`, dt.`at` FROM `device_tags` dt JOIN `labels` l ON l.`name` = dt.`tag`;--> statement-breakpoint
DROP TABLE `device_tags`;