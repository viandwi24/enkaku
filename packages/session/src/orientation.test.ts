import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { applyRotation } from './orientation'
import type { Logger } from './logger'

function silentLog(): { log: Logger; warnings: string[] } {
  const warnings: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
    child: () => log,
  }
  return { log, warnings }
}

/**
 * A device that actually STORES what is written to it, rather than replaying a
 * fixed prefix→output map.
 *
 * `applyRotation` now reads both settings back after writing them (a
 * `settings put` the platform declined is not reliably a non-zero exit), so a
 * fixture that answers every `settings get` with the same pre-write value
 * would report every apply as failed. Modelling the settings store is also
 * what makes the interesting cases expressible at all: `declineWrite` is the
 * restricted-OEM case (the write is accepted and dropped), `throwOn` is the
 * transport-level failure.
 */
function fakeDevice(
  opts: {
    /** Absent = the setting has never been set; Android prints `null` for that. */
    accel?: string
    user?: string
    /** What the rotation probes report, by rung. */
    currentRotationDegrees?: string
    viewportOrientation?: string
    legacySurfaceOrientation?: string
    /** Writes to these keys are accepted and silently dropped — the OEM-restriction shape. */
    declineWrite?: string[]
    /** Commands whose prefix matches throw instead of answering. */
    throwOn?: string
  } = {},
) {
  const store: Record<string, string | undefined> = {
    accelerometer_rotation: opts.accel,
    user_rotation: opts.user,
  }
  const calls: string[] = []
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      if (opts.throwOn && cmd.startsWith(opts.throwOn)) throw new Error('boom')
      const get = /^settings get system (\w+)$/.exec(cmd)
      if (get) return ok(store[get[1] as string] ?? 'null')
      const put = /^settings put system (\w+) (\S+)$/.exec(cmd)
      if (put) {
        const key = put[1] as string
        if (!opts.declineWrite?.includes(key)) store[key] = put[2] as string
        return ok('')
      }
      if (cmd.includes('mCurrentRotation')) {
        return ok(opts.currentRotationDegrees ? `    mCurrentRotation=ROTATION_${opts.currentRotationDegrees}\n` : '')
      }
      if (cmd.includes('Viewport INTERNAL')) {
        return ok(opts.viewportOrientation ? `  Viewport INTERNAL: displayId=0, orientation=${opts.viewportOrientation}, x=0\n` : '')
      }
      if (cmd.includes('SurfaceOrientation')) {
        return ok(opts.legacySurfaceOrientation ? `  SurfaceOrientation: ${opts.legacySurfaceOrientation}\n` : '')
      }
      return ok('')
    },
  } as unknown as Transport
  return { transport, calls, store }
}

describe('applyRotation — plan 85 §3.7, §4.1, step 85.8, acceptance #16', () => {
  test('"device" issues no commands, and its revert is a no-op', async () => {
    const { transport, calls } = fakeDevice()
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'device', log })
    expect(calls).toEqual([])
    expect(lock.outcome).toEqual({ mode: 'device', target: null, applied: true })
    await lock.revert()
    expect(calls).toEqual([])
  })

  test('"lock-portrait": reads both settings, locks accelerometer_rotation, sets user_rotation to 0, and CONFIRMS both by reading them back', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(calls).toEqual([
      'settings get system accelerometer_rotation',
      'settings get system user_rotation',
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 0',
      'settings get system accelerometer_rotation',
      'settings get system user_rotation',
    ])
    expect(lock.outcome).toEqual({ mode: 'lock-portrait', target: '0', applied: true })
  })

  test('"lock-landscape": sets user_rotation to 1', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log })
    expect(calls).toContain('settings put system user_rotation 1')
    expect(lock.outcome.applied).toBe(true)
  })
})

/**
 * The probe ladder, and the reason it is a ladder: `dumpsys input | grep
 * SurfaceOrientation` — the one and only source before this — printed nothing
 * on any of the five phones in the reference farm, so `lock-current` silently
 * behaved as `lock-portrait` on all of them.
 */
