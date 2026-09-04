import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import { defaultFarmSettings, type DeviceEvent } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import type { FarmSettingsStore } from '../settings/farm-settings'
import { createDeviceStateMachine } from './state-machine'
import { createDeviceHealth } from './health'
import { createLogger } from '../util/logger'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeSettingsStore(failuresBeforeQuarantine?: number): FarmSettingsStore {
  const base = defaultFarmSettings()
  const cfg = { ...base, advanced: { ...base.advanced, failuresBeforeQuarantine: failuresBeforeQuarantine ?? base.advanced.failuresBeforeQuarantine } }
  return { get: () => cfg, update: () => cfg, onChange: () => () => {} }
}

function setUp(opts?: { failuresBeforeQuarantine?: number; autoQuarantineOverride?: boolean }) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  db.insert(devices)
    .values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' })
    .run()

  const events: DeviceEvent[] = []
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const health = createDeviceHealth({
    db,
    client: () => null,
    states,
    settings: fakeSettingsStore(opts?.failuresBeforeQuarantine),
    log: createLogger('test'),
    record: (e) => events.push(e as unknown as DeviceEvent),
    ...(opts?.autoQuarantineOverride !== undefined ? { autoQuarantineOverride: opts.autoQuarantineOverride } : {}),
  })
  return { db, states, health, events }
}

describe('DeviceHealth.note — which outcomes count (plan 23 §3.6, §6.7)', () => {
  test('E_ADB_TIMEOUT counts toward the consecutive-failure streak', () => {
    const { health } = setUp({ failuresBeforeQuarantine: 3 })
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    expect(health.consecutiveFailures('d1')).toBe(1)
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    expect(health.consecutiveFailures('d1')).toBe(2)
  })

  test('E_ADB_CONNECT_TIMEOUT and E_ADB_HANDSHAKE_TIMEOUT count (they arrive as outcome "error")', () => {
    const { health } = setUp()
    health.note('SER1', 'error', 'E_ADB_CONNECT_TIMEOUT')
    expect(health.consecutiveFailures('d1')).toBe(1)
    health.note('SER1', 'error', 'E_ADB_HANDSHAKE_TIMEOUT')
    expect(health.consecutiveFailures('d1')).toBe(2)
  })

  test('E_ADB_BUSY never contributes, and does not reset the streak either', () => {
    const { health } = setUp()
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    health.note('SER1', 'busy', 'E_ADB_BUSY')
    health.note('SER1', 'busy')
    expect(health.consecutiveFailures('d1')).toBe(1) // unchanged by either busy call
  })

  test('caller-side / shell-failure codes do not count: E_ADB_FAIL, E_ADB_OUTPUT_LIMIT, E_ADB_ABORTED, E_ADB_BAD_TIMEOUT', () => {
    const { health } = setUp()
    for (const code of ['E_ADB_FAIL', 'E_ADB_OUTPUT_LIMIT', 'E_ADB_ABORTED', 'E_ADB_BAD_TIMEOUT']) {
      health.note('SER1', 'error', code)
    }
    expect(health.consecutiveFailures('d1')).toBe(0)
  })

  test('any success resets the counter to zero', () => {
    const { health } = setUp()
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    expect(health.consecutiveFailures('d1')).toBe(2)
    health.note('SER1', 'ok')
    expect(health.consecutiveFailures('d1')).toBe(0)
  })

  test('an unknown serial is a no-op (no matching device row)', () => {
    const { health } = setUp()
    expect(() => health.note('NOT-A-DEVICE', 'timeout', 'E_ADB_TIMEOUT')).not.toThrow()
    expect(health.consecutiveFailures('d1')).toBe(0)
  })
})

