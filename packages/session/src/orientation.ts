import { isDeviceGone } from '@enkaku/adb'
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
 * A rotation lock is a PERSISTENT device state, not a loan a session takes out and pays back
 * (owner, 2026-09-14).
 *
 * The lock used to capture `accelerometer_rotation`/`user_rotation`/the display pin when a session
 * opened and write them back when it closed. On a farm that is exactly backwards: every phone was
 * on auto-rotate before it was ever admitted, so every session close — a video reprofile, a stream
 * death, a device blip, a clean core shutdown, a Device Control linger — handed a `lock-portrait`
 * phone back to its sensor, and a phone lying on its side opened the next app in landscape. Worse,
 * a capture that ran while another session's revert was half-way through recorded a mixed state
 * (auto-rotate ON with the display pin still `enabled`) as "what the device had", and every later
 * session faithfully restored it. That is the state read off the owner's moto g06 with no job
 * running: `accelerometer_rotation=1`, `mUserRotationMode=USER_ROTATION_FREE`,
 * `mFixedToUserRotation=true`. Nothing but a revert ever writes `accelerometer_rotation 1`.
 *
 * So the rule is now one pure function, and a test holds it:
 *   - a lock mode is (re-)asserted on every event that can reach the device, and NEVER undone by
 *     one — a session closing is not a reason to change what the phone's operator configured;
 *   - `'device'` writes nothing, EXCEPT when an operator switches a device to it — that one
 *     explicit change hands rotation back (auto-rotate on, pins cleared). It is a release, not a
 *     restore: there is no captured "prior" state any more, because a farm phone's prior state is
 *     simply whatever the farm last wrote.
 */
export type RotationEvent =
  | 'session-build'
  | 'session-close'
  | 'app-launch'
  | 'setting-change'
  | 'device-online'
  | 'job-finished'
  | 'sweep'

export type RotationAction = 'lock' | 'release' | 'none'

export function rotationActionFor(mode: RotationMode, event: RotationEvent): RotationAction {
  if (event === 'session-close') return 'none'
  if (mode !== 'device') return 'lock'
  return event === 'setting-change' ? 'release' : 'none'
}

/** Whether `mode` is one of the lock modes — the only modes the farm writes on its own. */
export function isLockMode(mode: RotationMode): mode is Exclude<RotationMode, 'device'> {
  return mode !== 'device'
}

/**
 * The writes that put a lock in force, in order.
 *
 *   1. `wm user-rotation lock <rot>` — `IWindowManager.freezeDisplayRotation`, the call the Quick
 *      Settings tile itself makes (Android 12+). It sets `mUserRotationMode=LOCKED` inside
 *      WindowManager directly and writes both settings for the default display, so it is the most
 *      authoritative of the three, and on Samsung it is the path One UI's own tile takes.
 *   2. `settings put system accelerometer_rotation 0` and `user_rotation <rot>` — the same state
 *      through the settings provider, for builds older than (1) or an OEM that removed it.
 *      Redundant on a build where (1) worked; two cheap writes of identical values.
 *   3. `wm fixed-to-user-rotation enabled` (Android 10+) — makes the display follow `user_rotation`
 *      even for an activity that requests its own (sensor) orientation. YouTube opened in
 *      landscape (1600x720) on the production SM-A075F fleet with the settings lock alone.
 *
 * (1) and (3) are best effort: a build without them still holds the settings lock, which is what
 * `applied` has always meant.
 */
export function lockCommands(target: string): { display: string; settings: string[]; pin: string } {
  return {
    display: `wm user-rotation lock ${target}`,
    settings: ['settings put system accelerometer_rotation 0', `settings put system user_rotation ${target}`],
    pin: 'wm fixed-to-user-rotation enabled',
  }
}

/**
 * The writes that hand rotation back to the device's sensor — issued ONLY when an operator switches
 * a device to `'device'` (see `rotationActionFor`). `user_rotation` is left alone: with auto-rotate
 * on it is not consulted, and a made-up value would be a guess.
 */
export const RELEASE_COMMANDS: readonly string[] = [
  'wm user-rotation free',
  'settings put system accelerometer_rotation 1',
  'wm fixed-to-user-rotation default',
]

/** One shell round trip for both settings, one value per line. */
export const READBACK_COMMAND = 'settings get system accelerometer_rotation; settings get system user_rotation'

export interface RotationReadback {
  /** `''` when the line was missing or unreadable. */
  accel: string
  user: string
}

export function parseReadback(stdout: string): RotationReadback {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return { accel: lines[0] ?? '', user: lines[1] ?? '' }
}

