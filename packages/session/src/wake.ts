import type { AwakeApplyResult, AwakeKeyguardOutcome, KeepAwakeMode, Transport } from '@enkaku/protocol'
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
  /**
   * Send one Android keycode down an ALREADY-OPEN session control socket,
   * resolving `false` when there is no session to send it down.
   *
   * `input keyevent` is a shell wrapper around `app_process`, so every nudge
   * below starts a JVM on the phone — the same shape of cost as the
   * `svc power stayon` `power.ts` now avoids, and paid two or three times per
   * wake. A scrcpy-backed session already holds a control socket to a process
   * that is running, and `InputSink.key` on that engine is one
   * `INJECT_KEYCODE` message on it (`ScrcpySdkInput.key`), which is why this
   * is a port rather than a rewrite: the caller decides whether a session
   * exists, and this function keeps the shell as its floor.
   *
   * Absent, or resolving `false`, means the shell path runs exactly as it
   * always has. A device with no session — the case `readiness.ts` calls this
   * for most often, a phone genuinely asleep — is that floor, not a failure.
   */
  injectKey?: (keycode: number) => Promise<boolean>
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
 * A swipe-only lock screen is dismissed by `wm dismiss-keyguard`, with
 * `KEYCODE_MENU` kept only as the fallback for a ROM too old to have that
 * command — see `dismissKeyguard` below for why that order and not the
 * reverse. A device with a PIN, pattern, or password cannot be unlocked from
 * here, and will keep showing its lock screen; that is a real limit, not a
 * failure to handle (Plan 43 §2, `blocked: 'locked'`), and it is now
 * REPORTED as `keyguard: 'showing'` rather than silently left to the
 * operator to discover.
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
    return { screenOffTimeout: 'unchanged', stayOn: 'unchanged', keyguard: null, reason: 'this device is opted out of keeping the screen awake' }
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

  /*
    The wake nudge and the keyguard probe, in ONE round trip where we can
    (plan 228 §3.3).

    These were two separate `transport.exec` calls, and adb access is strictly
    serialised per device (`PerDeviceQueue`), so they were two round trips —
    one of them an `input keyevent`, which is a shell wrapper around
    `app_process` and therefore starts a JVM on the phone. Both sit on the
    critical line between an operator's click and the picture, on every cold
    session build and every readiness reconcile.

    The shell can do both in one command, and the ORDER is the point: the
    keyevent runs first, so the keyguard is probed AFTER the wake rather than
    before it — which is also more correct than the old sequence, where a
    device woken by the nudge was asked about its lock screen in the same
    breath as being woken and could answer from the state it was leaving.

    `injectKey` is the one case that stays split: it sends the keycode down an
    already-open control socket and costs no adb round trip at all, so there
    is nothing to batch it with — the probe then runs on its own, exactly as
    it always did.
  */
  let locked: boolean
  if (opts.injectKey) {
    await pressKey(transport, KEYCODE_WAKEUP, 'the wake nudge', opts)
    locked = await isKeyguardShowing(transport)
  } else {
    locked = await wakeAndProbeKeyguard(transport, opts)
  }

  // Only touch the lock screen when there is one. The fallback rung
  // (KEYCODE_MENU) is actively harmful on a phone that is already unlocked:
  // it opens the launcher's wallpaper/widget menu, and the operator's next
  // tap just closes that menu instead of hitting the app they aimed at.
  const keyguard = locked ? await dismissKeyguard(transport, opts) : ('absent' as const)

  /*
    One `reason`, three things that could want it, ranked by what an operator
    can act on.

    A REFUSED power write comes first: something we asked for did not take, and
    that is the farm's own bug to chase. A stuck lock screen comes next,
    because a phone in a sealed box that nobody can reach still needs saying
    out loud — and it outranks the benign notes `firstPowerReason` also
    returns ("this farm leaves the device's own screen timeout alone" is not
    news; "this phone has a PIN on it" is). Those benign notes come last.
  */
  const powerReason = firstPowerReason(timeout, stayOn)
  const powerRefused = timeout.outcome === 'refused' || stayOn.outcome === 'refused'
  return {
    screenOffTimeout: timeout.outcome,
    stayOn: stayOn.outcome,
    keyguard,
    reason: powerRefused ? powerReason : keyguard === 'showing' ? KEYGUARD_STUCK_REASON : powerReason,
  }
}

