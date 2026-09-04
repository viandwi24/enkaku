import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { defaultDeviceSettings, type Transport } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { admitDevice, recordSighting } from '../registry/admission'
import { createAwakePolicy, type AwakePolicyDeps } from './awake-policy'
import type { Logger } from '../util/logger'

/**
 * The awake policy, host side (plan 125 §4.1, §5 step 125.1).
 *
 * These tests exist because of plan 125 §0.2, not because the module needs
 * coverage. The owner's phones are sealed in a phone-farm box: the recovery
 * cost of a bad device write is hardware disassembly. So the four properties
 * the box demands are asserted here against a device fake that behaves like a
 * real ROM (a write changes what the next read returns, and a refused write
 * does not):
 *
 * 1. A write that does not read back is `refused`, and is NEVER counted as
 *    applied (acceptance criterion 4).
 * 2. `capture` never overwrites — losing the pre-Enkaku state is
 *    unrecoverable without opening the box.
 * 3. `restore` puts back exactly what `capture` read, and does it identically
 *    on the tenth call as on the first (acceptance criterion 3).
 * 4. `observe` answers `unknown`, never `off`, when the probe could not run
 *    (acceptance criterion 5) — the whole point of §0.3.
 */

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
} as unknown as Logger

const GET_TIMEOUT = 'settings get system screen_off_timeout'
const GET_STAYON = 'settings get global stay_on_while_plugged_in'

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function admit(db: Db, stableId: string): DeviceRow {
  recordSighting(db, { stableId, serial: `serial-${stableId}`, label: `Pixel ${stableId}`, androidVersion: '15' })
  const row = admitDevice(db, stableId)
  if (!row) throw new Error('admitDevice returned null in test setup')
  db.update(devices).set({ status: 'online', settings: defaultDeviceSettings() }).where(eq(devices.id, row.id)).run()
  return db.select().from(devices).where(eq(devices.id, row.id)).get()!
}

/**
 * A device fake with real state: `settings put` and `svc power stayon` change
 * what the next `settings get` returns, unless the key is listed in `refuse` —
 * the ROM behaviour that acceptance criterion 4 exists for.
 */