describe('DeviceHealth — auto-quarantine on reaching the threshold (plan 23 §3.5, §4.4, §6.4)', () => {
  test('quarantines with reason adb:unreachable after `consecutiveFailures`, and emits device.unhealthy', () => {
    const { db, health, events } = setUp({ failuresBeforeQuarantine: 3, autoQuarantineOverride: true })
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    let row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('idle') // not yet at the threshold

    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('quarantined')
    expect(row?.quarantineReason).toBe('adb:unreachable')

    const unhealthy = events.find((e) => (e as unknown as { kind: string }).kind === 'device.unhealthy')
    expect(unhealthy).toBeDefined()
  })

  test('autoQuarantine: false counts failures but never quarantines', () => {
    const { db, health } = setUp({ failuresBeforeQuarantine: 2, autoQuarantineOverride: false })
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    expect(health.consecutiveFailures('d1')).toBe(3)
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('idle')
  })

  test('a thermally quarantined device is never touched by the adb failure path (different reason prefix)', () => {
    const { db, states, health } = setUp({ failuresBeforeQuarantine: 1, autoQuarantineOverride: true })
    states.apply('d1', 'QUARANTINE')
    db.update(devices).set({ quarantineReason: 'thermal:47.0C' }).where(eq(devices.id, 'd1')).run()
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    // Already quarantined (for a different reason) → QUARANTINE is refused (not in the transition table from 'quarantined'),
    // so the reason stays exactly as the thermal path set it.
    expect(row?.quarantineReason).toBe('thermal:47.0C')
  })

  test('a refused quarantine attempt (device not in a quarantinable state) is retried on the next failure without throwing', () => {
    const { db, states, health } = setUp({ failuresBeforeQuarantine: 1, autoQuarantineOverride: true })
    states.apply('d1', 'DEVICE_DISCONNECTED') // → offline, not a legal QUARANTINE source
    expect(() => health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')).not.toThrow()
    let row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('offline')

    // Device comes back online → the next failure can now actually quarantine it.
    states.apply('d1', 'DEVICE_CONNECTED')
    health.note('SER1', 'timeout', 'E_ADB_TIMEOUT')
    row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('quarantined')
  })
})

describe('DeviceHealth — the recovery prober (plan 23 §3.5, §4.4.4, §6.5, §6.6)', () => {
  function fakeAdbClient(opts: { succeeds: boolean }): AdbClient {
    return {
      exec: async () => {
        if (!opts.succeeds) throw new Error('still unreachable')
        return 'HW-SERIAL-1'
      },
      stats: () => ({ maxConcurrent: 6, inFlight: 0, waiting: 0 }),
    } as unknown as AdbClient
  }

  test('an adb:-quarantined device is un-quarantined once it answers, and emits device.recovered', async () => {
    const { db, states, events } = setUp()
    states.apply('d1', 'QUARANTINE')
    db.update(devices).set({ quarantineReason: 'adb:unreachable' }).where(eq(devices.id, 'd1')).run()

    let succeeds = false
    const client = fakeAdbClient({ succeeds: false })
    const health = createDeviceHealth({
      db,
      client: () => (succeeds ? fakeAdbClient({ succeeds: true }) : client),
      states,
      settings: fakeSettingsStore(),
      probeIntervalSecOverride: 0.02, // 20ms — fast enough for a unit test
      log: createLogger('test'),
      record: (e) => events.push(e as unknown as DeviceEvent),
    })

    health.start()
    await sleep(40)
    let row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('quarantined') // still unreachable so far

    succeeds = true
    await sleep(40)
    row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('idle')
    expect(row?.quarantineReason).toBeNull()
    expect(events.some((e) => (e as unknown as { kind: string }).kind === 'device.recovered')).toBe(true)
    health.stop()
  })

  test('a thermally quarantined device is NOT probed and NOT auto-released (plan 23 §6.6 — existing behaviour preserved)', async () => {
    const { db, states, events } = setUp()
    states.apply('d1', 'QUARANTINE')
    db.update(devices).set({ quarantineReason: 'thermal:50.0C' }).where(eq(devices.id, 'd1')).run()

    const health = createDeviceHealth({
      db,
      client: () => fakeAdbClient({ succeeds: true }), // reachable — would recover instantly if probed
      states,
      settings: fakeSettingsStore(),
      probeIntervalSecOverride: 0.02,
      log: createLogger('test'),
      record: (e) => events.push(e as unknown as DeviceEvent),
    })

    health.start()
    await sleep(60)
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('quarantined')
    expect(row?.quarantineReason).toBe('thermal:50.0C')
    expect(events.some((e) => (e as unknown as { kind: string }).kind === 'device.recovered')).toBe(false)
    health.stop()
  })

  test('stop() prevents further probing', async () => {
    const { db, states } = setUp()
    states.apply('d1', 'QUARANTINE')
    db.update(devices).set({ quarantineReason: 'adb:unreachable' }).where(eq(devices.id, 'd1')).run()

    const health = createDeviceHealth({
      db,
      client: () => fakeAdbClient({ succeeds: true }),
      states,
      settings: fakeSettingsStore(),
      probeIntervalSecOverride: 0.02,
      log: createLogger('test'),
    })
    health.start()
    health.stop()
    await sleep(60)
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.status).toBe('quarantined') // never probed because stop() fired before any interval elapsed
  })
})