/**
 * The two Android keycodes this module presses, as numbers.
 *
 * Numbers rather than the `KEYCODE_*` names `input keyevent` also accepts,
 * because the fast path is `INJECT_KEYCODE` over scrcpy's control socket and
 * that message carries an int. `input keyevent` takes either, so writing the
 * number costs the shell path nothing and keeps ONE spelling for both rungs.
 */
const KEYCODE_WAKEUP = 224
const KEYCODE_MENU = 82

/** The cheap keyguard probe, shared by every rung below so there is one spelling of it. */
const KEYGUARD_PROBE = 'dumpsys window policy | grep -m1 isKeyguardShowing'

/**
 * How long to let the device settle between `wm dismiss-keyguard` and the
 * re-probe, as a whole number of seconds because that is what every Android
 * shell's `sleep` accepts (fractional seconds are toybox-only).
 *
 * `wm dismiss-keyguard` does not unlock the phone before it returns — it posts
 * the request to the WindowManager, which runs the keyguard's exit animation.
 * Probing in the same breath reads the state it is leaving and answers
 * `isKeyguardShowing=true` on a phone that is in the middle of unlocking, which
 * would send us down the `KEYCODE_MENU` rung for no reason. It is one second,
 * paid only on a device that actually had a lock screen up — the case that
 * until now cost the operator a manual swipe.
 *
 * It fits the `probe` profile's 5 s budget with room to spare, and it fits it
 * the same way the wake nudge above already does: that command pays an
 * `input keyevent`, which starts a JVM on the phone, before its own dumpsys.
 */
const KEYGUARD_SETTLE_SEC = 1

/** `AwakeApplyResult.reason` when the lock screen outlived every rung we have. */
const KEYGUARD_STUCK_REASON =
  'the lock screen is still up after the dismiss — a device with a PIN, pattern or password cannot be unlocked from here (plan 43 §2)'

/**
 * Get a lock screen out of the way, best rung first.
 *
 * ### Why `wm dismiss-keyguard` and not `KEYCODE_MENU`
 *
 * `KEYCODE_MENU` was the whole of this step, and it has not dismissed a
 * keyguard since Android 9: `PhoneWindowManager` stopped routing MENU into
 * the keyguard's dismiss path, so on every modern phone the nudge was sent,
 * swallowed, and the device left sitting on its lock screen — which the
 * operator then had to swipe by hand inside Device Control, on every single
 * connect. `wm dismiss-keyguard` is the supported request (Android 8+, API
 * 26) and is what `reset.ts` has always used for the identical job three
 * files away.
 *
 * `KEYCODE_MENU` stays as the FLOOR rather than being deleted: it is what an
 * Android 7 or older device still answers to, and it costs nothing on a phone
 * that already unlocked because we only reach it when the re-probe says the
 * keyguard is still up. Pressing it there is safe for the reason the caller's
 * comment gives — the launcher's widget menu can only open on a phone that is
 * already unlocked, and this rung is unreachable in that case.
 *
 * A secured device (PIN, pattern, password) ends here as `showing`, with the
 * bouncer up rather than the lock screen. That is the honest answer, and it is
 * the answer `readiness.ts` turns into `blocked: 'locked'` so an operator sees
 * WHY a phone in a sealed box never came up, instead of a silent dark tile.
 * The farm never types a credential — plan 125 §3.4 refuses that category
 * outright, and nothing here changes it.
 */
