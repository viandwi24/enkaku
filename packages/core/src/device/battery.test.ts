import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createFarmSettingsStore } from '../settings/farm-settings'
import { createDeviceStateMachine } from './state-machine'
import { createBatteryMonitor } from './battery'
import { createQuarantineGrace } from './quarantine-grace'
import { eq } from 'drizzle-orm'
import { createLogger } from '../util/logger'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function seedDevice(db: Db, id: string, serial: string, status = 'idle'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial, label: `Phone ${id}`, status }).run()
}

function dumpsysReply(level: number, tempDeciC: number): string {
  return `level: ${level}\ntemperature: ${tempDeciC}\nstatus: 2\nhealth: 2\nvoltage: 4000\nAC powered: false\nUSB powered: true`
}

describe('battery poll — bounded parallelism (plan 23 §3.4, §4.5, §6.3)', () => {
  test('a cycle over N devices, one of which is artificially slow, completes in roughly the slowest device time, not the sum', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    for (let i = 0; i < 5; i++) seedDevice(db, `d${i}`, `SER${i}`)

    const client = {
      exec: async (serial: string) => {
        // One device (SER4) is artificially slow; the rest answer almost instantly.
        await sleep(serial === 'SER4' ? 150 : 5)
        return { stdout: dumpsysReply(80, 300), stderr: '', exitCode: 0 }
      },
      stats: () => ({ maxConcurrent: 8, inFlight: 0, waiting: 0 }),
    } as unknown as AdbClient

    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const monitor = createBatteryMonitor({
      db,
      client: () => client,
      states,
      settings: createFarmSettingsStore(db),
      log: createLogger('test'),
      onBattery: () => {},
      onMetrics: () => {},
    })

    const start = Date.now()
    await monitor.pollOnce()
    const elapsed = Date.now() - start

    // Sequential (the old behaviour) would take at least 5*5 + 150 = 175ms
    // dominated by 5 sequential waits; bounded parallelism must land close to
    // the single slow device's 150ms, well under the sequential sum.
    //
    // Plan 214 §3.7, §4.3 added a second `exec` per device in the same poll
    // (the metrics probe, right after the battery read) — SER4's slow path
    // is now paid twice per device (300ms), so the margin widens with it.
    expect(elapsed).toBeLessThan(300 + 160) // generous margin for scheduler jitter
    expect(elapsed).toBeGreaterThanOrEqual(140) // must still have waited for the slow one

    // Every device's battery still got recorded — one slow device must not
    // starve the others of their result.
    const rows = db.select().from(devices).all()
    for (const row of rows) expect(row.battery).not.toBeNull()
  })

  test('one device throwing during its poll does not stop the others from being polled (existing isolation preserved)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'ok1', 'SER-OK-1')
    seedDevice(db, 'bad', 'SER-BAD')
    seedDevice(db, 'ok2', 'SER-OK-2')

    const client = {
      exec: async (serial: string) => {
        if (serial === 'SER-BAD') throw new Error('adb exploded')
        return { stdout: dumpsysReply(50, 300), stderr: '', exitCode: 0 }
      },
      stats: () => ({ maxConcurrent: 8, inFlight: 0, waiting: 0 }),
    } as unknown as AdbClient

    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const monitor = createBatteryMonitor({
      db,
      client: () => client,
      states,
      settings: createFarmSettingsStore(db),
      log: createLogger('test'),
      onBattery: () => {},
      onMetrics: () => {},
    })

    await expect(monitor.pollOnce()).resolves.toBeUndefined()
    const ok1 = db.select().from(devices).all().find((r) => r.id === 'ok1')
    expect(ok1?.battery).not.toBeNull()
    const ok2 = db.select().from(devices).all().find((r) => r.id === 'ok2')
    expect(ok2?.battery).not.toBeNull()
    const bad = db.select().from(devices).all().find((r) => r.id === 'bad')
    expect(bad?.battery).toBeNull()
  })

  test('offline devices are skipped without ever calling exec', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'on', 'SER-ON', 'idle')
    seedDevice(db, 'off', 'SER-OFF', 'offline')

    const called: string[] = []
    const client = {
      exec: async (serial: string) => {
        called.push(serial)
        return { stdout: dumpsysReply(50, 300), stderr: '', exitCode: 0 }
      },
      stats: () => ({ maxConcurrent: 8, inFlight: 0, waiting: 0 }),
    } as unknown as AdbClient

    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const monitor = createBatteryMonitor({
      db,
      client: () => client,
      states,
      settings: createFarmSettingsStore(db),
      log: createLogger('test'),
      onBattery: () => {},
      onMetrics: () => {},
    })
    await monitor.pollOnce()
    // Two calls per online device (plan 214 §3.7, §4.3): `dumpsys battery`
    // then the metrics probe, both against the same serial, in the same poll.
    expect(called).toEqual(['SER-ON', 'SER-ON'])
  })
})

