import type { RotationMode, Transport } from '@enkaku/protocol'
import type { Logger } from './logger'

/**
 * `user_rotation` values Android's `WindowManagerService` accepts: 0 =
 * portrait (natural), 1 = landscape (rotated 90°), 2 = upside-down portrait,
 * 3 = landscape (rotated 270°). `lock-portrait` and `lock-landscape` each
 * pick one deterministic value — there is no ambiguity to resolve for them.
 */
const FIXED_TARGET: Record<'lock-portrait' | 'lock-landscape', string> = {
  'lock-portrait': '0',
  'lock-landscape': '1',
}

const VALID_USER_ROTATION = new Set(['0', '1', '2', '3'])

/** `mCurrentRotation=ROTATION_<deg>` → the `user_rotation` value that means the same thing. */
const DEGREES_TO_USER_ROTATION: Record<string, string> = { '0': '0', '90': '1', '180': '2', '270': '3' }

/**
 * What `applyRotation`/`RotationLock.set` actually achieved, read back from
 * the device rather than assumed from a write's exit code.
 *
 * `applied` is the field that exists because the original implementation had
 * no equivalent: every `settings put` failure was swallowed into `log.debug`,
 * so an operator who asked for a portrait lock and did not get one saw
 * nothing at all — not in the UI, not in the device log, not even at `warn`.
 * "The thing you asked for did not occur" is not debug-level information.
 */
export interface RotationOutcome {
  mode: RotationMode
  /** The `user_rotation` value written. `null` for `'device'`, which writes nothing. */
  target: string | null
  /**
   * Both settings read back as the values this lock wrote. Always `true` for
   * `'device'` — there is nothing to apply, so there is nothing that can have
   * failed.
   */
  applied: boolean
  /** Set only when `applied` is false: which write did not take, in words an operator can act on. */
  reason?: string
}

/**
 * A live handle on one session's rotation lock (plan 85 §3.7, replacing the
 * bare revert thunk this function used to return).
 *
 * The thunk was apply-once by construction: `createSession` called
 * `applyRotation` and kept only the closure that undoes it, so changing
 * `DeviceSettings.prep.rotation` while a session was open did nothing at all
 * and said nothing about it — the setting was live in the schema, live in the
 * UI, and inert on screen. `set()` is what makes a mid-session change real.
 */
export interface RotationLock {
  /** The mode currently in force on this session. */
  readonly mode: RotationMode
  /** The result of the most recent apply. */
  readonly outcome: RotationOutcome
  /**
   * Change the lock on a session that is already running. Re-issues the
   * writes for `mode` (or, for `'device'`, hands rotation back by reverting)
   * WITHOUT re-capturing what the device had before this session started:
   * the capture happens exactly once, whenever the first write of this
   * session's life happens, and every later `set()` reuses it. That is what
   * keeps `revert()` honest — a second apply must not be able to record the
   * FIRST apply's own values as "what the device had before Enkaku touched it".
   */
  set(mode: RotationMode): Promise<RotationOutcome>
  /**
   * Put back exactly what was captured. Deliberately dumb: it always
   * re-issues the same writes, no matter how many times it is called and no
   * matter what `set()` did in between, so it is idempotent (a second call
   * writes the identical values the first one did — a no-op on the device)
   * and consults no mutable "have I already reverted" flag. A no-op when
   * nothing was ever captured, which is the `'device'`-throughout case: this
   * session never wrote anything, so it has nothing to put back.
   */
  revert(): Promise<void>
}

/** What the device had before this session wrote anything. Captured at most once (see `RotationLock.set`). */
interface CapturedRotation {
  /**
   * Android's own default is auto-rotate ON. An unreadable value (an adb
   * hiccup, a very early boot) restores to that default rather than to
   * "locked" — the read failing is not a reason to leave the device stuck.
   */
  accel: string
  /**
   * `null` when the prior value could not be read. Unlike `accel` above there
   * is no safe guessed value: writing a made-up fixed orientation would
   * actively rotate the device to something its owner never chose. So the
   * revert simply leaves `user_rotation` untouched — `accelerometer_rotation`
   * still gets restored (handing rotation back to auto), which is the honest
   * partial recovery rather than a confident wrong one.
   */
  user: string | null
}

