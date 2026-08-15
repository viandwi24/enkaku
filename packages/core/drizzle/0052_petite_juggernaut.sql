ALTER TABLE `jobs` ADD `result_status` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `result_bytes` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `result_summary` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `result_issues` text;--> statement-breakpoint
-- Plan 97 §3.3, §4.4 — no script declared a result schema before this plan,
-- so every job that has already finished is, definitionally, 'undeclared'.
-- Unfinished rows (finished_at IS NULL — queued or running) stay NULL, per
-- the column's own "NULL while queued or running" rule. One UPDATE, no
-- ambiguity, and the enum is total from the first boot after this migration.
UPDATE `jobs` SET `result_status` = 'undeclared' WHERE `finished_at` IS NOT NULL;