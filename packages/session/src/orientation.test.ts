import { describe, expect, test } from 'bun:test'
import type { RotationMode, Transport } from '@enkaku/protocol'
import {
  applyRotation,
  ensureRotationLock,
  lockCommands,
  lockInForce,
  parseReadback,
  READBACK_COMMAND,
  RELEASE_COMMANDS,
  releaseRotationLock,
  rotationActionFor,
  type RotationEvent,
} from './orientation'
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
 * A device that actually STORES what is written to it.
 *
 * `wm user-rotation lock N` behaves like `freezeDisplayRotation` on the default display (it writes
 * both settings); `wm user-rotation free` like `thawDisplayRotation` (auto-rotate back on).
 * `declineWrite` models an OEM build that accepts a write and drops it, on either route.
 */
function fakeDevice(
  opts: {
    accel?: string
    user?: string
    currentRotationDegrees?: string
    viewportOrientation?: string
    legacySurfaceOrientation?: string
    declineWrite?: string[]
    /** Commands whose prefix matches throw instead of answering. */
    throwOn?: string
    fixed?: string
    /** No `wm fixed-to-user-rotation` (pre-Android 10, or an OEM that removed it). */
    noPin?: boolean
    /** No `wm user-rotation` (pre-Android 12). */
    noUserRotation?: boolean
  } = {},
) {
  const store: Record<string, string | undefined> = {
    accelerometer_rotation: opts.accel,
    user_rotation: opts.user,
  }
  const display = { fixed: opts.fixed ?? 'default' }
  const calls: string[] = []
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
  const write = (key: string, value: string) => {
    if (!opts.declineWrite?.includes(key)) store[key] = value
  }
  const unknown = (name: string) => ({ stdout: '', stderr: `Unknown command: ${name}`, exitCode: 255 })
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      if (opts.throwOn && cmd.startsWith(opts.throwOn)) throw new Error('boom')
      if (cmd === READBACK_COMMAND) return ok(`${store.accelerometer_rotation ?? 'null'}\n${store.user_rotation ?? 'null'}\n`)
      const put = /^settings put system (\w+) (\S+)$/.exec(cmd)
      if (put) {
        write(put[1] as string, put[2] as string)
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
      const userRotation = /^wm user-rotation (lock (\d)|free)$/.exec(cmd)
      if (userRotation) {
        if (opts.noUserRotation) return unknown('user-rotation')
        if (userRotation[2] !== undefined) {
          write('accelerometer_rotation', '0')
          write('user_rotation', userRotation[2])
        } else write('accelerometer_rotation', '1')
        return ok('')
      }
      const pin = /^wm fixed-to-user-rotation(?: (\w+))?$/.exec(cmd)
      if (pin) {
        if (opts.noPin) return unknown('fixed-to-user-rotation')
        if (pin[1] === undefined) return ok(`${display.fixed}\n`)
        display.fixed = pin[1] as string
        return ok('')
      }
      return ok('')
    },
  } as unknown as Transport
  return { transport, calls, store, display }
}

const ALL_MODES: RotationMode[] = ['device', 'lock-portrait', 'lock-landscape', 'lock-current']
const ALL_EVENTS: RotationEvent[] = ['session-build', 'session-close', 'app-launch', 'setting-change', 'device-online', 'job-finished', 'sweep']

/**
 * The rule the owner's report (2026-09-14) turned on: `lock-portrait` phones found on auto-rotate,
 * because every session close handed the lock back.
 */
describe('rotationActionFor — a lock is a persistent device state', () => {
  test('a session close NEVER writes anything, whatever the mode', () => {
    for (const mode of ALL_MODES) expect(rotationActionFor(mode, 'session-close')).toBe('none')
  })

  test('a lock mode is asserted on every other event', () => {
    for (const mode of ALL_MODES.filter((m) => m !== 'device')) {
      for (const event of ALL_EVENTS.filter((e) => e !== 'session-close')) expect(rotationActionFor(mode, event)).toBe('lock')
    }
  })

  test('"device" hands rotation back only on an explicit setting change, and is left alone otherwise', () => {
    for (const event of ALL_EVENTS) expect(rotationActionFor('device', event)).toBe(event === 'setting-change' ? 'release' : 'none')
  })
})