describe('applyRotation — "lock-current" resolves the LIVE orientation', () => {
  test('rung 1: mCurrentRotation from dumpsys window displays, in degrees', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0', currentRotationDegrees: '90' })
    const { log, warnings } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 1')
    expect(warnings).toEqual([])
  })

  test('rung 1 covers all four rotations', async () => {
    for (const [degrees, value] of [
      ['0', '0'],
      ['90', '1'],
      ['180', '2'],
      ['270', '3'],
    ]) {
      const { transport, calls } = fakeDevice({ accel: '1', user: '0', currentRotationDegrees: degrees })
      const { log } = silentLog()
      await applyRotation(transport, { rotation: 'lock-current', log })
      expect(calls).toContain(`settings put system user_rotation ${value}`)
    }
  })

  test('rung 2: the input viewport, when the window dump has no rotation line', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0', viewportOrientation: '3' })
    const { log, warnings } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 3')
    expect(warnings).toEqual([])
  })

  test('rung 3: the legacy SurfaceOrientation line, for a build old enough to still print it', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0', legacySurfaceOrientation: '2' })
    const { log, warnings } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 2')
    expect(warnings).toEqual([])
  })

  test('no rung answers (the device is asleep): substitutes lock-portrait and warns — still UNRATIFIED, plan 85 §9 Q4', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log, warnings } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 0')
    expect(warnings).toEqual([
      'rotation "lock-current" requested but the device reports no current orientation (likely asleep) — locking to portrait instead',
    ])
  })

  test('the probes never use grep -m1 — it SIGPIPEs dumpsys, which can surface as a failed read', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    for (const cmd of calls) expect(cmd).not.toContain('-m1')
  })
})

describe('applyRotation — revert (acceptance #16)', () => {
  test('restores BOTH accelerometer_rotation and user_rotation to exactly what was read, not the values this session applied', async () => {
    const { transport, calls } = fakeDevice({ accel: '0', user: '1' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    calls.length = 0
    await lock.revert()
    expect(calls).toEqual(['settings put system accelerometer_rotation 0', 'settings put system user_rotation 1'])
  })

  // The regression this exists to catch: a device already manually locked to
  // landscape (accelerometer_rotation=0, user_rotation=1) before the session
  // starts. §3.7's prose only mentions restoring accelerometer_rotation;
  // doing ONLY that would leave the device locked to portrait — this
  // session's lock — forever, since nothing else ever writes user_rotation
  // again. Acceptance #16 requires the device's PRIOR setting back.
  test("a device already locked to landscape is back at user_rotation=1 after close, not stuck on this session's portrait lock", async () => {
    const { transport, store } = fakeDevice({ accel: '0', user: '1' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(store.user_rotation).toBe('0')
    await lock.revert()
    expect(store).toEqual({ accelerometer_rotation: '0', user_rotation: '1' })
  })

  test('an unreadable prior accelerometer_rotation restores to auto-rotate ON (1) rather than getting stuck locked', async () => {
    const { transport, calls } = fakeDevice()
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    calls.length = 0
    await lock.revert()
    expect(calls).toEqual(['settings put system accelerometer_rotation 1'])
  })

  test('an unreadable prior user_rotation is left untouched on revert (no guessed orientation is ever written) and is logged', async () => {
    const { transport, calls } = fakeDevice({ accel: '1' })
    const { log, warnings } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(warnings).toEqual([
      'rotation: the prior user_rotation could not be read — accelerometer_rotation will be restored on close, but a fixed orientation the device was locked to before this session will not be written back',
    ])
    calls.length = 0
    await lock.revert()
    expect(calls).toEqual(['settings put system accelerometer_rotation 1'])
  })

  test('revert is idempotent: calling it twice issues the same writes twice, and is safe', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log })
    calls.length = 0
    await lock.revert()
    await lock.revert()
    expect(calls).toEqual([
      'settings put system accelerometer_rotation 1',
      'settings put system user_rotation 0',
      'settings put system accelerometer_rotation 1',
      'settings put system user_rotation 0',
    ])
  })
})

/**
 * The failure used to be swallowed into `log.debug` — an operator asked for a
 * lock, the device declined it, and nothing anywhere said so.
 */
describe('applyRotation — a lock that does not take is REPORTED, not swallowed', () => {
  test('a write the device accepts and silently drops (the restricted-OEM shape) reads back wrong and is reported, at warn', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', declineWrite: ['user_rotation'] })
    const { log, warnings } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log })
    expect(lock.outcome.applied).toBe(false)
    expect(lock.outcome.reason).toContain('user_rotation reads back "0", not "1"')
    expect(warnings.some((w) => w.startsWith('rotation lock "lock-landscape" did not take'))).toBe(true)
  })

  test('a transport-level failure is reported the same way, and apply still completes', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', throwOn: 'settings put system user_rotation' })
    const { log, warnings } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(lock.outcome.applied).toBe(false)
    expect(lock.outcome.reason).toContain('could not set the orientation')
    expect(warnings.some((w) => w.includes('did not take'))).toBe(true)
  })

  test('an auto-rotate flag that will not clear is reported even when user_rotation itself took', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', declineWrite: ['accelerometer_rotation'] })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(lock.outcome.applied).toBe(false)
    expect(lock.outcome.reason).toContain('accelerometer_rotation reads back "1", not "0"')
  })
})

