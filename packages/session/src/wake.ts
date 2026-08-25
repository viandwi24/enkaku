import type { AwakeApplyResult, KeepAwakeMode, Transport } from '@enkaku/protocol'
import { applyScreenOffTimeout, applyStayOn, firstPowerReason, readPowerState, type PowerReadback } from './power'
import type { Logger } from './logger'

/**
 * `STAYON` moved to `./power.ts` in plan 125 (`satisfiesStayOn` needs it, and
 * this file imports FROM that one), and is re-exported here so every existing
 * import path — `@enkaku/session`'s index, `wake.test.ts` — keeps working
 * unchanged.
 */
export { STAYON } from './power'

export interface WakeDeviceOpts {
  keepAwake: KeepAwakeMode
  /**
   * `DeviceSettings.prep.screenOffTimeoutMs` (plan 125 §4.2). `null` or
   * absent = leave the device's own timeout alone, and no write is issued.
   *
   * This is the piece that keeps a boxed phone awake **even when the core is
   * not running at all** (plan 125 §3.3): `svc power stayon` only holds the
   * screen while the device is plugged in, and the readiness manager reverts
   * it on the way to `asleep`, whereas `screen_off_timeout` is the phone's own
   * persistent setting and survives a core restart, a core crash, and a
   * reboot.
   */
  screenOffTimeoutMs?: number | null
  /**
   * Capture-before-write sink (plan 125 §0.2 rule 1, §3.3).
   *
   * The owner's phones are sealed in a box, so the recovery cost of a bad
   * write is hardware disassembly — which makes "what did this phone have
   * before Enkaku touched it" a value that must be stored BEFORE the first
   * write, not reconstructed afterwards. This module holds no state, so the
   * caller supplies a sink: `packages/core/src/device/awake-policy.ts`
   * persists it into `devices.power_capture`, and never overwrites an
   * existing capture.
   *
   * It receives the state this function read anyway, so wiring it costs zero
   * extra round trips.
   *
   * **Omitting it is not free**: without a sink there is nowhere to record
   * what we are about to overwrite, so the persisted `screen_off_timeout`
   * write is REFUSED rather than issued (see below). `svc power stayon` is
   * unaffected — that write predates this plan, has always been reverted by
   * `releaseAwake`/`close()`, and is not this plan's to gate.
   */
  capture?: (state: PowerReadback) => void | Promise<void>
  log: Logger
}

/**
 * Wake the screen and hold it awake (Plan 17 §3.4, extracted by Plan 43 §5
 * step 43.2 so there is ONE implementation, not two): `createSession` calls
 * this at the start of every session, and the readiness manager
 * (`packages/core/src/device/readiness.ts`) calls it to reconcile a device
 * toward `desired: 'awake'` without opening a session at all.
 *
 * `off` is a no-op, same as the old inline `stayAwake: false` did — a device
 * opted out keeps opting out unchanged (Plan 17 §4.2), and plan 125 does NOT
 * change that: a farm that turned this off gets nothing written to it, timeout
 * included.
 *
 * The keyevent 82 dismisses a swipe-only lock screen. A device with a PIN,
 * pattern, or password cannot be unlocked from here, and will keep showing
 * its lock screen; that is a real limit, not a failure to handle (Plan 43 §2,
 * `blocked: 'locked'`).
 *
 * ### What plan 125 §3.3 added, and in which order
 *
 * The sequence is now: **persisted `screen_off_timeout` → persisted
 * `svc power stayon` → the runtime `KEYCODE_WAKEUP` nudge → the conditional
 * keyguard nudge.** The two persisted writes come first deliberately: they are
 * what survives this process, so a core killed mid-sequence has already left
 * the phone in the state that keeps it reachable, and the nudge it did not get
 * to send is the one thing an operator can replace from a browser tab.
 *
 * Both persisted writes are read back and reported honestly — this function
 * now RETURNS what actually took, rather than swallowing everything. The
 * return value is additive: every existing caller ignores it and behaves
 * exactly as before.
 *
 * The one extra cost is a single `readPowerState` (two `settings get` calls)
 * before the writes, and it pays for itself several times over: plan 96 §22
 * measured `svc power stayon` at **1422 ms**, and knowing the device already
 * holds the value is what lets this skip it.
 */
export async function wakeDevice(transport: Transport, opts: WakeDeviceOpts): Promise<AwakeApplyResult> {
  const { keepAwake, log } = opts
  if (keepAwake === 'off') {
    return { screenOffTimeout: 'unchanged', stayOn: 'unchanged', reason: 'this device is opted out of keeping the screen awake' }
  }

  const current = await readPowerState(transport)
  if (opts.capture) {
    // Tolerated on failure, and deliberately BEFORE any write: a capture sink
    // that throws must not leave the device half-written, but it also must not
    // stop the wake — a phone that stays dark is the worse outcome of the two
    // (plan 125 §0.2's whole framing). The refusal below is what keeps the
    // persisted write honest when there is no sink at all.
    try {
      await opts.capture(current)
    } catch (err) {
      log.debug(`power capture sink failed (tolerated): ${String(err)}`)
    }
  }

  const wantTimeout = opts.screenOffTimeoutMs ?? null
  const timeout =
    wantTimeout !== null && !opts.capture
      ? {
          outcome: 'refused' as const,
          reason: 'no capture sink was wired, so the device’s own screen timeout would have been overwritten with no record of what it was (plan 125 §0.2)',
        }
      : await applyScreenOffTimeout(transport, wantTimeout, current.screenOffTimeoutMs, log)
  const stayOn = await applyStayOn(transport, keepAwake, current.stayOnWhilePluggedIn, log)

  await transport.exec('input keyevent KEYCODE_WAKEUP', { profile: 'probe' }).catch((err) => log.debug(`input keyevent KEYCODE_WAKEUP failed: ${String(err)}`))

  // Only nudge the lock screen when there is one. KEYCODE_MENU dismisses a
  // swipe-only keyguard, but on a phone that is already unlocked it opens the
  // launcher's wallpaper/widget menu — and the user's next tap just closes
  // that menu instead of hitting the app they aimed at.
  const locked = await transport
    .exec('dumpsys window | grep -m1 isKeyguardShowing', { profile: 'probe' })
    .then((r) => /isKeyguardShowing=true/.test(r.stdout))
    .catch(() => false)
  if (locked) {
    await transport.exec('input keyevent 82', { profile: 'probe' }).catch((err) => log.debug(`keyguard nudge failed: ${String(err)}`))
  }

  return { screenOffTimeout: timeout.outcome, stayOn: stayOn.outcome, reason: firstPowerReason(timeout, stayOn) }
}