function fakeDevice(initial: { timeout?: string; stayOn?: string; wakefulness?: string; refuse?: Array<'timeout' | 'stayOn'>; failProbe?: boolean } = {}) {
  const state = { timeout: initial.timeout ?? '60000', stayOn: initial.stayOn ?? '0' }
  const refuse = new Set(initial.refuse ?? [])
  const calls: string[] = []
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    exec: async (cmd: string) => {
      calls.push(cmd)
      if (cmd.startsWith(GET_TIMEOUT)) return { stdout: state.timeout, stderr: '', exitCode: 0 }
      if (cmd.startsWith(GET_STAYON)) return { stdout: state.stayOn, stderr: '', exitCode: 0 }
      if (cmd.startsWith('settings put system screen_off_timeout')) {
        // `shellQuote`d on the wire; a real device shell strips the quotes.
        if (!refuse.has('timeout')) state.timeout = (cmd.split(' ').pop() ?? '').replace(/'/g, '') || state.timeout
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('settings put global stay_on_while_plugged_in')) {
        if (!refuse.has('stayOn')) state.stayOn = (cmd.split(' ').pop() ?? '').replace(/'/g, '') || state.stayOn
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('svc power stayon')) {
        const token = cmd.split(' ').pop()
        if (!refuse.has('stayOn')) state.stayOn = token === 'true' ? '7' : token === 'usb' ? '2' : '0'
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('dumpsys power')) {
        if (initial.failProbe) throw new Error('adb: device offline')
        return { stdout: `  mWakefulness=${initial.wakefulness ?? 'Awake'}`, stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  } as unknown as Transport
  return { transport, calls, state }
}

function makeDeps(db: Db, transport: Transport | null, extra: Partial<AwakePolicyDeps> = {}): AwakePolicyDeps {
  return { db, client: () => null, log: silentLog, buildTransport: () => transport, now: () => 1_700_000_000_000, ...extra }
}

function storedCapture(db: Db, id: string): unknown {
  return db.select().from(devices).where(eq(devices.id, id)).get()?.powerCapture ?? null
}

describe('awake policy — capture (plan 125 §3.3, §0.2)', () => {
  test('captures the device’s own values and persists them', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport } = fakeDevice({ timeout: '30000', stayOn: '2' })
    const policy = createAwakePolicy(makeDeps(db, transport))

    const captured = await policy.capture(row.id)
    expect(captured.screenOffTimeoutMs).toBe(30000)
    expect(captured.stayOnWhilePluggedIn).toBe('2')
    expect(captured.capturedAt).toBe(1_700_000_000)
    expect(storedCapture(db, row.id)).toEqual({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '2', capturedAt: 1_700_000_000 })
  })

  test('NEVER overwrites an existing capture — a second call returns the stored one and touches no device', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const first = fakeDevice({ timeout: '30000', stayOn: '2' })
    await createAwakePolicy(makeDeps(db, first.transport)).capture(row.id)

    // The device has since been written to (this is what a wake does). A
    // second capture must NOT record our own writes as its originals — that
    // would destroy the only copy of the truth, unrecoverably on a boxed phone.
    const second = fakeDevice({ timeout: '1800000', stayOn: '7' })
    const again = await createAwakePolicy(makeDeps(db, second.transport)).capture(row.id)
    expect(again).toEqual({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '2', capturedAt: 1_700_000_000 })
    expect(second.calls).toEqual([])
  })

  test('a capture where NEITHER value could be read is not stored, so a real one stays possible', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport } = fakeDevice({ timeout: 'null', stayOn: 'null' })
    const policy = createAwakePolicy(makeDeps(db, transport))

    const captured = await policy.capture(row.id)
    expect(captured.screenOffTimeoutMs).toBeNull()
    expect(captured.stayOnWhilePluggedIn).toBeNull()
    expect(storedCapture(db, row.id)).toBeNull()

    // The device answers this time, and the capture lands.
    const good = fakeDevice({ timeout: '30000', stayOn: '2' })
    await createAwakePolicy(makeDeps(db, good.transport)).capture(row.id)
    expect(storedCapture(db, row.id)).toEqual({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '2', capturedAt: 1_700_000_000 })
  })

  test('an offline device is not probed, and nothing is stored', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, row.id)).run()
    const { transport, calls } = fakeDevice()
    await createAwakePolicy(makeDeps(db, transport)).capture(row.id)
    expect(calls).toEqual([])
    expect(storedCapture(db, row.id)).toBeNull()
  })
})