/**
 * Whether a read-back shows the lock in force. `target` null means `'lock-current'`, which has no
 * fixed orientation to compare against: auto-rotate being off is the whole of its promise.
 */
export function lockInForce(readback: RotationReadback, target: string | null): boolean {
  if (readback.accel !== '0') return false
  return target === null || readback.user === target
}

/**
 * What an apply actually achieved, read back from the device rather than assumed from a write's
 * exit code.
 *
 * `applied` is the field that exists because the original implementation had no equivalent: every
 * `settings put` failure was swallowed into `log.debug`, so an operator who asked for a portrait
 * lock and did not get one saw nothing at all. "The thing you asked for did not occur" is not
 * debug-level information.
 */
export interface RotationOutcome {
  mode: RotationMode
  /** The `user_rotation` value written. `null` for `'device'`, which locks nothing. */
  target: string | null
  /**
   * The settings read back as the values this lock wrote (for `'device'`, as auto-rotate on after an
   * explicit release; `true` when nothing was written at all).
   */
  applied: boolean
  /** Set only when `applied` is false: which write did not take, in words an operator can act on. */
  reason?: string
  /**
   * Set by `ensureRotationLock` only: the device had drifted off the lock (auto-rotate back on, or
   * another orientation) and the lock was written again. The one outcome worth a log row even when
   * it succeeds, because something other than the farm changed the phone.
   */
  drifted?: boolean
}

/**
 * A live handle on a session's view of the lock (plan 85 §3.7). It owns nothing on the device and
 * has nothing to undo: closing the session that holds it changes nothing on the phone.
 */
export interface RotationLock {
  /** The mode this session last asserted. */
  readonly mode: RotationMode
  /** The result of the most recent apply. */
  readonly outcome: RotationOutcome
  /**
   * Re-assert `mode` now — every write, every time. For `'device'` this is the explicit release
   * (auto-rotate back on); call it with `'device'` only for an operator's change of the setting.
   */
  set(mode: RotationMode): Promise<RotationOutcome>
  /** Check first, and write only on drift (`ensureRotationLock`). A no-op for `'device'`. */
  ensure(mode: RotationMode): Promise<RotationOutcome>
}

/**
 * The device's LIVE rotation, as a `user_rotation` value — what `'lock-current'` needs, and
 * deliberately NOT `settings get system user_rotation`, which only reflects the last time the
 * device was manually locked and says nothing while auto-rotate is on.
 *
 * A ladder, because the single probe this used to be (`dumpsys input | grep SurfaceOrientation`)
 * printed nothing on all five phones of the reference farm on 2026-08-18 (a Samsung SM-A075F and
 * SM-F711B, two moto g06, an OPPO CPH2819 and CPH2173). Rungs, first answer wins:
 *   1. `mCurrentRotation=ROTATION_<deg>` from `dumpsys window displays`;
 *   2. `Viewport INTERNAL: … orientation=<0..3>` from `dumpsys input`;
 *   3. the legacy `SurfaceOrientation` line.
 *
 * `grep -m1` is deliberately not used: it closes the pipe on the first match and dumpsys dies of
 * SIGPIPE, which can surface as a non-zero exit and turn a good read into a caught failure.
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
 * A device asleep has no live surface to read — plan 85 §9 Q4 flags this as a case with no
 * inherently correct answer. The substitution below (fall back to `lock-portrait`, log it) is the
 * plan's proposal, **still UNRATIFIED**; it is kept in this one function so changing the answer
 * later is a one-line edit.
 */
async function resolveCurrentTarget(transport: Transport, log: Logger): Promise<string> {
  const reported = await readLiveRotation(transport)
  if (VALID_USER_ROTATION.has(reported)) return reported
  log.warn('rotation "lock-current" requested but the device reports no current orientation (likely asleep) — locking to portrait instead')
  return FIXED_TARGET['lock-portrait']
}

/** `wm <args>`, never throwing: `ok` is a zero exit with no `Unknown command`/error/usage text. */
async function wm(transport: Transport, args: string): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await transport.exec(`wm ${args}`, { profile: 'probe' })
    const output = `${r.stdout}${r.stderr}`.trim()
    const ok = (r.exitCode === null || r.exitCode === 0) && !/unknown|error|exception|usage:/i.test(output)
    return { ok, output }
  } catch (err) {
    return { ok: false, output: String(err) }
  }
}