describe('thermal quarantine — released on its own once the phone cools', () => {
  test('quarantined above the threshold, kept while still near it, released a margin below it', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'warm', 'SER-WARM', 'online')
    seedDevice(db, 'held', 'SER-HELD', 'online')
    db.update(devices).set({ status: 'quarantined', quarantineReason: 'adb:unreachable' }).where(eq(devices.id, 'held')).run()

    let tempDeciC = 480
    const client = {
      exec: async () => ({ stdout: dumpsysReply(80, tempDeciC), stderr: '', exitCode: 0 }),
      stats: () => ({ maxConcurrent: 8, inFlight: 0, waiting: 0 }),
    } as unknown as AdbClient
    const recorded: string[] = []
    const monitor = createBatteryMonitor({
      db,
      client: () => client,
      states: createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} }),
      settings: createFarmSettingsStore(db),
      log: createLogger('test'),
      onBattery: () => {},
      onMetrics: () => {},
      record: (ev) => void recorded.push(`${ev.deviceId}:${ev.kind}`),
    })
    const row = (id: string) => db.select().from(devices).where(eq(devices.id, id)).get()

    await monitor.pollOnce()
    expect(row('warm')?.status).toBe('quarantined')

    // 43.5 °C: under the 45 °C threshold but inside the 3 °C margin — stays out.
    tempDeciC = 435
    await monitor.pollOnce()
    expect(row('warm')?.status).toBe('quarantined')

    tempDeciC = 410
    await monitor.pollOnce()
    expect(row('warm')?.status).toBe('online')
    expect(row('warm')?.quarantineReason).toBeNull()
    expect(recorded).toContain('warm:device.recovered')
    // A quarantine for another reason is never released by the battery poll.
    expect(row('held')?.status).toBe('quarantined')
  })
})

describe('thermal quarantine — a manual release holds for the grace window', () => {
  test('a still-hot device released by hand is not re-quarantined until the window ends', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'hot', 'SER-HOT', 'online')

    const client = {
      exec: async () => ({ stdout: dumpsysReply(80, 480), stderr: '', exitCode: 0 }),
      stats: () => ({ maxConcurrent: 8, inFlight: 0, waiting: 0 }),
    } as unknown as AdbClient

    let now = 1_000_000
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const monitor = createBatteryMonitor({
      db,
      client: () => client,
      states,
      settings: createFarmSettingsStore(db),
      log: createLogger('test'),
      onBattery: () => {},
      onMetrics: () => {},
      grace: createQuarantineGrace({ graceSec: 600, now: () => now }),
    })
    const status = () => db.select().from(devices).where(eq(devices.id, 'hot')).get()?.status

    await monitor.pollOnce()
    expect(status()).toBe('quarantined')

    expect(monitor.unquarantine('hot')).toBe(true)
    await monitor.pollOnce()
    expect(status()).toBe('online')

    now += 601_000
    await monitor.pollOnce()
    expect(status()).toBe('quarantined')
  })
})

describe('manual quarantine', () => {
  function monitorFor(db: Db, recorded: string[], tempDeciC = 300) {
    const client = {
      exec: async () => ({ stdout: dumpsysReply(80, tempDeciC), stderr: '', exitCode: 0 }),
      stats: () => ({ maxConcurrent: 8, inFlight: 0, waiting: 0 }),
    } as unknown as AdbClient
    return createBatteryMonitor({
      db,
      client: () => client,
      states: createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} }),
      settings: createFarmSettingsStore(db),
      log: createLogger('test'),
      onBattery: () => {},
      onMetrics: () => {},
      record: (ev) => void recorded.push(`${ev.deviceId}:${ev.kind}`),
    })
  }

  test('an online device is pulled with the operator’s reason, and only an operator puts it back', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'pulled', 'SER-PULL', 'online')
    const recorded: string[] = []
    // 30 °C: nothing thermal is in play, so the poll below can only ever
    // release this device through the `thermal:` branch — which must not
    // match a `manual:` reason.
    const monitor = monitorFor(db, recorded)
    const row = () => db.select().from(devices).where(eq(devices.id, 'pulled')).get()

    expect(monitor.quarantine('pulled', '  battery swelling  ')).toBe(true)
    expect(row()?.status).toBe('quarantined')
    expect(row()?.quarantineReason).toBe('manual:battery swelling')
    expect(recorded).toContain('pulled:device.quarantined')

    await monitor.pollOnce()
    expect(row()?.status).toBe('quarantined')

    expect(monitor.unquarantine('pulled')).toBe(true)
    expect(row()?.status).toBe('online')
    expect(row()?.quarantineReason).toBeNull()
  })

  test('an empty reason still says something, and a device that is not online is refused', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'blank', 'SER-BLANK', 'online')
    seedDevice(db, 'gone', 'SER-GONE', 'offline')
    const monitor = monitorFor(db, [])

    expect(monitor.quarantine('blank', '   ')).toBe(true)
    expect(db.select().from(devices).where(eq(devices.id, 'blank')).get()?.quarantineReason).toBe('manual:pulled from the pool by an operator')

    // Offline, so there is no QUARANTINE transition to make — the router
    // reports this as `skipped`, not as a failure.
    expect(monitor.quarantine('gone', 'unplugged')).toBe(false)
    // And quarantining twice is the same non-transition.
    expect(monitor.quarantine('blank', 'again')).toBe(false)
  })
})