/**
 * The device's LIVE rotation, as a `user_rotation` value — what
 * `'lock-current'` needs, and deliberately NOT `settings get system
 * user_rotation`, which only reflects the last time the device was manually
 * locked and says nothing while auto-rotate is on (the common case, since
 * `'device'` is today's default).
 *
 * A ladder, because the single probe this used to be does not exist anymore.
 * `dumpsys input | grep SurfaceOrientation` was the original (and only)
 * source; on 2026-08-18 it was checked against all five reachable phones in
 * the reference farm — a Samsung SM-A075F and SM-F711B on Android 16/13, two
 * Motorola moto g06, an OPPO CPH2819 and CPH2173 — and printed NOTHING on any
 * of them. `lock-current` therefore never resolved a real orientation on any
 * of this farm's hardware: it fell through to the UNRATIFIED asleep
 * substitution below on every single call, on wide-awake devices, silently
 * behaving as `lock-portrait` while claiming to lock what was on screen.
 *
 * Rungs, first answer wins:
 *   1. `mCurrentRotation=ROTATION_<deg>` from `dumpsys window displays` — the
 *      default display's own rotation, the exact quantity `user_rotation`
 *      pins. Present on all five phones tested.
 *   2. `Viewport INTERNAL: … orientation=<0..3>` from `dumpsys input` — the
 *      same number by another route; also present on all five.
 *   3. The legacy `SurfaceOrientation` line, kept because it costs one grep
 *      and older builds than anything in this farm may still print it.
 *
 * `grep -m1` is deliberately not used: it closes the pipe on the first match
 * and dumpsys dies of SIGPIPE ("Failed to write while dumping service" —
 * observed on every device tested), which can surface as a non-zero exit and
 * turn a perfectly good read into a caught failure. The first match is picked
 * here instead, where nothing can be lost by it.
 */
async function readLiveRotation(transport: Transport): Promise<string> {
  const run = (cmd: string): Promise<string> =>
    transport
      .exec(cmd, { profile: 'probe' })
      .then((r) => r.stdout)
      .catch(() => '')

  const displays = await run('dumpsys window displays | grep mCurrentRotation')
  const degrees = /mCurrentRotation=ROTATION_(\d+)/.exec(displays)?.[1] ?? ''
  const fromDegrees = DEGREES_TO_USER_ROTATION[degrees]
  if (fromDegrees !== undefined) return fromDegrees

  const viewport = await run("dumpsys input | grep 'Viewport INTERNAL'")
  const orientation = /orientation=(\d)/.exec(viewport)?.[1] ?? ''
  if (VALID_USER_ROTATION.has(orientation)) return orientation

  const legacy = await run('dumpsys input | grep SurfaceOrientation')
  const surface = /SurfaceOrientation:\s*(\d)/.exec(legacy)?.[1] ?? ''
  if (VALID_USER_ROTATION.has(surface)) return surface

  return ''
}

/**
 * `'lock-current'` locks whatever orientation is on screen right now.
 *
 * A device asleep at session start has no live surface to read, so every rung
 * of `readLiveRotation` comes back empty — plan 85 §9 Q4 flags this as a case
 * with no inherently correct answer. The substitution below (fall back to
 * `lock-portrait`, log it) is the plan's proposal, **still UNRATIFIED**; it is
 * kept in this one function so changing the answer later is a one-line edit.
 * Fixing the probe above did not ratify it — it only stopped this branch from
 * firing on awake devices, which is where it was doing real damage.
 */
async function resolveCurrentTarget(transport: Transport, log: Logger): Promise<string> {
  const reported = await readLiveRotation(transport)
  if (VALID_USER_ROTATION.has(reported)) return reported
  // UNRATIFIED (plan 85 §9 Q4): treating "no current orientation" as
  // lock-portrait is the plan's own proposal, not a product decision anyone
  // has signed off on. Logged at `warn` so the substitution is visible, not
  // a silent guess.
  log.warn('rotation "lock-current" requested but the device reports no current orientation (likely asleep) — locking to portrait instead')
  return FIXED_TARGET['lock-portrait']
}

/**
 * Screen rotation lock (plan 85 §3.7, §4.1, §5 step 85.8, acceptance #16).
 * Mirrors `wakeDevice`'s shape: read what the device already has, apply the
 * requested lock, and hand back something that can put it back.
 * `createSession` calls this next to `wakeDevice`; `session.ts`'s `close()`
 * calls `revert()`.
 *
 * `'device'` is today's behaviour, unchanged: nothing is read, nothing is
 * written, and `revert()` is a no-op — there is nothing to put back.
 *
 * Both `accelerometer_rotation` AND `user_rotation` are captured before
 * anything is written, and both are restored. §3.7's prose only mentions the
 * former, but a device already manually locked to landscape
 * (`accelerometer_rotation=0`, `user_rotation=1`) before the session started
 * needs its `user_rotation` put back too — restoring only the auto-rotate
 * flag would leave it locked to whatever THIS session's lock used instead of
 * what its owner had chosen, forever (nothing else ever writes it again).
 * Acceptance #16 ("restores the device's prior setting on close") is the
 * stricter, authoritative statement of intent here.
 *
 * `owned` (default true) is the fast-path control build's flag (plan 100
 * §4.2): a `control` session opened beside an already-open `wall` entry for
 * the same device re-asserts the lock but does NOT capture, and its
 * `revert()` stays a no-op — the wall entry captured the device's true
 * pre-farm state and remains the one that restores it, when IT closes. The
 * re-assert is not redundant with what the wall entry already did: the wall
 * entry may have opened before the setting changed, or its own write may have
 * failed. Writing the same two values twice costs two shell calls and cannot
 * be wrong; skipping them can be, and was.
 */