describe('awake policy — apply (plan 125 §3.3, acceptance criterion 4)', () => {
  test('writes both settings, verifies both by read-back, and captures first', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport, state } = fakeDevice({ timeout: '60000', stayOn: '0' })
    const result = await createAwakePolicy(makeDeps(db, transport)).apply(row.id, 'always')

    expect(result).toEqual({ screenOffTimeout: 'applied', stayOn: 'applied', reason: null })
    expect(state.timeout).toBe('1800000')
    expect(state.stayOn).toBe('7')
    // Captured what the device HAD, not what we just wrote.
    expect(storedCapture(db, row.id)).toEqual({ screenOffTimeoutMs: 60000, stayOnWhilePluggedIn: '0', capturedAt: 1_700_000_000 })
  })

  test('a screen-timeout write the device ignores is `refused` with a reason, and never `applied`', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport, state } = fakeDevice({ timeout: '60000', refuse: ['timeout'] })
    const result = await createAwakePolicy(makeDeps(db, transport)).apply(row.id, 'always')

    expect(result.screenOffTimeout).toBe('refused')
    expect(result.reason).toContain('did not accept')
    expect(state.timeout).toBe('60000')
    // The other half still took — the two settings fail independently, which
    // is exactly why `AwakeApplyResult` is not a single boolean.
    expect(result.stayOn).toBe('applied')
  })

  test('a stayon write the device ignores is `refused`, and never `applied`', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport } = fakeDevice({ stayOn: '0', refuse: ['stayOn'] })
    const result = await createAwakePolicy(makeDeps(db, transport)).apply(row.id, 'always')
    expect(result.stayOn).toBe('refused')
    expect(result.reason).toContain('did not accept')
  })

  test('a device already holding both values issues no writes at all', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport, calls } = fakeDevice({ timeout: '1800000', stayOn: '7' })
    const result = await createAwakePolicy(makeDeps(db, transport)).apply(row.id, 'always')
    expect(result).toEqual({ screenOffTimeout: 'unchanged', stayOn: 'unchanged', reason: null })
    // Two reads, nothing else — no `svc power stayon`, plan 96 §22's 1422 ms.
    expect(calls).toEqual([GET_TIMEOUT, GET_STAYON])
  })

  /**
   * Plan 212 §4.1 D18 turned `prep.screenOffTimeoutMs` into the constant
   * `DEVICE_SCREEN_OFF_TIMEOUT_MS`, so a device can no longer opt out of the
   * write — the test that covered `null` covers a capability that is gone.
   * What replaces it guards the failure that removal invites: a settings key
   * put back by hand, stored and rendered and never read, which is the exact
   * class the rotation and video overrides were both caught on.
   */
  test('`prep` carries no per-device screen-timeout key — a stored one would be written, rendered, and never read', () => {
    const settings = defaultDeviceSettings()
    expect(Object.keys(settings.prep)).not.toContain('screenOffTimeoutMs')
  })

  test('an offline device is `refused` on both, and nothing is written', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, row.id)).run()
    const { transport, calls } = fakeDevice()
    const result = await createAwakePolicy(makeDeps(db, transport)).apply(row.id, 'always')
    expect(result).toEqual({ screenOffTimeout: 'refused', stayOn: 'refused', reason: 'the device is offline' })
    expect(calls).toEqual([])
  })
})

describe('awake policy — restore (plan 125 acceptance criterion 3, §0.2 rule 2)', () => {
  test('puts back EXACTLY what capture read, over adb alone', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    // A device that shipped with an unusual value `svc power stayon` has no
    // token for (AC only) — the reason `restore` uses `settings put`.
    const device = fakeDevice({ timeout: '30000', stayOn: '1' })
    const policy = createAwakePolicy(makeDeps(db, device.transport))

    await policy.apply(row.id, 'always')
    expect(device.state).toEqual({ timeout: '1800000', stayOn: '7' })

    const result = await policy.restore(row.id)
    expect(result).toEqual({ screenOffTimeout: 'applied', stayOn: 'applied', reason: null })
    expect(device.state).toEqual({ timeout: '30000', stayOn: '1' })
  })

  test('is idempotent — the second and tenth calls report `unchanged` and leave the device where it is', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const device = fakeDevice({ timeout: '30000', stayOn: '1' })
    const policy = createAwakePolicy(makeDeps(db, device.transport))
    await policy.apply(row.id, 'always')
    await policy.restore(row.id)

    for (let i = 0; i < 9; i++) {
      const again = await policy.restore(row.id)
      expect(again).toEqual({ screenOffTimeout: 'unchanged', stayOn: 'unchanged', reason: null })
      expect(device.state).toEqual({ timeout: '30000', stayOn: '1' })
    }
    // The capture is deliberately NOT cleared by a restore — a later wake must
    // not re-capture OUR restored values as the device's originals.
    expect(storedCapture(db, row.id)).toEqual({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '1', capturedAt: 1_700_000_000 })
  })

  test('with nothing ever captured it writes nothing and says so — it does not guess', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport, calls } = fakeDevice()
    const result = await createAwakePolicy(makeDeps(db, transport)).restore(row.id)
    expect(result.screenOffTimeout).toBe('unchanged')
    expect(result.stayOn).toBe('unchanged')
    expect(result.reason).toContain('never captured')
    expect(calls).toEqual([])
  })

  test('a restore the device ignores is `refused`, never `applied`', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const good = fakeDevice({ timeout: '30000', stayOn: '1' })
    const policy = createAwakePolicy(makeDeps(db, good.transport))
    await policy.capture(row.id)

    const stubborn = fakeDevice({ timeout: '1800000', stayOn: '7', refuse: ['timeout', 'stayOn'] })
    const result = await createAwakePolicy(makeDeps(db, stubborn.transport)).restore(row.id)
    expect(result.screenOffTimeout).toBe('refused')
    expect(result.stayOn).toBe('refused')
  })
})

