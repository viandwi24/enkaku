CREATE TABLE `kv_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`secret` integer DEFAULT false NOT NULL,
	`hint` text,
	`version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`updated_at` integer NOT NULL,
	`updated_by_job_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kv_identity` ON `kv_entries` (`scope`,`scope_id`,`namespace`,`key`);--> statement-breakpoint
CREATE INDEX `idx_kv_scan` ON `kv_entries` (`scope`,`scope_id`,`namespace`);--> statement-breakpoint
CREATE INDEX `idx_kv_expiry` ON `kv_entries` (`expires_at`);