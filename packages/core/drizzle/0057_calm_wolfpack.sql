CREATE TABLE `device_numbers` (
	`stable_id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	`assigned_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_numbers_number_unique` ON `device_numbers` (`number`);--> statement-breakpoint
CREATE TABLE `sequences` (
	`name` text PRIMARY KEY NOT NULL,
	`next` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `label_fingerprint` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `label_state` text;--> statement-breakpoint
-- Backfill (plan 89 §4.1, step 89.1): every pre-existing device gets a
-- number in `label ASC, id ASC` order — the same order `/api/devices`
-- already sorts by (F25), so an existing farm's numbers match the order its
-- operator already sees top to bottom. Row order (insertion order) was
-- deliberately rejected: `devices.id` is a random UUID with no createdAt
-- column on this table, so "row order" is really "whatever order SQLite
-- happens to return them in" — not a stable, re-derivable choice. `label
-- ASC, id ASC` is deterministic, already the operator-visible order, and
-- costs nothing extra to compute.
-- The `WHERE ... NOT IN` guard makes this idempotent: a hypothetical second
-- run (this repo tracks applied migrations, so a normal boot never re-runs
-- it, but the guard is cheap insurance) skips every stableId that already
-- has a reservation rather than re-numbering it or violating the UNIQUE
-- constraint on `number`.
INSERT INTO `device_numbers` (`stable_id`, `number`, `assigned_at`, `assigned_by`)
SELECT `stable_id`, ROW_NUMBER() OVER (ORDER BY `label` ASC, `id` ASC), strftime('%s','now'), NULL
FROM `devices`
WHERE `stable_id` NOT IN (SELECT `stable_id` FROM `device_numbers`);
--> statement-breakpoint
-- Seed the watermark to the highest number just assigned (or 1 for an empty
-- farm) so the next `allocateDeviceNumber` call continues the sequence
-- instead of colliding with it.
-- `WHERE 1 = 1` is load-bearing, not decoration: SQLite's upsert grammar
-- only recognises `ON CONFLICT ... DO UPDATE` after an `INSERT ... SELECT`
-- when the SELECT carries a trailing clause (WHERE/LIMIT/etc) to disambiguate
-- where the SELECT ends and the upsert begins — confirmed against sqlite3
-- 3.51.0, the version bun:sqlite bundles. Without it: `near "DO": syntax error`.
INSERT INTO `sequences` (`name`, `next`)
SELECT 'device_number', COALESCE(MAX(`number`), 0) + 1 FROM `device_numbers` WHERE 1 = 1
ON CONFLICT(`name`) DO UPDATE SET `next` = `excluded`.`next`;