export async function applyRotation(
  transport: Transport,
  opts: { rotation: RotationMode; log: Logger; owned?: boolean },
): Promise<RotationLock> {
  const { log } = opts
  const owned = opts.owned ?? true
  let captured: CapturedRotation | null = null

  const get = (key: string): Promise<string> =>
    transport
      .exec(`settings get system ${key}`, { profile: 'probe' })
      .then((r) => r.stdout.trim())
      .catch(() => '')

  /** The write, with its failure REPORTED rather than swallowed: `null` on success, a reason otherwise. */
  async function put(key: string, value: string): Promise<string | null> {
    try {
      const r = await transport.exec(`settings put system ${key} ${value}`, { profile: 'probe' })
      if (r.exitCode !== null && r.exitCode !== 0) return r.stderr.trim() || `exited ${r.exitCode}`
      return null
    } catch (err) {
      return String(err)
    }
  }

  /**
   * At most once per session, and never before the first write — see
   * `RotationLock.set`'s doc comment for why a second capture would corrupt
   * the revert. Deliberately NOT gated on `owned`: a fast-path session that
   * is handed a LIVE rotation change (its wall entry having closed in the
   * meantime, so nobody else holds a capture) takes ownership of the restore
   * rather than leaving the device locked with nothing to undo it.
   */
  async function capture(): Promise<void> {
    if (captured !== null) return
    const previousAccel = await get('accelerometer_rotation')
    const previousUser = await get('user_rotation')
    const user = VALID_USER_ROTATION.has(previousUser) ? previousUser : null
    if (user === null) {
      log.warn(
        'rotation: the prior user_rotation could not be read — accelerometer_rotation will be restored on close, but a fixed orientation the device was locked to before this session will not be written back',
      )
    }
    captured = { accel: previousAccel === '0' || previousAccel === '1' ? previousAccel : '1', user }
  }

  /**
   * Write the lock and CONFIRM it, by reading both settings back. A
   * `settings put` that the platform declined is not reliably a non-zero
   * exit — some builds accept the command and drop the write — so the exit
   * code alone can never be the evidence that a lock is in force.
   */
  async function assertLock(mode: RotationMode): Promise<RotationOutcome> {
    if (mode === 'device') return { mode, target: null, applied: true }
    const target = mode === 'lock-current' ? await resolveCurrentTarget(transport, log) : FIXED_TARGET[mode]
    const problems: string[] = []
    const accelErr = await put('accelerometer_rotation', '0')
    if (accelErr) problems.push(`could not turn auto-rotate off (${accelErr})`)
    const userErr = await put('user_rotation', target)
    if (userErr) problems.push(`could not set the orientation (${userErr})`)
    const observedAccel = await get('accelerometer_rotation')
    const observedUser = await get('user_rotation')
    if (observedAccel !== '0') problems.push(`accelerometer_rotation reads back "${observedAccel || 'nothing'}", not "0"`)
    if (observedUser !== target) problems.push(`user_rotation reads back "${observedUser || 'nothing'}", not "${target}"`)
    if (problems.length === 0) return { mode, target, applied: true }
    const reason = problems.join('; ')
    // `warn`, not `debug`. The device declined something the operator asked
    // for; the whole point of surfacing this is that a lock that did not
    // happen must not look like one that did.
    log.warn(`rotation lock "${mode}" did not take on this device — ${reason}`)
    return { mode, target, applied: false, reason }
  }

  async function revert(): Promise<void> {
    const previous = captured
    if (previous === null) return
    const accelErr = await put('accelerometer_rotation', previous.accel)
    if (accelErr) log.warn(`rotation: could not restore accelerometer_rotation on close (${accelErr})`)
    if (previous.user !== null) {
      const userErr = await put('user_rotation', previous.user)
      if (userErr) log.warn(`rotation: could not restore user_rotation on close (${userErr})`)
    }
  }

  let mode: RotationMode = opts.rotation
  if (mode !== 'device' && owned) await capture()
  let outcome: RotationOutcome = mode === 'device' ? { mode, target: null, applied: true } : await assertLock(mode)

  return {
    get mode() {
      return mode
    },
    get outcome() {
      return outcome
    },
    async set(next) {
      if (next === 'device') {
        // Handing rotation back mid-session IS the revert: `'device'` means
        // "leave the device's own behaviour alone", and the device's own
        // behaviour is whatever it had before this session touched it.
        await revert()
        mode = 'device'
        outcome = { mode: 'device', target: null, applied: true }
        return outcome
      }
      await capture()
      mode = next
      outcome = await assertLock(next)
      return outcome
    },
    revert,
  }
}
