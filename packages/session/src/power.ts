import { shellQuote } from '@enkaku/adb'
import type { AwakeApplyOutcome, KeepAwakeMode, ObservedScreen, Transport } from '@enkaku/protocol'
import type { Logger } from './logger'

/**
 * The transport-level half of the awake policy (plan 125 §3.3, §4.1) — the
 * two PERSISTED device settings that keep a boxed phone awake, plus the one
 * read-only probe that asks the phone whether its panel is actually lit.
 *
 * This file is to `packages/core/src/device/awake-policy.ts` exactly what
 * `screen-label.ts` is to `packages/core/src/device/labelling.ts`: the module
 * that owns the adb commands and the read-back discipline, holding no state
 * of its own, so the core-side service can own the persistence (the
 * `devices.power_capture` column) and nothing else. `wakeDevice` in
 * `./wake.ts` is the second caller — the runtime nudge and the persisted
 * writes belong in one sequence (plan 125 §5 step 125.2), not two.
 *
 * ### Why persisted settings and not a runtime hold (plan 125 §3.3)
 *
 * The owner's phones live in a sealed phone-farm box: no screen, no hands on
 * them, and the recovery cost of a bad write is hardware disassembly (§0.2).
 * `Settings.Global.STAY_ON_WHILE_PLUGGED_IN` (what `svc power stayon` writes)
 * and `Settings.System.screen_off_timeout` are both persistent on the device:
 * they survive a core restart, a core crash, and a phone reboot; both are
 * readable straight back; both revert with one adb write; and neither can
 * strand a phone off the network. A runtime wake-lock has none of those
 * properties. That is the entire argument for this file existing.
 *
 * ### The three rules every function here obeys (plan 125 §0.2)
 *
 * 1. **Read back or `refused`.** No function here returns `applied` for a
 *    write it did not observe land. Acceptance criterion 4.
 * 2. **Reversible over adb alone.** `restoreStayOn` puts back the device's own
 *    literal string; `applyScreenOffTimeout` takes the captured number.
 * 3. **Never dependent on physical access.** Nothing here reboots, and nothing
 *    here touches Wi-Fi, network configuration, or lock-screen credentials —
 *    §3.4 refuses that whole category outright.
 */

/**
 * `svc power stayon` accepts `true|false|usb|ac|wireless`; `usb` only holds
 * the screen while plugged into USB, which does nothing for a device attached
 * over `adb-tcp` (Plan 17 §3.4, and the reason plan 125 §3.3 moved
 * `prep.keepAwake`'s default off `while-charging` — a default that is a
 * documented no-op on this farm's transport would make the new awake default
 * a lie).
 *
 * Lives here rather than in `./wake.ts` (its home before plan 125) because
 * `satisfiesStayOn` below needs it and `wake.ts` imports FROM this file; the
 * old export path still works — `wake.ts` re-exports it.
 */
export const STAYON: Record<KeepAwakeMode, string> = {
  off: 'false',
  'while-charging': 'usb',
  always: 'true',
}

const SCREEN_OFF_TIMEOUT_NS = 'system'
const SCREEN_OFF_TIMEOUT_KEY = 'screen_off_timeout'
const STAY_ON_NS = 'global'
const STAY_ON_KEY = 'stay_on_while_plugged_in'

/** What one `settings get` pair reported. Both nullable — "could not be read" is a real answer, not an error (plan 125 §4.1). */
export interface PowerReadback {
  /** Milliseconds, or null when the key is unset or unreadable. */
  screenOffTimeoutMs: number | null
  /** The RAW string the device printed, kept verbatim so a restore is byte-for-byte (plan 125 acceptance criterion 3). */
  stayOnWhilePluggedIn: string | null
}

/** One setting's fate. `reason` is only ever set when something was refused or deliberately skipped. */
export interface PowerWrite {
  outcome: AwakeApplyOutcome
  reason: string | null
}

const UNCHANGED: PowerWrite = { outcome: 'unchanged', reason: null }