describe('rotation command building', () => {
  test('lockCommands: the display lock, both settings, and the pin', () => {
    expect(lockCommands('0')).toEqual({
      display: 'wm user-rotation lock 0',
      settings: ['settings put system accelerometer_rotation 0', 'settings put system user_rotation 0'],
      pin: 'wm fixed-to-user-rotation enabled',
    })
    expect(lockCommands('1').display).toBe('wm user-rotation lock 1')
    expect(lockCommands('1').settings[1]).toBe('settings put system user_rotation 1')
  })

  test('RELEASE_COMMANDS hands the sensor back and clears the pin, and never writes a guessed user_rotation', () => {
    expect(RELEASE_COMMANDS).toEqual(['wm user-rotation free', 'settings put system accelerometer_rotation 1', 'wm fixed-to-user-rotation default'])
  })

  test('parseReadback reads one value per line, tolerating blanks and a missing line', () => {
    expect(parseReadback('0\n1\n')).toEqual({ accel: '0', user: '1' })
    expect(parseReadback('\r\n1\r\n\r\n0\r\n')).toEqual({ accel: '1', user: '0' })
    expect(parseReadback('0')).toEqual({ accel: '0', user: '' })
    expect(parseReadback('')).toEqual({ accel: '', user: '' })
  })

  test('lockInForce: auto-rotate off AND the target orientation; lock-current (null) needs only auto-rotate off', () => {
    expect(lockInForce({ accel: '0', user: '0' }, '0')).toBe(true)
    expect(lockInForce({ accel: '1', user: '0' }, '0')).toBe(false)
    expect(lockInForce({ accel: '0', user: '1' }, '0')).toBe(false)
    expect(lockInForce({ accel: '0', user: '3' }, null)).toBe(true)
    expect(lockInForce({ accel: 'null', user: '0' }, null)).toBe(false)
  })
})

describe('applyRotation — asserted at session build, with nothing to revert', () => {
  test('"device" issues no commands, and the handle has no revert at all', async () => {
    const { transport, calls } = fakeDevice()
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'device', log })
    expect(calls).toEqual([])
    expect(lock.outcome).toEqual({ mode: 'device', target: null, applied: true })
    expect('revert' in lock).toBe(false)
  })

  test('"lock-portrait" on a drifted device: one drift read, then the lock, the pin, and the confirming read-back', async () => {
    const { transport, calls, display } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(calls).toEqual([
      // Plan 228 §3.3 — the drift read that decides whether the five writes
      // below are needed at all. It captures nothing: see the test after next.
      READBACK_COMMAND,
      'wm user-rotation lock 0',
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 0',
      'wm fixed-to-user-rotation enabled',
      READBACK_COMMAND,
    ])
    expect(lock.outcome).toEqual({ mode: 'lock-portrait', target: '0', applied: true, drifted: true })
    expect(display.fixed).toBe('enabled')
  })

  /**
   * The saving plan 228 §3.3 is for, and the case a farm is in almost always:
   * a device already holding the lock the farm asked for. It used to cost five
   * serialised adb round trips on EVERY build, reprofile, rebuild and blip; it
   * now costs one, and adb is serialised per device, so that is four round
   * trips off the critical line between a click and a picture.
   */
  test('a device already holding the lock costs ONE read and writes nothing (plan 228 §3.3)', async () => {
    const { transport, calls, store } = fakeDevice({ accel: '0', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(calls).toEqual([READBACK_COMMAND])
    expect(lock.outcome).toEqual({ mode: 'lock-portrait', target: '0', applied: true })
    expect(store).toEqual({ accelerometer_rotation: '0', user_rotation: '0' })
  })

  /**
   * "Could not tell" must never be reported as "in force" — an unreadable
   * device counts as drift and gets the full assert, exactly as
   * `ensureRotationLock` documents.
   */
  test('a device whose settings cannot be read is treated as drifted and written anyway', async () => {
    const { transport, calls } = fakeDevice({ accel: '0', user: '0', throwOn: READBACK_COMMAND })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(calls).toContain('settings put system accelerometer_rotation 0')
  })

  test('"lock-landscape": user_rotation 1', async () => {
    const { transport, calls, store } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log })
    expect(calls).toContain('wm user-rotation lock 1')
    expect(store).toEqual({ accelerometer_rotation: '0', user_rotation: '1' })
    expect(lock.outcome.applied).toBe(true)
  })

  // The exact state read off the owner's moto g06 with no job running: auto-rotate on, the pin left
  // enabled by a half-reverted earlier session. A build must lock it, not treat it as a prior state.
  test('the observed drifted state (accel 1, user 0, pin enabled) is locked, and nothing records it as "prior"', async () => {
    const { transport, calls, store } = fakeDevice({ accel: '1', user: '0', fixed: 'enabled' })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(store.accelerometer_rotation).toBe('0')
    /*
      The reads here are the DRIFT check and the confirming read-back, and
      neither is a capture: `ensureRotationLock`/`assertRotationLock` are
      stateless, so there is nowhere for a "prior" state to be recorded and no
      revert that could ever put one back (`rotationActionFor`). What this
      pins is that the only `settings get` issued is the batched read-back
      command — never a per-key read whose value something could keep.
    */
    expect(calls.filter((c) => c.startsWith('settings get system '))).toEqual([READBACK_COMMAND, READBACK_COMMAND])
    expect(calls[0]).toBe(READBACK_COMMAND)
    expect(calls[calls.length - 1]).toBe(READBACK_COMMAND)
    expect(calls).not.toContain('wm fixed-to-user-rotation')
  })

  test('a build without `wm user-rotation` (Android 11 and older) still locks through the settings, without a warning', async () => {
    const { transport, store } = fakeDevice({ accel: '1', user: '0', noUserRotation: true })
    const { log, warnings } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(lock.outcome.applied).toBe(true)
    expect(store.accelerometer_rotation).toBe('0')
    expect(warnings).toEqual([])
  })

  test('a build without the pin still locks — applied stays true — and says the pin did not take', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', noPin: true })
    const { log, warnings } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(lock.outcome.applied).toBe(true)
    expect(warnings.some((w) => w.includes('could not pin the display'))).toBe(true)
  })
})

