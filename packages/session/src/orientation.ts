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

/**
 * `'lock-current'` locks whatever orientation is on screen right now. That is
 * `dumpsys input`'s `SurfaceOrientation` — the LIVE rotation — not
 * `settings get system user_rotation`, which only reflects the last time the
 * device was manually locked and says nothing while auto-rotate is on (the
 * common case, since `'device'` is today's default).
 *
 * A device asleep at session start has no live surface to read, so this
 * comes back empty — plan 85 §9 Q4 flags this as a case with no inherently
 * correct answer. The substitution below (fall back to `lock-portrait`,
 * log it) is the plan's proposal, not a ratified product decision; it is
 * kept in this one function so changing the answer later is a one-line edit.
 */
async function resolveCurrentTarget(transport: Transport, log: Logger): Promise<string> {
  const reported = await transport
    .exec('dumpsys input | grep -m1 SurfaceOrientation', { profile: 'probe' })
    .then((r) => /SurfaceOrientation:\s*(\d)/.exec(r.stdout)?.[1] ?? '')
    .catch(() => '')
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
 * Mirrors `wakeDevice`'s shape exactly: read what the device already has,
 * apply the requested lock, and hand back a revert thunk. `createSession`
 * calls this next to `wakeDevice`; `session.ts`'s `close()` calls the thunk
 * it returns.
 *
 * `'device'` is today's behaviour, unchanged: nothing is read, nothing is
 * written, and the returned revert is a no-op — there is nothing to put back.
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
 * The revert thunk is deliberately dumb: it always re-issues the exact same
 * writes it captured at apply time, no matter how many times it is called.
 * That is what makes it idempotent — a second call writes the identical
 * values the first one did (a no-op on the device), and neither call
 * consults any mutable "have I already reverted" flag.
 */
export async function applyRotation(
  transport: Transport,
  opts: { rotation: RotationMode; log: Logger },
): Promise<() => Promise<void>> {
  const { rotation, log } = opts
  if (rotation === 'device') return async () => {}

  const previousAccel = await transport
    .exec('settings get system accelerometer_rotation', { profile: 'probe' })
    .then((r) => r.stdout.trim())
    .catch(() => '')
  // Android's own default is auto-rotate ON. An unreadable value (an adb
  // hiccup, a very early boot) restores to that default rather than to
  // "locked" — the read failing is not a reason to leave the device stuck.
  const restoreAccelTo = previousAccel === '0' || previousAccel === '1' ? previousAccel : '1'

  const previousUserRotation = await transport
    .exec('settings get system user_rotation', { profile: 'probe' })
    .then((r) => r.stdout.trim())
    .catch(() => '')
  // Unlike `accelerometer_rotation` above, there is no safe guessed value to
  // fall back to here — writing a made-up fixed orientation would actively
  // rotate the device to something its owner never chose. When the prior
  // value cannot be read, `user_rotation` is simply left untouched by the
  // revert: `accelerometer_rotation` still gets restored (handing rotation
  // back to auto, or to whatever lock state the read of IT succeeded with),
  // which is the honest partial recovery rather than a confident wrong one.
  const restoreUserRotationTo = VALID_USER_ROTATION.has(previousUserRotation) ? previousUserRotation : null
  if (restoreUserRotationTo === null) {
    log.warn(
      'rotation: the prior user_rotation could not be read — accelerometer_rotation will be restored on close, but a fixed orientation the device was locked to before this session will not be written back',
    )
  }

  const target =
    rotation === 'lock-current' ? await resolveCurrentTarget(transport, log) : FIXED_TARGET[rotation]

  await transport
    .exec('settings put system accelerometer_rotation 0', { profile: 'probe' })
    .catch((err) => log.debug(`accelerometer_rotation lock failed: ${String(err)}`))
  await transport
    .exec(`settings put system user_rotation ${target}`, { profile: 'probe' })
    .catch((err) => log.debug(`user_rotation set failed: ${String(err)}`))

  return async () => {
    await transport
      .exec(`settings put system accelerometer_rotation ${restoreAccelTo}`, { profile: 'probe' })
      .catch((err) => log.debug(`accelerometer_rotation restore failed: ${String(err)}`))
    if (restoreUserRotationTo !== null) {
      await transport
        .exec(`settings put system user_rotation ${restoreUserRotationTo}`, { profile: 'probe' })
        .catch((err) => log.debug(`user_rotation restore failed: ${String(err)}`))
    }
  }
}