async function dismissKeyguard(transport: Transport, opts: WakeDeviceOpts): Promise<AwakeKeyguardOutcome> {
  const settled = await transport
    .exec(`wm dismiss-keyguard; sleep ${KEYGUARD_SETTLE_SEC}; ${KEYGUARD_PROBE}`, { profile: 'probe' })
    .then((r) => r.stdout)
    .catch((err) => {
      opts.log.debug(`the keyguard dismiss failed: ${String(err)}`)
      return null
    })
  if (settled !== null && /isKeyguardShowing=false/.test(settled)) return 'dismissed'

  // Either this ROM has no `wm dismiss-keyguard`, or it printed nothing we
  // recognise, or the keyguard is genuinely still up. All three want the old
  // rung tried before we call it locked.
  await pressKey(transport, KEYCODE_MENU, 'the keyguard nudge', opts)
  const still = await isKeyguardShowing(transport)
  if (still) opts.log.debug(KEYGUARD_STUCK_REASON)
  return still ? 'showing' : 'dismissed'
}

/**
 * Press one key: the session's control socket when the caller gave us one,
 * the shell otherwise.
 *
 * Best-effort in both directions and deliberately so — this is the runtime
 * nudge, not the persisted state. A failure here leaves a phone that is
 * already holding `stay_on_while_plugged_in` (the two writes above ran first,
 * plan 125 §3.3), so the worst case is a dark panel an operator can relight
 * from a browser tab, which is the trade-off that ordering was chosen for.
 */
async function pressKey(transport: Transport, keycode: number, what: string, opts: WakeDeviceOpts): Promise<void> {
  if (opts.injectKey) {
    const injected = await opts.injectKey(keycode).catch((err) => {
      opts.log.debug(`${what} could not be injected over the session (falling back to the shell): ${String(err)}`)
      return false
    })
    if (injected) return
  }
  await transport.exec(`input keyevent ${keycode}`, { profile: 'probe' }).catch((err) => opts.log.debug(`${what} failed: ${String(err)}`))
}

/**
 * Is a lock screen up right now?
 *
 * This ran as `dumpsys window | grep -m1 isKeyguardShowing`, which asks the
 * WindowManager to serialise EVERYTHING — every window, every token, every
 * animation — and then throws all but one line of it away. It is the most
 * expensive command on the wake path, and the wake path runs per device.
 *
 * `dumpsys window policy` prints the section the flag actually lives in and
 * is a small fraction of the output. It is not universal, though: the section
 * name and the flag's spelling have both moved between Android releases, so a
 * device that prints nothing recognisable falls back to the full dump rather
 * than defaulting to "unlocked" — guessing wrong here means either a keyguard
 * left up over a session (guessing false) or the launcher's widget menu
 * opened under the operator's first tap (guessing true), and the fallback
 * costs one extra call on exactly the devices that need it.
 */
/**
 * `input keyevent KEYCODE_WAKEUP` and the cheap keyguard probe in one shell
 * command (plan 228 §3.3) — one adb round trip instead of two.
 *
 * Reads exactly like `isKeyguardShowing`'s first rung and falls back to the
 * same full `dumpsys window` when the output is not recognisable, so a ROM
 * whose section name or flag spelling has moved is no worse off than before.
 * The keyevent's own failure stays invisible here for the same reason
 * `pressKey` swallows it: this is the runtime nudge, not the persisted state,
 * and a dark panel an operator can relight is the tolerated outcome.
 */
async function wakeAndProbeKeyguard(transport: Transport, opts: WakeDeviceOpts): Promise<boolean> {
  const out = await transport
    .exec(`input keyevent ${KEYCODE_WAKEUP}; ${KEYGUARD_PROBE}`, { profile: 'probe' })
    .then((r) => r.stdout)
    .catch((err) => {
      opts.log.debug(`the wake nudge failed: ${String(err)}`)
      return null
    })
  if (out !== null && /isKeyguardShowing=(true|false)/.test(out)) return /isKeyguardShowing=true/.test(out)
  return await isKeyguardShowing(transport)
}

async function isKeyguardShowing(transport: Transport): Promise<boolean> {
  const read = async (cmd: string): Promise<string | null> =>
    transport
      .exec(cmd, { profile: 'probe' })
      .then((r) => r.stdout)
      .catch(() => null)

  const cheap = await read(KEYGUARD_PROBE)
  if (cheap !== null && /isKeyguardShowing=(true|false)/.test(cheap)) return /isKeyguardShowing=true/.test(cheap)
  const full = await read('dumpsys window | grep -m1 isKeyguardShowing')
  return full !== null && /isKeyguardShowing=true/.test(full)
}
