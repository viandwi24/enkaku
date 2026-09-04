-- MVP 11 §1.1, plan 206 §3.7: desired readiness is `awake` by default for every device, old and new.
-- 0064 fixed `prep.keepAwake`; it did not touch this column. NULL predates readiness;
-- 'asleep' was the materialised default on every farm older than plan 125 §3.1 and
-- no surface ever distinguished a chosen 'asleep' from that default. An operator who
-- wants a device asleep sets it again (the same rule 0064 and normaliseLegacyWall apply).
UPDATE `devices` SET `desired_readiness` = 'awake'
WHERE `desired_readiness` IS NULL OR `desired_readiness` = 'asleep';
--> statement-breakpoint
UPDATE `farm_settings`
SET `value` = json_set(`value`, '$.readiness.defaultDesired', 'awake')
WHERE json_valid(`value`) AND json_extract(`value`, '$.readiness.defaultDesired') = 'asleep';
