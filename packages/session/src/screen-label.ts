import { shellQuote } from '@enkaku/adb'
import type { Transport } from '@enkaku/protocol'
import type { Logger } from './logger'

/**
 * Tier 0 physical labelling (plan 89 §3.5, §4.5's H2, §5 step 89.7) — lock-
 * screen text over plain adb, no guest agent, no image, no font. This is the
 * "Add text on lock screen" feature under Settings → Security: writing
 * `lock_screen_owner_info` puts one line of operator-chosen text under the
 * lock-screen clock, on a device with nothing installed.
 *
 * **H2 is UNPROVEN on hardware.** No `adb` binary and no attached device were
 * reachable in the environment this module was written in — the shell UID
 * holding `WRITE_SECURE_SETTINGS` for exactly these two keys is Android's
 * documented behaviour (the same mechanism `orientation.ts` already relies on
 * for `system` namespace keys, one namespace over), not a claim of having run
 * this on real hardware. `docs/plans/89-m54-device-identity-and-physical-labelling.md`
 * §5 step 89.5/89.7 is the owner-executable probe that settles it — this
 * module does not tick that checklist itself. Until it is run, every caller
 * MUST treat a write whose read-back does not match as `unavailable`, never
 * `applied` (CLAUDE.md's `unverified` rule) — `writeLockScreenLabel` below
 * enforces that by construction: it always reads back what it wrote and
 * reports whether the device actually accepted it.
 *
 * Unlike the wallpaper (H3: the original usually cannot be read back), this
 * tier's prior value genuinely IS readable — `settings get secure
 * lock_screen_owner_info` — so capture-and-restore here is real, not a
 * best-effort guess. `labelling.ts` is the caller that persists the captured
 * value (`DeviceLabelState.capturedLockScreen`) across a core restart, since
 * this module itself holds no state of its own.
 */

const OWNER_INFO_KEY = 'lock_screen_owner_info'
const OWNER_INFO_ENABLED_KEY = 'lock_screen_owner_info_enabled'

export interface LockScreenLabel {
  text: string
  enabled: boolean
}

/** `settings get` prints the literal string `null` for a key that was never set — normalised to `''`, Android's own "nothing here" answer for this key. */
function normaliseUnset(raw: string): string {
  const trimmed = raw.trim()
  return trimmed === 'null' ? '' : trimmed
}

/** Read-only — never writes. Used both for the pre-write capture and for a status probe that must not mutate the device. */
export async function readLockScreenLabel(transport: Transport): Promise<LockScreenLabel> {
  const text = await transport
    .exec(`settings get secure ${OWNER_INFO_KEY}`, { profile: 'probe' })
    .then((r) => normaliseUnset(r.stdout))
    .catch(() => '')
  const enabledRaw = await transport
    .exec(`settings get secure ${OWNER_INFO_ENABLED_KEY}`, { profile: 'probe' })
    .then((r) => normaliseUnset(r.stdout))
    .catch(() => '')
  return { text, enabled: enabledRaw === '1' }
}

/**
 * Writes the label text and enables it, then reads both straight back to
 * confirm the device actually accepted them — `verified: false` on any
 * mismatch (a ROM that ignores the write, a permission this shell UID turns
 * out not to hold, an adb hiccup between the two calls). The caller decides
 * what `verified: false` means for `DeviceLabelState.state` (`unavailable`);
 * this function never claims success it did not observe.
 */
export async function writeLockScreenLabel(transport: Transport, text: string): Promise<{ verified: boolean }> {
  await transport.exec(`settings put secure ${OWNER_INFO_KEY} ${shellQuote(text)}`, { profile: 'probe' })
  await transport.exec(`settings put secure ${OWNER_INFO_ENABLED_KEY} 1`, { profile: 'probe' })
  const after = await readLockScreenLabel(transport)
  return { verified: after.text === text && after.enabled }
}

/**
 * Idempotent restore (F18's rule, applied to a device-scoped caller rather
 * than a session's `close()`): re-issues the exact captured values every
 * time it is called, and consults no "already restored" flag. A write
 * failure is logged at `debug` and tolerated — mirrors `orientation.ts`'s own
 * revert thunk, since a device that cannot be reached to restore is not a
 * reason to throw out of a clear the operator explicitly asked for.
 */
export async function restoreLockScreenLabel(transport: Transport, captured: LockScreenLabel, log: Logger): Promise<void> {
  await transport
    .exec(`settings put secure ${OWNER_INFO_KEY} ${shellQuote(captured.text)}`, { profile: 'probe' })
    .catch((err) => log.debug(`lock-screen label text restore failed: ${String(err)}`))
  await transport
    .exec(`settings put secure ${OWNER_INFO_ENABLED_KEY} ${captured.enabled ? '1' : '0'}`, { profile: 'probe' })
    .catch((err) => log.debug(`lock-screen label enabled restore failed: ${String(err)}`))
}

/**
 * The fallback when nothing was ever captured (`originalCaptured: false`) —
 * Android's own default: owner-info disabled, text cleared. Also idempotent,
 * same reasoning as `restoreLockScreenLabel` above.
 */
export async function clearLockScreenLabelToDefault(transport: Transport, log: Logger): Promise<void> {
  await transport
    .exec(`settings put secure ${OWNER_INFO_ENABLED_KEY} 0`, { profile: 'probe' })
    .catch((err) => log.debug(`lock-screen label disable failed: ${String(err)}`))
  await transport
    .exec(`settings put secure ${OWNER_INFO_KEY} ${shellQuote('')}`, { profile: 'probe' })
    .catch((err) => log.debug(`lock-screen label clear failed: ${String(err)}`))
}
