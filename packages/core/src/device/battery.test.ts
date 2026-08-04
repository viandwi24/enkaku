import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createFarmSettingsStore } from '../settings/farm-settings'
import { createDeviceStateMachine } from './state-machine'
import { createBatteryMonitor } from './battery'
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
    })

    const start = Date.now()
    await monitor.pollOnce()
    const elapsed = Date.now() - start

    // Sequential (the old behaviour) would take at least 5*5 + 150 = 175ms
    // dominated by 5 sequential waits; bounded parallelism must land close to
    // the single slow device's 150ms, well under the sequential sum.
    expect(elapsed).toBeLessThan(150 + 80) // generous margin for scheduler jitter
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
    })
    await monitor.pollOnce()
    expect(called).toEqual(['SER-ON'])
  })
})
