CREATE TABLE `plugin_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin` text NOT NULL,
	`webhook_id` text NOT NULL,
	`secret_ref` text NOT NULL,
	`previous_secret_ref` text,
	`previous_expires_at` integer,
	`deliveries` integer DEFAULT 0 NOT NULL,
	`refusals` integer DEFAULT 0 NOT NULL,
	`last_delivery_at` integer,
	`last_accepted_key` text,
	`rotated_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugin_webhooks_key` ON `plugin_webhooks` (`plugin`,`webhook_id`);