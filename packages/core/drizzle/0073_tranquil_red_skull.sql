CREATE TABLE `workflow_pins` (
	`workflow_name` text NOT NULL,
	`node_id` text NOT NULL,
	`data` text NOT NULL,
	`created_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workflow_name`, `node_id`)
);
--> statement-breakpoint
ALTER TABLE `job_runs` ADD `seed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `input` text;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `taken_edge` text;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `pinned` integer DEFAULT false NOT NULL;