/**
 * One `reason` for two independent writes, and **a refusal always wins**.
 *
 * `unchanged` carries a reason too ("this farm leaves the device's own screen
 * timeout alone"), and letting that shadow a genuine `refused` on the other
 * setting is how a boxed phone's real failure ends up unreported — the exact
 * shape of the problem plan 125 §0.2 is about. Shared by `wakeDevice` and
 * `packages/core/src/device/awake-policy.ts` so the two cannot drift.
 */
export function firstPowerReason(...writes: PowerWrite[]): string | null {
  return writes.find((w) => w.outcome === 'refused')?.reason ?? writes.find((w) => w.reason !== null)?.reason ?? null
}

/**
 * `settings get` prints the literal string `null` for a key that was never
 * set — normalised to `null` here, the same normalisation
 * `screen-label.ts`'s `normaliseUnset` already applies one namespace over.
 */
function normaliseUnset(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed === '' || trimmed === 'null' ? null : trimmed
}

async function settingsGet(transport: Transport, namespace: string, key: string): Promise<string | null> {
  return transport
    .exec(`settings get ${namespace} ${key}`, { profile: 'probe' })
    .then((r) => normaliseUnset(r.stdout))
    .catch(() => null)
}

function toInt(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Read-only. Never writes, so it is safe on the capture path (which must run
 * BEFORE the first write, plan 125 §3.3) and on a pure status probe.
 *
 * Two round trips, and every caller in this codebase reuses the answer rather
 * than re-reading: `applyScreenOffTimeout`/`applyStayOn` below take the
 * current value as an argument for exactly that reason. It is also what pays
 * for itself — plan 96 §22 measured `svc power stayon` at **1422 ms**, ten
 * times everything else in a session build combined, so one cheap read that
 * lets an already-correct device skip that write is a large net win.
 */
export async function readPowerState(transport: Transport): Promise<PowerReadback> {
  const timeoutRaw = await settingsGet(transport, SCREEN_OFF_TIMEOUT_NS, SCREEN_OFF_TIMEOUT_KEY)
  const stayOnRaw = await settingsGet(transport, STAY_ON_NS, STAY_ON_KEY)
  return { screenOffTimeoutMs: toInt(timeoutRaw), stayOnWhilePluggedIn: stayOnRaw }
}

/**
 * `settings put system screen_off_timeout <ms>`, verified by reading it
 * straight back (plan 125 §3.3 step 1) — the discipline plan 89 §3.5's
 * lock-screen tier already follows.
 *
 * `desiredMs === null` means "leave the phone's own value alone"
 * (`prep.screenOffTimeoutMs`'s documented null, plan 125 §4.2) and issues no
 * write at all — a farm that wants nothing touched here pays nothing.
 *
 * `current` is the value `readPowerState` already read, passed in rather than
 * re-read: the caller has it, and a second `settings get` on the hot wake path
 * would be pure waste.
 */
export async function applyScreenOffTimeout(transport: Transport, desiredMs: number | null, current: number | null, log: Logger): Promise<PowerWrite> {
  if (desiredMs === null) return { outcome: 'unchanged', reason: 'this farm leaves the device’s own screen timeout alone' }
  if (current === desiredMs) return UNCHANGED
  try {
    await transport.exec(`settings put ${SCREEN_OFF_TIMEOUT_NS} ${SCREEN_OFF_TIMEOUT_KEY} ${shellQuote(String(desiredMs))}`, { profile: 'probe' })
  } catch (err) {
    const reason = `the device refused the screen timeout write: ${err instanceof Error ? err.message : String(err)}`
    log.debug(reason)
    return { outcome: 'refused', reason }
  }
  const after = toInt(await settingsGet(transport, SCREEN_OFF_TIMEOUT_NS, SCREEN_OFF_TIMEOUT_KEY))
  if (after === desiredMs) return { outcome: 'applied', reason: null }
  // Read-back mismatch. NEVER `applied` (acceptance criterion 4): a ROM that
  // ignores the key, a shell UID that turns out not to hold
  // WRITE_SETTINGS for it, or an adb hiccup between the two calls all land
  // here, and an operator staring at a boxed phone has to be told.
  const reason = `the device did not accept a ${desiredMs} ms screen timeout (it reads ${after === null ? 'unreadable' : `${after} ms`} after the write)`
  log.debug(reason)
  return { outcome: 'refused', reason }
}

/**
 * Does a raw `stay_on_while_plugged_in` value satisfy `mode`?
 *
 * The value is a bitmask of `BatteryManager` plug types —
 * `AC=1 | USB=2 | WIRELESS=4 | DOCK=8` — and `svc power stayon` writes it via
 * `PowerManager.setStayOnSetting`:
 *
 * - `false` → `0`, so an exact 0 is the only satisfying value.
 * - `usb` → `BATTERY_PLUGGED_USB`, exactly `2`.
 * - `true` → "any plug type", whose bit set **grew** across Android versions:
 *   `AC|USB|WIRELESS` = 7 before dock charging existed, and 15 once
 *   `BATTERY_PLUGGED_DOCK` joined it. So `true` is checked as "AC, USB and
 *   wireless are all set" rather than an exact number — an equality check
 *   against 7 would report `refused` on a modern device that genuinely
 *   accepted the write, and a false `refused` on a boxed phone is its own
 *   kind of harm (it invites a second, unnecessary write).
 */
export function satisfiesStayOn(raw: string | null, mode: KeepAwakeMode): boolean {
  const value = toInt(raw)
  if (value === null) return false
  if (mode === 'off') return value === 0
  if (mode === 'while-charging') return value === 2
  return (value & 7) === 7
}

/**
 * `svc power stayon <mode>`, verified by reading
 * `stay_on_while_plugged_in` straight back (plan 125 §3.3 step 2).
 *
 * `svc` is the expensive call in this whole subsystem — plan 96 §22 measured
 * **1422 ms**, because it starts an `app_process` JVM to reach the power
 * service — so the `unchanged` early-out above it is not a micro-optimisation,
 * it is the single cheapest second available on a warm wake.
 */
export async function applyStayOn(transport: Transport, mode: KeepAwakeMode, current: string | null, log: Logger): Promise<PowerWrite> {
  if (satisfiesStayOn(current, mode)) return UNCHANGED
  try {
    await transport.exec(`svc power stayon ${STAYON[mode]}`, { profile: 'probe' })
  } catch (err) {
    const reason = `the device refused \`svc power stayon ${STAYON[mode]}\`: ${err instanceof Error ? err.message : String(err)}`
    log.debug(reason)
    return { outcome: 'refused', reason }
  }
  const after = await settingsGet(transport, STAY_ON_NS, STAY_ON_KEY)
  if (satisfiesStayOn(after, mode)) return { outcome: 'applied', reason: null }
  const reason = `the device did not accept \`svc power stayon ${STAYON[mode]}\` (stay_on_while_plugged_in reads ${after ?? 'unreadable'} after the write)`
  log.debug(reason)
  return { outcome: 'refused', reason }
}

/**
 * Put `stay_on_while_plugged_in` back to the device's own captured literal
 * (plan 125 §0.2 rule 2, acceptance criterion 3).
 *
 * Deliberately `settings put`, not `svc power stayon`: `svc` only speaks the
 * three tokens in `STAYON`, and the value we captured may be none of them —
 * a device that shipped with `1` (AC only) has no `svc` token that restores
 * it. Writing the raw string is the only way "restore" means what it says.
 *
 * A `null` capture (the key was unreadable when we looked) is `unchanged`
 * with a reason, never a guess at what the device "probably" had. Guessing
 * here is precisely the failure mode plan 89 §3.6 records for the wallpaper
 * tier, and §3.3 says not to repeat it.
 */
export async function restoreStayOn(transport: Transport, captured: string | null, current: string | null, log: Logger): Promise<PowerWrite> {
  if (captured === null) return { outcome: 'unchanged', reason: 'the device’s original stay-awake value was never readable, so there is nothing exact to put back' }
  if (current !== null && toInt(current) === toInt(captured)) return UNCHANGED
  try {
    await transport.exec(`settings put ${STAY_ON_NS} ${STAY_ON_KEY} ${shellQuote(captured)}`, { profile: 'probe' })
  } catch (err) {
    const reason = `the device refused the stay-awake restore: ${err instanceof Error ? err.message : String(err)}`
    log.debug(reason)
    return { outcome: 'refused', reason }
  }
  const after = await settingsGet(transport, STAY_ON_NS, STAY_ON_KEY)
  if (after !== null && toInt(after) === toInt(captured)) return { outcome: 'applied', reason: null }
  const reason = `the device did not accept the stay-awake restore to ${captured} (it reads ${after ?? 'unreadable'} after the write)`
  log.debug(reason)
  return { outcome: 'refused', reason }
}

/**
 * Ask the phone whether its panel is lit (plan 125 §3.6).
 *
 * **The probe is `dumpsys power | grep -m1 mWakefulness`**, chosen over
 * `dumpsys display` for three reasons:
 *
 * 1. **Cheapest over the wire.** The `grep` runs ON the device, so exactly one
 *    short line crosses adb. `dumpsys display`'s screen state lives inside a
 *    nested per-display-device block that needs several lines of context to
 *    read correctly.
 * 2. **Most portable.** `mWakefulness=Awake|Asleep|Dreaming|Dozing` has been
 *    `PowerManagerService`'s dump line since Android 5 and is untouched by OEM
 *    skins. `dumpsys display`'s `mScreenState`/`mState` fields have moved
 *    between sections across releases and differ on multi-display devices —
 *    exactly the SM-F721U1 foldables this farm is made of.
 * 3. **It is already this codebase's idiom.** `wakeDevice`'s keyguard check is
 *    `dumpsys window | grep -m1 isKeyguardShowing`; this is the same shape,
 *    one service over.
 *
 * `grep -m1` cannot accidentally match `mWakefulnessChanging=false`: that line
 * contains no `mWakefulness=`, and the regex below anchors on the `=`.
 *
 * **A probe that could not run returns `unknown`, NEVER `off`** (acceptance
 * criterion 5). This is the whole reason the module exists: plan 125 §0.3
 * found `readiness.actual` reporting `asleep` purely because no session was
 * open, having never asked the phone anything. An unanswerable question must
 * stay unanswered rather than collapse into the more alarming answer.
 */
export async function observeScreen(transport: Transport, log: Logger): Promise<Omit<ObservedScreen, 'observedAt'>> {
  let out: string
  try {
    const result = await transport.exec('dumpsys power | grep -m1 mWakefulness', { profile: 'probe' })
    out = result.stdout
  } catch (err) {
    const reason = `the screen-state probe could not run: ${err instanceof Error ? err.message : String(err)}`
    log.debug(reason)
    return { state: 'unknown', reason }
  }
  const match = /mWakefulness=([A-Za-z_]+)/.exec(out)
  if (!match) return { state: 'unknown', reason: 'the device’s power dump had no mWakefulness line' }
  const token = match[1]
  // `Dreaming` is a screensaver — the panel IS lit, so it is `on`. `Dozing`
  // is ambient/always-on display: the panel is technically driven, but the
  // device is asleep for every purpose this farm cares about (input, video,
  // adb responsiveness), so it reads `off`.
  if (token === 'Awake' || token === 'Dreaming') return { state: 'on', reason: `mWakefulness=${token}` }
  if (token === 'Asleep' || token === 'Dozing' || token === 'Doze') return { state: 'off', reason: `mWakefulness=${token}` }
  return { state: 'unknown', reason: `the device reported an unrecognised wakefulness: ${token}` }
}