describe('applyRotation — "lock-current" resolves the LIVE orientation', () => {
  test('rung 1: mCurrentRotation from dumpsys window displays, in degrees — all four rotations', async () => {
    for (const [degrees, value] of [
      ['0', '0'],
      ['90', '1'],
      ['180', '2'],
      ['270', '3'],
    ]) {
      const { transport, calls } = fakeDevice({ accel: '1', user: '0', currentRotationDegrees: degrees })
      const { log, warnings } = silentLog()
      await applyRotation(transport, { rotation: 'lock-current', log })
      expect(calls).toContain(`settings put system user_rotation ${value}`)
      expect(warnings).toEqual([])
    }
  })

  test('rung 2: the input viewport, when the window dump has no rotation line', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0', viewportOrientation: '3' })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 3')
  })

  test('rung 3: the legacy SurfaceOrientation line', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0', legacySurfaceOrientation: '2' })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 2')
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

  test('the probes never use grep -m1 — it SIGPIPEs dumpsys', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    for (const cmd of calls) expect(cmd).not.toContain('-m1')
  })
})

describe('applyRotation — a lock that does not take is REPORTED, not swallowed', () => {
  test('a write the device accepts and silently drops reads back wrong and is reported, at warn', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', declineWrite: ['user_rotation'] })
    const { log, warnings } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log })
    expect(lock.outcome.applied).toBe(false)
    expect(lock.outcome.reason).toContain('user_rotation reads back "0", not "1"')
    expect(warnings.some((w) => w.startsWith('rotation lock "lock-landscape" did not take'))).toBe(true)
  })

  test('a transport-level failure is reported the same way, and apply still completes', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', throwOn: 'settings put system user_rotation' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(lock.outcome.applied).toBe(false)
    expect(lock.outcome.reason).toContain('could not set the orientation')
  })

  test('an auto-rotate flag that will not clear is reported even when user_rotation took', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', declineWrite: ['accelerometer_rotation'] })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(lock.outcome.applied).toBe(false)
    expect(lock.outcome.reason).toContain('accelerometer_rotation reads back "1", not "0"')
  })

  test('an unreadable read-back is a failure, never an assumed success', async () => {
    const { transport } = fakeDevice({ accel: '1', user: '0', throwOn: READBACK_COMMAND })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(lock.outcome.applied).toBe(false)
    expect(lock.outcome.reason).toContain('could not be read back')
  })
})