describe('awake policy — observe (plan 125 §3.6, acceptance criterion 5)', () => {
  test('reports `on` for a lit panel', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport } = fakeDevice({ wakefulness: 'Awake' })
    const observed = await createAwakePolicy(makeDeps(db, transport)).observe(row.id)
    expect(observed.state).toBe('on')
    expect(observed.observedAt).toBe(1_700_000_000)
  })

  test('reports `off` for a genuinely asleep panel', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport } = fakeDevice({ wakefulness: 'Asleep' })
    expect((await createAwakePolicy(makeDeps(db, transport)).observe(row.id)).state).toBe('off')
  })

  test('a probe that FAILS is `unknown`, never `off`', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const { transport } = fakeDevice({ failProbe: true })
    const observed = await createAwakePolicy(makeDeps(db, transport)).observe(row.id)
    expect(observed.state).toBe('unknown')
    expect(observed.reason).toContain('could not run')
  })

  test('an offline device is `unknown`, never `off` — "we could not ask" is not "the panel is dark"', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, row.id)).run()
    const { transport } = fakeDevice()
    expect((await createAwakePolicy(makeDeps(db, transport)).observe(row.id)).state).toBe('unknown')
  })

  test('adb not being up yet is `unknown`, never `off`', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const observed = await createAwakePolicy(makeDeps(db, null)).observe(row.id)
    expect(observed.state).toBe('unknown')
    expect(observed.reason).toBe('adb is not ready yet')
  })

  test('an unknown device id is `unknown`, never `off` — and never throws', async () => {
    const db = setUpDb()
    const observed = await createAwakePolicy(makeDeps(db, null)).observe('nope')
    expect(observed.state).toBe('unknown')
  })
})

describe('awake policy — the wakeDevice capture sink (plan 125 §5 step 125.2)', () => {
  test('stores the state wakeDevice already read, and never overwrites', () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    const policy = createAwakePolicy(makeDeps(db, null))
    const sink = policy.captureSink(row.id)

    sink({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '2' })
    expect(storedCapture(db, row.id)).toEqual({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '2', capturedAt: 1_700_000_000 })

    sink({ screenOffTimeoutMs: 1800000, stayOnWhilePluggedIn: '7' })
    expect(storedCapture(db, row.id)).toEqual({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '2', capturedAt: 1_700_000_000 })
  })

  test('an unknown device never throws into the wake — a dark phone is the worse outcome', () => {
    const db = setUpDb()
    const policy = createAwakePolicy(makeDeps(db, null))
    expect(() => policy.captureSink('nope')({ screenOffTimeoutMs: 1, stayOnWhilePluggedIn: '0' })).not.toThrow()
  })
})

describe('awake policy — a corrupt stored capture', () => {
  test('reads as never-captured rather than throwing, and a real capture replaces it', async () => {
    const db = setUpDb()
    const row = admit(db, 'a')
    db.update(devices).set({ powerCapture: { screenOffTimeoutMs: 'thirty seconds' } }).where(eq(devices.id, row.id)).run()
    const { transport } = fakeDevice({ timeout: '30000', stayOn: '2' })
    const captured = await createAwakePolicy(makeDeps(db, transport)).capture(row.id)
    expect(captured.screenOffTimeoutMs).toBe(30000)
    expect(storedCapture(db, row.id)).toEqual({ screenOffTimeoutMs: 30000, stayOnWhilePluggedIn: '2', capturedAt: 1_700_000_000 })
  })
})
