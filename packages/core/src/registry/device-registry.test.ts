import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import { defaultDeviceSettings, type DeviceSettings } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../db'
import { blockedDevices, clusters, deviceEvents, devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { WsHub } from '../server/ws'
import { createLogger } from '../util/logger'
import { createDeviceRegistry, listDevicesWithTags } from './device-registry'

/**
 * A device enrolled for the first time must inherit the farm defaults.
 *
 * This used to be broken in a way no type could catch: `FarmSettings.defaults`
 * existed and was editable in Settings, but nothing ever read it, so new
 * devices silently took the DB column defaults — which did not even match.
 */

/** The minimum of AdbClient that the enrollment path touches. */
function fakeAdb(): AdbClient {
  const replies: Record<string, string> = {
    'getprop ro.serialno': 'HW-SERIAL-1',
    'settings get secure android_id': 'abcdef0123456789',
    'getprop ro.product.model': 'Pixel Test',
    'getprop ro.build.version.release': '14',
    'getprop ro.build.version.sdk': '34',
    'wm size': 'Physical size: 1080x2400',
    'wm density': 'Physical density: 420',
  }
  return {
    exec: async (_serial: string, cmd: string) => ({ stdout: replies[cmd] ?? '', stderr: '', exitCode: 0 }),
    trackDevices: () => ({ on: () => () => {}, start: async () => {}, stop: () => {} }),
  } as unknown as AdbClient
}

async function enrollOnce(deviceDefaults?: () => DeviceSettings) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const log = createLogger('test')

  type AddEvent = { kind: 'add'; serial: string; state: string }
  const listeners: Array<(ev: AddEvent) => void> = []
  const client = fakeAdb()
  ;(client as unknown as { trackDevices: () => unknown }).trackDevices = () => ({
    on: (cb: (ev: AddEvent) => void) => {
      listeners.push(cb)
      return () => {}
    },
    start: async () => {},
    stop: () => {},
  })

  const registry = createDeviceRegistry({
    client,
    db,
    hub: new WsHub(log),
    log,
    states: createDeviceStateMachine({ db, log, onChange: () => {} }),
    ...(deviceDefaults ? { deviceDefaults } : {}),
  })
  await registry.start()
  for (const cb of listeners) cb({ kind: 'add', serial: 'TESTSERIAL', state: 'device' })
  // The probe chain is async; give it a moment to land.
  await new Promise((r) => setTimeout(r, 150))
  const row = db.select().from(devices).where(eq(devices.stableId, 'HW-SERIAL-1')).get()
  await registry.stop()
  return row
}

describe('device enrollment', () => {
  test('a new device inherits the farm defaults, in both the columns and the settings JSON', async () => {
    const farmDefaults: DeviceSettings = {
      ...defaultDeviceSettings(),
      engines: {
        transport: 'adb-tcp',
        display: 'screencap-loop',
        input: 'adb-input',
        inspection: 'uiautomator-dump',
      },
      autoReconnect: false,
    }

    const row = await enrollOnce(() => farmDefaults)
    expect(row).toBeTruthy()

    // The columns the session builder reads.
    expect(row!.transport).toBe('adb-tcp')
    expect(row!.display).toBe('screencap-loop')
    expect(row!.input).toBe('adb-input')
    expect(row!.inspection).toBe('uiautomator-dump')

    // The settings JSON the device screen edits — the same values, one source.
    const settings = row!.settings as DeviceSettings
    expect(settings.engines).toEqual(farmDefaults.engines)
    expect(settings.autoReconnect).toBe(false)
    expect(settings.prep).toEqual(farmDefaults.prep)
  })

  test('without a farm defaults provider it falls back to the schema defaults', async () => {
    const row = await enrollOnce()
    const settings = row!.settings as DeviceSettings
    expect(settings).toEqual(defaultDeviceSettings())
    expect(row!.display).toBe(defaultDeviceSettings().engines.display)
  })
})

