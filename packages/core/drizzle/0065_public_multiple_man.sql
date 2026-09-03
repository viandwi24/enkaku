ALTER TABLE `jobs` RENAME COLUMN "lease_expires_at" TO "heartbeat_expires_at";--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `assist_count`;
--> statement-breakpoint
-- MVP 04 §4: the device state machine shrank to offline | online | quarantined.
-- Every stored single-slot value is physically "online"; "busy" and "controlled"
-- are derived from the activity list from now on and never stored.
UPDATE `devices` SET `status` = 'online' WHERE `status` IN ('idle', 'manual', 'busy');
--> statement-breakpoint
-- Co-control attribution rows have no producer any more (plan 205 §3.2 item 8).
DELETE FROM `job_events` WHERE `kind` = 'assist';