-- Every device enrolled before plan 125 §3.3 carries its own literal
-- `prep.keepAwake` in `devices.settings`, and for most farms that literal is
-- `'while-charging'`.
--
-- That value maps to `svc power stayon usb` (`packages/session/src/power.ts`'s
-- `STAYON`), and this repo already documents what it does on a farm reached
-- over the network or an OTG hub: NOTHING. `usb` holds the screen only while
-- the phone is charging over USB. Plan 125 §3.3 moved the DEFAULT to `'always'`
-- for exactly that reason — but `settings.ts` says plainly why that did not
-- help anyone who already had a farm:
--
--   "An existing farm is not touched by this. Every device row is written with
--    a FULLY MATERIALISED DeviceSettings … so a device enrolled before this
--    change has its own literal `keepAwake` stored in the `devices.settings`
--    JSON column and re-reads that value, never this default."
--
-- So `ensureAwake` faithfully wrote a no-op on every reconnect, and then wrote
-- the phone's own `screen_off_timeout` — thirty minutes by default. Half an
-- hour later the screen went dark and stayed dark, because nothing wakes a
-- device on a timer (readiness.ts's own no-timer rule) and the phones are
-- sealed in a box with no hand to reach them (plan 125 §0.2).
--
-- Reported from the owner's farm, 2026-08-28: "device sering blank, harus
-- di-trigger dulu".
--
-- This rewrites that one stored value, and only where it is the broken one. A
-- device an operator deliberately set to `'off'` keeps `'off'` — this is a
-- correction of a value that could never work on this transport, not a
-- farm-wide policy reset.
UPDATE `devices`
SET `settings` = json_set(`settings`, '$.prep.keepAwake', 'always')
WHERE `settings` IS NOT NULL
  AND json_valid(`settings`)
  AND json_extract(`settings`, '$.prep.keepAwake') = 'while-charging';
--> statement-breakpoint
-- The SECOND stored copy of the same broken value, and the one that would have
-- made this migration look like it failed.
--
-- `farm_settings` holds the farm's own `defaults.prep`, which is what a NEWLY
-- admitted device is materialised from (`registry/admission.ts`'s `baseFields`
-- → `defaultDeviceSettings()`). A farm configured before plan 125 §3.3 has
-- `'while-charging'` persisted here too — so fixing only `devices.settings`
-- would have repaired today's phones and quietly broken every phone enrolled
-- tomorrow, which is a worse bug than the one being fixed because it looks
-- fixed.
--
-- Same rule as above: only the value that cannot work on this transport is
-- rewritten. A farm deliberately set to `'off'` stays `'off'`.
UPDATE `farm_settings`
SET `value` = json_set(`value`, '$.defaults.prep.keepAwake', 'always')
WHERE json_valid(`value`)
  AND json_extract(`value`, '$.defaults.prep.keepAwake') = 'while-charging';