describe('registry — blocked devices (plan 47 §3.3, §4.2)', () => {
  test('a blocked stableId is never inserted, across repeated appearances AND a serial change (different USB port / adb-tcp)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    // Blocked BEFORE the device ever appears — keyed on stableId, exactly
    // what `fakeAdb()` reports for `getprop ro.serialno` regardless of which
    // transport address (serial) it is reached through.
    db.insert(blockedDevices)
      .values({ stableId: 'HW-SERIAL-1', label: 'retired phone', reason: 'decommissioned', blockedAt: new Date(), blockedBy: 'admin' })
      .run()
    const log = createLogger('test')

    type AddEvent = { kind: 'add'; serial: string; state: string }
    const listeners: Array<(ev: AddEvent) => void> = []
    const client = fakeAdb()
    ;(client as unknown as { trackDevices: () => unknown }).trackDevices = () => ({
      on: (cb: (ev: AddEvent) => void) => {
        listeners.push(cb)
        return () => {}
      },
      start: async () => {},
      stop: () => {},
    })

    const registry = createDeviceRegistry({
      client,
      db,
      hub: new WsHub(log),
      log,
      states: createDeviceStateMachine({ db, log, onChange: () => {} }),
    })
    await registry.start()
    // Same stableId, three appearances, the last two over DIFFERENT serials
    // (a different USB port, then a switch to adb-tcp) — the block must
    // survive all of it, because it is keyed on stableId, never the serial.
    for (const serial of ['TESTSERIAL', 'TESTSERIAL', '127.0.0.1:5555']) {
      for (const cb of listeners) cb({ kind: 'add', serial, state: 'device' })
      // The probe chain is async; give it a moment to land.
      await new Promise((r) => setTimeout(r, 150))
    }
    await registry.stop()

    expect(db.select().from(devices).all()).toHaveLength(0)
    // The block entry itself is untouched — still there, still explaining why.
    const stillBlocked = db.select().from(blockedDevices).where(eq(blockedDevices.stableId, 'HW-SERIAL-1')).get()
    expect(stillBlocked?.reason).toBe('decommissioned')
  })
})

describe('listDevicesWithTags — cluster (plan 22.0 §4.4, acceptance #10)', () => {
  test('DeviceInfo.cluster is populated, in one query total regardless of device count', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(clusters).values({ id: 'cl-1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    for (let i = 0; i < 30; i++) {
      db.insert(devices)
        .values({
          id: `d${i}`,
          stableId: `stable-${i}`,
          serial: `serial-${i}`,
          label: `Phone ${i}`,
          status: 'idle',
          clusterId: i < 10 ? 'cl-1' : null,
        })
        .run()
    }

    // Every drizzle bun-sqlite query goes through `client.prepare(sql)` — count
    // how many touch the clusters table (acceptance #10: one query, not N+1).
    let clusterQueries = 0
    const originalPrepare = opened.sqlite.prepare.bind(opened.sqlite) as (sql: string, params?: unknown) => unknown
    opened.sqlite.prepare = ((sql: string, params?: unknown) => {
      if (sql.includes('"clusters"')) clusterQueries++
      return originalPrepare(sql, params)
    }) as typeof opened.sqlite.prepare

    const infos = listDevicesWithTags(db)
    expect(infos).toHaveLength(30)
    const clustered = infos.filter((d) => d.cluster !== null)
    expect(clustered).toHaveLength(10)
    for (const d of clustered) expect(d.cluster).toEqual({ id: 'cl-1', name: 'Jakarta' })
    expect(infos.filter((d) => d.cluster === null)).toHaveLength(20)
    expect(clusterQueries).toBe(1)
  })
})

describe('listDevicesWithTags — lastCrashAt, the device card badge (plan 37 §4.5)', () => {
  test('a device that crashed within the last hour carries lastCrashAt; one older than an hour does not', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd-recent', stableId: 's1', serial: 'SER1', label: 'Recent', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd-old', stableId: 's2', serial: 'SER2', label: 'Old', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd-none', stableId: 's3', serial: 'SER3', label: 'None', status: 'idle' }).run()

    const nowSec = Math.floor(Date.now() / 1000)
    db.insert(deviceEvents)
      .values({
        id: 'e1',
        deviceId: 'd-recent',
        stream: 'main',
        kind: 'app.crashed',
        actor: null,
        meta: { package: 'com.example.app' },
        at: new Date((nowSec - 300) * 1000), // 5 minutes ago
      })
      .run()
    db.insert(deviceEvents)
      .values({
        id: 'e2',
        deviceId: 'd-old',
        stream: 'main',
        kind: 'app.crashed',
        actor: null,
        meta: { package: 'com.example.app' },
        at: new Date((nowSec - 7200) * 1000), // 2 hours ago
      })
      .run()

    const infos = listDevicesWithTags(db)
    const byId = new Map(infos.map((d) => [d.id, d]))
    expect(byId.get('d-recent')?.lastCrashAt).toBeGreaterThan(nowSec - 400)
    expect(byId.get('d-old')?.lastCrashAt).toBeNull()
    expect(byId.get('d-none')?.lastCrashAt).toBeNull()
  })
})
