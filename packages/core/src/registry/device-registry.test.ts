import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import { defaultDeviceSettings, type DeviceSettings } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../db'
import { clusters, devices } from '../db/schema'
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
    exec: async (_serial: string, cmd: string) => replies[cmd] ?? '',
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