/** A write, with its failure REPORTED rather than swallowed: `null` on success, a reason otherwise. */
async function put(transport: Transport, cmd: string): Promise<string | null> {
  try {
    const r = await transport.exec(cmd, { profile: 'probe' })
    if (r.exitCode !== null && r.exitCode !== 0) return r.stderr.trim() || `exited ${r.exitCode}`
    return null
  } catch (err) {
    return String(err)
  }
}

/**
 * The read-back, carrying the one distinction `ensureRotationLock` needs: a device adb no longer
 * has is not a device that drifted. Every other failure (a read that parsed to nothing, an OEM
 * build that declines it) stays `gone: false` and is still treated as drift, which is the rule this
 * file has always had.
 */
type ReadbackResult = { ok: true; value: RotationReadback } | { ok: false; gone: boolean }

async function readback(transport: Transport): Promise<ReadbackResult> {
  try {
    const r = await transport.exec(READBACK_COMMAND, { profile: 'probe' })
    return { ok: true, value: parseReadback(r.stdout) }
  } catch (err) {
    return { ok: false, gone: isDeviceGone(err) }
  }
}

/**
 * Write a lock mode and CONFIRM it by reading both settings back. A `settings put` the platform
 * declined is not reliably a non-zero exit — some builds accept the command and drop the write — so
 * the exit code alone can never be the evidence that a lock is in force.
 *
 * Idempotent and stateless: it captures nothing, so calling it on every session build, app launch,
 * device-online and sweep can never record the farm's own lock as something to put back.
 */
export async function assertRotationLock(transport: Transport, mode: Exclude<RotationMode, 'device'>, log: Logger): Promise<RotationOutcome> {
  const target = mode === 'lock-current' ? await resolveCurrentTarget(transport, log) : FIXED_TARGET[mode]
  const cmds = lockCommands(target)
  const problems: string[] = []
  // Unsupported before Android 12 (and possibly on an OEM build) — the settings writes below are the
  // floor, so this is debug-level, not a failure.
  const display = await wm(transport, cmds.display.slice('wm '.length))
  if (!display.ok) log.debug(`rotation: \`${cmds.display}\` not accepted (${display.output || 'no answer'}) — relying on the settings lock`)
  const [accelCmd, userCmd] = cmds.settings as [string, string]
  const accelErr = await put(transport, accelCmd)
  if (accelErr) problems.push(`could not turn auto-rotate off (${accelErr})`)
  const userErr = await put(transport, userCmd)
  if (userErr) problems.push(`could not set the orientation (${userErr})`)
  const pin = await wm(transport, cmds.pin.slice('wm '.length))
  if (!pin.ok) log.warn(`rotation: could not pin the display to the lock (${pin.output || 'no answer'}) — an app that requests its own orientation may still rotate`)
  const observed = await readback(transport)
  if (!observed.ok) problems.push('the settings could not be read back')
  else {
    if (observed.value.accel !== '0') problems.push(`accelerometer_rotation reads back "${observed.value.accel || 'nothing'}", not "0"`)
    if (observed.value.user !== target) problems.push(`user_rotation reads back "${observed.value.user || 'nothing'}", not "${target}"`)
  }
  if (problems.length === 0) return { mode, target, applied: true }
  const reason = problems.join('; ')
  log.warn(`rotation lock "${mode}" did not take on this device — ${reason}`)
  return { mode, target, applied: false, reason }
}

/**
 * Hand rotation back to the device's sensor. Issued ONLY for an operator's explicit switch to
 * `'device'` (`rotationActionFor(..., 'setting-change')`) — never on a session close.
 */
export async function releaseRotationLock(transport: Transport, log: Logger): Promise<RotationOutcome> {
  const [freeCmd, accelCmd, unpinCmd] = RELEASE_COMMANDS as [string, string, string]
  const free = await wm(transport, freeCmd.slice('wm '.length))
  if (!free.ok) log.debug(`rotation: \`${freeCmd}\` not accepted (${free.output || 'no answer'})`)
  const problems: string[] = []
  const accelErr = await put(transport, accelCmd)
  if (accelErr) problems.push(`could not turn auto-rotate on (${accelErr})`)
  const unpin = await wm(transport, unpinCmd.slice('wm '.length))
  if (!unpin.ok) log.warn(`rotation: could not clear the display pin (${unpin.output || 'no answer'}) — the display may stay fixed to its last orientation`)
  const observed = await readback(transport)
  if (!observed.ok) problems.push('the settings could not be read back')
  else if (observed.value.accel !== '1') problems.push(`accelerometer_rotation reads back "${observed.value.accel || 'nothing'}", not "1"`)
  if (problems.length === 0) return { mode: 'device', target: null, applied: true }
  const reason = problems.join('; ')
  log.warn(`rotation release did not take on this device — ${reason}`)
  return { mode: 'device', target: null, applied: false, reason }
}

