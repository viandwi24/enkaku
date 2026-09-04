PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`stable_id` text NOT NULL,
	`serial` text NOT NULL,
	`label` text NOT NULL,
	`model` text,
	`owner_id` text,
	`android_version` text,
	`api_level` integer,
	`screen_w` integer,
	`screen_h` integer,
	`density` integer,
	`transport` text DEFAULT 'adb-usb',
	`display` text DEFAULT 'scrcpy',
	`input` text DEFAULT 'scrcpy-uhid',
	`inspection` text DEFAULT 'ui-tree',
	`battery` text,
	`settings` text,
	`status` text DEFAULT 'offline',
	`quarantine_reason` text,
	`node_id` text,
	`tenant_id` text,
	`last_seen` integer,
	`group_id` text,
	`desired_readiness` text,
	`network_route` text,
	`agent` text,
	`preparation` text,
	`label_fingerprint` text,
	`label_state` text,
	`power_capture` text
);
--> statement-breakpoint
INSERT INTO `__new_devices`("id", "stable_id", "serial", "label", "model", "owner_id", "android_version", "api_level", "screen_w", "screen_h", "density", "transport", "display", "input", "inspection", "battery", "settings", "status", "quarantine_reason", "node_id", "tenant_id", "last_seen", "group_id", "desired_readiness", "network_route", "agent", "preparation", "label_fingerprint", "label_state", "power_capture") SELECT "id", "stable_id", "serial", "label", "model", "owner_id", "android_version", "api_level", "screen_w", "screen_h", "density", "transport", "display", "input", "inspection", "battery", "settings", "status", "quarantine_reason", "node_id", "tenant_id", "last_seen", "group_id", "desired_readiness", "network_route", "agent", "preparation", "label_fingerprint", "label_state", "power_capture" FROM `devices`;--> statement-breakpoint
DROP TABLE `devices`;--> statement-breakpoint
ALTER TABLE `__new_devices` RENAME TO `devices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_stable_id_unique` ON `devices` (`stable_id`);--> statement-breakpoint
CREATE INDEX `idx_devices_label` ON `devices` (`label`,`id`);--> statement-breakpoint
CREATE INDEX `idx_devices_group` ON `devices` (`group_id`);
--> statement-breakpoint
-- MVP 02 §4 phase 2: the default inspector engine is the guest agent's own
-- accessibility service. A device row carries the engine it will actually use
-- (`packages/session/src/manager.ts` reads this column, not the settings JSON),
-- so changing the schema default alone would reach no farm that already exists.
--
-- This rewrites `ui-server` and only `ui-server`. That value is what every farm
-- has, whether an operator chose it or it was simply the default, and the two
-- are indistinguishable on disk — so an operator who wants ui-server re-selects
-- it, and the release note says so. A device pinned to `uiautomator-dump` or
-- `appium` is untouched: those were deliberate.
--
-- Nothing is lost if the agent is not ready on a device: the engine ladder
-- (plan 222 §3.8) probes ui-tree, falls back to ui-server, reports the hop as
-- `device.inspector.fallback`, and the device keeps working on the engine it
-- had before.
UPDATE `devices` SET `inspection` = 'ui-tree' WHERE `inspection` = 'ui-server';
--> statement-breakpoint
-- The second stored copy: every device row holds a fully materialised
-- DeviceSettings, so the dropdown would keep showing `ui-server` for a device
-- the core is running on `ui-tree`.
UPDATE `devices`
SET `settings` = json_set(`settings`, '$.engines.inspection', 'ui-tree')
WHERE `settings` IS NOT NULL
  AND json_valid(`settings`)
  AND json_extract(`settings`, '$.engines.inspection') = 'ui-server';
--> statement-breakpoint
-- The third, and the one that would have made this migration look like it
-- worked: `farm_settings` holds the farm's own `defaults`, which is what a
-- NEWLY admitted device is materialised from (`registry/admission.ts`). Fixing
-- only the rows above would repair today's phones and quietly hand tomorrow's
-- the old engine.
UPDATE `farm_settings`
SET `value` = json_set(`value`, '$.defaults.engines.inspection', 'ui-tree')
WHERE json_valid(`value`)
  AND json_extract(`value`, '$.defaults.engines.inspection') = 'ui-server';