describe('RotationLock.set / ensure — a setting change, and the cheap re-assert', () => {
  test('set re-locks a running session to the new mode', async () => {
    const { transport, store } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(await lock.set('lock-landscape')).toEqual({ mode: 'lock-landscape', target: '1', applied: true })
    expect(lock.mode).toBe('lock-landscape')
    expect(store.user_rotation).toBe('1')
  })

  test('set("device") is the explicit hand-back: auto-rotate on, pin cleared, user_rotation left alone', async () => {
    const { transport, store, display, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-landscape', log })
    calls.length = 0
    expect(await lock.set('device')).toEqual({ mode: 'device', target: null, applied: true })
    expect(calls).toEqual([...RELEASE_COMMANDS, READBACK_COMMAND])
    expect(store).toEqual({ accelerometer_rotation: '1', user_rotation: '1' })
    expect(display.fixed).toBe('default')
  })

  test('ensure on a device still locked costs exactly one read and writes nothing', async () => {
    const { transport, calls } = fakeDevice({ accel: '1', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'lock-portrait', log })
    calls.length = 0
    const outcome = await lock.ensure('lock-portrait')
    expect(calls).toEqual([READBACK_COMMAND])
    expect(outcome).toEqual({ mode: 'lock-portrait', target: '0', applied: true })
  })

  test('ensure("device") does nothing at all — only an explicit set hands rotation back', async () => {
    const { transport, calls } = fakeDevice({ accel: '0', user: '0' })
    const { log } = silentLog()
    const lock = await applyRotation(transport, { rotation: 'device', log })
    await lock.ensure('device')
    expect(calls).toEqual([])
  })
})

describe('ensureRotationLock / releaseRotationLock — the sessionless paths', () => {
  test('a device that drifted back to auto-rotate is locked again, and the outcome says it drifted', async () => {
    const { transport, store } = fakeDevice({ accel: '1', user: '0', fixed: 'enabled' })
    const { log } = silentLog()
    const outcome = await ensureRotationLock(transport, 'lock-portrait', log)
    expect(outcome).toEqual({ mode: 'lock-portrait', target: '0', applied: true, drifted: true })
    expect(store.accelerometer_rotation).toBe('0')
  })

  test('a device locked to the wrong orientation is drift too', async () => {
    const { transport, store } = fakeDevice({ accel: '0', user: '1' })
    const { log } = silentLog()
    const outcome = await ensureRotationLock(transport, 'lock-portrait', log)
    expect(outcome.drifted).toBe(true)
    expect(store.user_rotation).toBe('0')
  })

  test('lock-current: auto-rotate off is in force whatever the orientation', async () => {
    const { transport, calls } = fakeDevice({ accel: '0', user: '3' })
    const { log } = silentLog()
    const outcome = await ensureRotationLock(transport, 'lock-current', log)
    expect(calls).toEqual([READBACK_COMMAND])
    expect(outcome).toEqual({ mode: 'lock-current', target: '3', applied: true })
  })

  test('"device" issues no commands', async () => {
    const { transport, calls } = fakeDevice({ accel: '1' })
    const { log } = silentLog()
    expect(await ensureRotationLock(transport, 'device', log)).toEqual({ mode: 'device', target: null, applied: true })
    expect(calls).toEqual([])
  })

  test('a release the device refuses is reported', async () => {
    const { transport } = fakeDevice({ accel: '0', user: '0', declineWrite: ['accelerometer_rotation'] })
    const { log, warnings } = silentLog()
    const outcome = await releaseRotationLock(transport, log)
    expect(outcome.applied).toBe(false)
    expect(outcome.reason).toContain('accelerometer_rotation reads back "0", not "1"')
    expect(warnings.some((w) => w.startsWith('rotation release did not take'))).toBe(true)
  })
})