/**
 * The defect the owner actually hit: the setting was apply-once, so changing
 * it while a wall tile was streaming did nothing and said nothing.
 */
describe('RotationLock.set — a mid-session change (plan 85 §3.7)', () => {
  test('re-locks a running session to the new mode', async () => {
    const { transport, store } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    const outcome = await lock.set('lock-landscape')
    expect(outcome).toEqual({ mode: 'lock-landscape', target: '1', applied: true })
    expect(lock.mode).toBe('lock-landscape')
    expect(store.user_rotation).toBe('1')
  })

  // The property `orientation.ts`'s doc comment insists on: a second apply
  // must not be able to record the FIRST apply's own values as "what the
  // device had before Enkaku touched it".
  test('does NOT re-capture: revert still restores what the device had before the FIRST apply', async () => {
    const { transport, calls, store } = fakeDevice({ accel: '1', user: '3' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    await lock.set('lock-landscape')
    await lock.set('lock-portrait')
    // Three applies, exactly one pair of capture reads.
    expect(calls.filter((c) => c === 'settings get system user_rotation').length).toBe(4) // 1 capture + 3 read-backs
    await lock.revert()
    expect(store).toEqual({ accelerometer_rotation: '1', user_rotation: '3' })
  })

  test('setting "device" mid-session hands rotation straight back to the device, and close is still safe', async () => {
    const { transport, store } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log })
    expect(store).toEqual({ accelerometer_rotation: '0', user_rotation: '1' })
    const outcome = await lock.set('device')
    expect(outcome).toEqual({ mode: 'device', target: null, applied: true })
    expect(store).toEqual({ accelerometer_rotation: '1', user_rotation: '0' })
    await lock.revert()
    expect(store).toEqual({ accelerometer_rotation: '1', user_rotation: '0' })
  })

  test('a mid-session change onto a session that started at "device" is still reverted on close — it captures on first write', async () => {
    const { transport, store } = fakeDevice({ accel: '1', user: '2' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'device', log })
    await lock.set('lock-portrait')
    expect(store).toEqual({ accelerometer_rotation: '0', user_rotation: '0' })
    await lock.revert()
    expect(store).toEqual({ accelerometer_rotation: '1', user_rotation: '2' })
  })
})

/**
 * `owned: false` is the fast-path `control` build beside an open `wall` entry
 * (plan 100 §4.2): re-assert the lock, but leave the wall entry as the sole
 * owner of the device's pre-farm state.
 */
describe('applyRotation — owned: false (the fast-path control build)', () => {
  test('re-asserts the lock without capturing, and its revert is a no-op', async () => {
    const { transport, calls, store } = fakeDevice({ accel: '0', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log, owned: false })
    expect(calls).toEqual([
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 1',
      'settings get system accelerometer_rotation',
      'settings get system user_rotation',
    ])
    expect(lock.outcome.applied).toBe(true)
    calls.length = 0
    await lock.revert()
    expect(calls).toEqual([])
    expect(store).toEqual({ accelerometer_rotation: '0', user_rotation: '1' })
  })

  test('"device" on a fast-path build still writes nothing at all', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'device', log, owned: false })
    expect(calls).toEqual([])
  })

  // Otherwise a live re-lock applied through a fast-path session whose wall
  // entry has already closed would leave the device locked with nothing to
  // undo it.
  test('a LIVE change through a fast-path lock takes ownership of the restore', async () => {
    const { transport, store } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'device', log, owned: false })
    await lock.set('lock-landscape')
    expect(store).toEqual({ accelerometer_rotation: '0', user_rotation: '1' })
    await lock.revert()
    expect(store).toEqual({ accelerometer_rotation: '1', user_rotation: '0' })
  })
})