/**
 * The cheap re-assert: one read, and the full write only when the device has drifted off the lock.
 * What device-online, job-finished and the periodic sweep use — a phone already locked costs one
 * shell round trip. A no-op for `'device'`.
 *
 * A failed read counts as drift: the write path reports its own outcome, and "could not tell" must
 * never be reported as "in force".
 *
 * ### The one failure that is NOT drift (2026-09-18)
 *
 * "adb has no such device" is not a phone that drifted, it is no phone at all — and treating it as
 * drift is expensive in exactly the moment the farm can least afford it. The write path is five
 * serialised shell calls; on a phone adb has lost, the read always fails, so every build of a
 * vanished device spent six doomed round trips here before `createSession` even reached the farm
 * tag and scrcpy. On the owner's 73-phone farm a hub-sized drop put hundreds of those on an adb
 * server that had just restarted, and the second collapse of the morning was made entirely of this
 * recovery traffic.
 *
 * So a gone device returns immediately, unapplied and with a reason, having spent one call. It is
 * still never reported as "in force" — that guarantee is untouched, and it is the reason this
 * returns `applied: false` rather than the cheaper-looking `applied: true`.
 */
export async function ensureRotationLock(transport: Transport, mode: RotationMode, log: Logger): Promise<RotationOutcome> {
  if (!isLockMode(mode)) return { mode, target: null, applied: true }
  const target = mode === 'lock-current' ? null : FIXED_TARGET[mode]
  const observed = await readback(transport)
  if (observed.ok && lockInForce(observed.value, target)) return { mode, target: target ?? observed.value.user, applied: true }
  if (!observed.ok && observed.gone) {
    return { mode, target, applied: false, reason: 'the device is not attached to this farm right now' }
  }
  const accel = observed.ok ? observed.value.accel : ''
  const user = observed.ok ? observed.value.user : ''
  log.info(`rotation: device drifted off "${mode}" (accelerometer_rotation=${accel || '?'}, user_rotation=${user || '?'}) — locking again`)
  return { ...(await assertRotationLock(transport, mode, log)), drifted: true }
}

/**
 * Screen rotation lock at session build (plan 85 §3.7, §4.1, step 85.8). Called by `createSession`
 * for EVERY build — wall and fast-path control alike: the device may have drifted since the last
 * write, and asserting the lock again cannot be wrong.
 *
 * ### Why this is `ensureRotationLock`, not `assertRotationLock` (plan 228 §3.3)
 *
 * It used to be the unconditional assert, on the reasoning that re-writing the same values "costs
 * a few shell calls". It costs **five**, serialised — `wm user-rotation lock`, two `settings put`,
 * `wm fixed-to-user-rotation`, then the read-back — and adb access is strictly serialised per
 * device (`PerDeviceQueue`), so those five are five round trips on the critical line between an
 * operator's click and the picture, on every build, reprofile, rebuild and blip. On a farm pinned
 * to `lock-portrait` it was the largest fixed prep cost after the jar push and the scrcpy handshake.
 *
 * `ensureRotationLock` is the same guarantee reached the cheap way: ONE batched read-back, and the
 * full five-call assert only when the device has actually drifted off the lock. It is the call
 * device-online, job-finished and the periodic sweep already use for exactly this reason, and it
 * treats an unreadable device as drift — so "could not tell" still writes, and is still never
 * reported as "in force".
 *
 * `'device'` writes nothing at build — the device's own behaviour is left alone. There is no
 * `revert`: see `rotationActionFor`.
 */
export async function applyRotation(transport: Transport, opts: { rotation: RotationMode; log: Logger }): Promise<RotationLock> {
  const { log } = opts
  let mode: RotationMode = opts.rotation
  let outcome: RotationOutcome = isLockMode(mode) ? await ensureRotationLock(transport, mode, log) : { mode, target: null, applied: true }

  return {
    get mode() {
      return mode
    },
    get outcome() {
      return outcome
    },
    async set(next) {
      mode = next
      outcome = isLockMode(next) ? await assertRotationLock(transport, next, log) : await releaseRotationLock(transport, log)
      return outcome
    },
    async ensure(next) {
      if (!isLockMode(next)) return { mode: next, target: null, applied: true }
      mode = next
      outcome = await ensureRotationLock(transport, next, log)
      return outcome
    },
  }
}
