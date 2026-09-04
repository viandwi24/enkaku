import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import { defaultDeviceSettings, type DeviceSettings } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../db'
import { blockedDevices, groups, deviceEvents, devices, discoveredDevices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { WsHub } from '../server/ws'
import { createLogger } from '../util/logger'
import { admitDevice } from './admission'
import { createDeviceRegistry, deriveAgentState, deriveConnection, listDevicesWithTags, rowToDeviceInfo, type FarmNetwork } from './device-registry'
import { allocateDeviceNumber, lookupDeviceNumber } from './device-number'
import type { EndpointStore } from './endpoints'

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

async function enrollOnce() {
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
  })
  await registry.start()
  for (const cb of listeners) cb({ kind: 'add', serial: 'TESTSERIAL', state: 'device' })
  // The probe chain is async; give it a moment to land.
  await new Promise((r) => setTimeout(r, 150))

  // Plan 56: connecting no longer enrols. The device waits in the tray, and
  // the farm defaults are applied at the moment an operator admits it — which
  // is the moment this helper is really about.
  expect(db.select().from(devices).where(eq(devices.stableId, 'HW-SERIAL-1')).get()).toBeUndefined()
  const row = admitDevice(db, 'HW-SERIAL-1')
  await registry.stop()
  return row
}

describe('device enrollment', () => {
  /**
   * Plan 212 §4.1, §3.3 decision 3: `FarmSettingsSchema.defaults` is gone —
   * there is no more farm-wide device-defaults accessor anywhere in this
   * path. A new device always starts from `defaultDeviceSettings()`, with a
   * fresh, empty identity (docs/settings-audit.md #1's original concern:
   * identity must never be a farm-wide, centrally-set value).
   */
  test('a new device gets the schema defaults, in both the columns and the settings JSON, with a fresh empty identity', async () => {
    const row = await enrollOnce()
    const settings = row!.settings as DeviceSettings
    expect(settings).toEqual(defaultDeviceSettings())
    expect(row!.display).toBe(defaultDeviceSettings().engines.display)
    expect(settings.identity).toEqual({})
    expect(settings.identity).not.toBeUndefined()
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

describe('listDevicesWithTags — group (plan 22.0 §4.4, acceptance #10)', () => {
  test('DeviceInfo.group is populated, in one query total regardless of device count', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(groups).values({ id: 'cl-1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    for (let i = 0; i < 30; i++) {
      db.insert(devices)
        .values({
          id: `d${i}`,
          stableId: `stable-${i}`,
          serial: `serial-${i}`,
          label: `Phone ${i}`,
          status: 'online',
          groupId: i < 10 ? 'cl-1' : null,
        })
        .run()
    }

    // Every drizzle bun-sqlite query goes through `client.prepare(sql)` — count
    // how many touch the groups table (acceptance #10: one query, not N+1).
    let groupQueries = 0
    const originalPrepare = opened.sqlite.prepare.bind(opened.sqlite) as (sql: string, params?: unknown) => unknown
    opened.sqlite.prepare = ((sql: string, params?: unknown) => {
      if (sql.includes('"groups"')) groupQueries++
      return originalPrepare(sql, params)
    }) as typeof opened.sqlite.prepare

    const infos = listDevicesWithTags(db)
    expect(infos).toHaveLength(30)
    const grouped = infos.filter((d) => d.group !== null)
    expect(grouped).toHaveLength(10)
    for (const d of grouped) expect(d.group).toEqual({ id: 'cl-1', name: 'Jakarta' })
    expect(infos.filter((d) => d.group === null)).toHaveLength(20)
    expect(groupQueries).toBe(1)
  })
})

describe('probe-retry backoff (plan 85 §3.3 point 7, §5 step 85.2, fixes F9)', () => {
  type AddEvent = { kind: 'add'; serial: string; state: string }
  type RemoveEvent = { kind: 'remove'; serial: string }

  /** A device that never answers adb — every `exec` rejects, so `probeDeviceIdentity` always throws. */
  function fakeAdbAlwaysFails(): { client: AdbClient; listeners: Array<(ev: AddEvent | RemoveEvent) => void> } {
    const listeners: Array<(ev: AddEvent | RemoveEvent) => void> = []
    const client = {
      exec: async () => {
        throw new Error('device not responding')
      },
      trackDevices: () => ({
        on: (cb: (ev: AddEvent | RemoveEvent) => void) => {
          listeners.push(cb)
          return () => {}
        },
        start: async () => {},
        stop: () => {},
      }),
    } as unknown as AdbClient
    return { client, listeners }
  }

  test('a probe that keeps failing schedules a backoff retry — pendingRetryCount() becomes 1', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const { client, listeners } = fakeAdbAlwaysFails()

    const registry = createDeviceRegistry({ client, db, hub: new WsHub(log), log, states: createDeviceStateMachine({ db, log, onChange: () => {} }) })
    await registry.start()
    expect(registry.pendingRetryCount()).toBe(0)

    for (const cb of listeners) cb({ kind: 'add', serial: 'FAILING-SERIAL', state: 'device' })
    // The existing inner "retry once after 1s" (unchanged by this plan) runs
    // before the OUTER catch — that inner sleep is a real 1000ms, so this
    // has to wait past it to observe the backoff getting scheduled.
    await new Promise((r) => setTimeout(r, 1200))

    expect(registry.pendingRetryCount()).toBe(1)
    expect(db.select().from(devices).all()).toHaveLength(0) // never successfully enrolled — it never answered
    await registry.stop()
    // stop() clears every pending timer (00-overview §7) — verified by the
    // absence of a "next tick" firing after this point (no assertion needed
    // here beyond the call not throwing; a leaked timer would keep the test
    // process alive, which `bun test`'s own runner would catch).
  }, 10_000)

  test('the retry is cancelled when the device disappears', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const { client, listeners } = fakeAdbAlwaysFails()

    const registry = createDeviceRegistry({ client, db, hub: new WsHub(log), log, states: createDeviceStateMachine({ db, log, onChange: () => {} }) })
    await registry.start()

    for (const cb of listeners) cb({ kind: 'add', serial: 'FAILING-SERIAL', state: 'device' })
    await new Promise((r) => setTimeout(r, 1200))
    expect(registry.pendingRetryCount()).toBe(1)

    for (const cb of listeners) cb({ kind: 'remove', serial: 'FAILING-SERIAL' })
    expect(registry.pendingRetryCount()).toBe(0)

    await registry.stop()
  }, 10_000)
})

describe('listDevicesWithTags — lastCrashAt, the device card badge (plan 37 §4.5)', () => {
  test('a device that crashed within the last hour carries lastCrashAt; one older than an hour does not', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd-recent', stableId: 's1', serial: 'SER1', label: 'Recent', status: 'online' }).run()
    db.insert(devices).values({ id: 'd-old', stableId: 's2', serial: 'SER2', label: 'Old', status: 'online' }).run()
    db.insert(devices).values({ id: 'd-none', stableId: 's3', serial: 'SER3', label: 'None', status: 'online' }).run()

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

/**
 * `deriveConnection` (plan 88 §3.1, §4.1, §5 step 88.1) — the ONE place
 * `kind`/`medium` are computed. `kind` is purely observational (adb's own
 * serial shape); `medium` is inferred ONLY from a configured farm network,
 * never guessed, which is why a `tcp` serial with no matching network stays
 * `mediumSource: 'unknown'` rather than defaulting to WI-FI — the exact
 * mistake `packages/drivers/src/descriptors.ts`'s old `adb-tcp` display name
 * made (F3).
 */
describe('deriveConnection (plan 88 §3.1, §4.1)', () => {
  test('a USB serial (no colon) reads kind: usb with everything else null/unknown', () => {
    expect(deriveConnection('ZP2222RMBS', [])).toEqual({
      kind: 'usb',
      medium: null,
      mediumSource: 'unknown',
      address: null,
      port: null,
      networkLabel: null,
    })
  })

  test('a 16-hex USB serial also reads usb — no colon, no guess', () => {
    expect(deriveConnection('0123456789ABCDEF', []).kind).toBe('usb')
  })

  test('a host:port serial with no configured networks reads tcp with mediumSource unknown, never a guessed WI-FI', () => {
    expect(deriveConnection('10.20.0.37:5555', [])).toEqual({
      kind: 'tcp',
      medium: null,
      mediumSource: 'unknown',
      address: '10.20.0.37',
      port: 5555,
      networkLabel: null,
    })
  })

  test('a host:port serial matching a configured wired network reads medium: wired, mediumSource: network, with the label', () => {
    const networks: FarmNetwork[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]
    expect(deriveConnection('10.20.0.37:5555', networks)).toEqual({
      kind: 'tcp',
      medium: 'wired',
      mediumSource: 'network',
      address: '10.20.0.37',
      port: 5555,
      networkLabel: 'Chassis A',
    })
  })

  test('a host:port serial matching a configured wireless network reads medium: wireless', () => {
    const networks: FarmNetwork[] = [{ cidr: '192.168.1.0/24', label: 'Office Wi-Fi', medium: 'wireless', scan: false }]
    expect(deriveConnection('192.168.1.51:5555', networks).medium).toBe('wireless')
  })

  test('an address outside every configured network stays mediumSource: unknown', () => {
    const networks: FarmNetwork[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]
    const c = deriveConnection('192.168.1.51:5555', networks)
    expect(c.mediumSource).toBe('unknown')
    expect(c.medium).toBeNull()
  })

  test('the first matching network wins when configured ranges overlap', () => {
    const networks: FarmNetwork[] = [
      { cidr: '10.20.0.0/16', label: 'Wide', medium: 'wireless', scan: false },
      { cidr: '10.20.0.0/24', label: 'Narrow', medium: 'wired', scan: true },
    ]
    expect(deriveConnection('10.20.0.37:5555', networks).networkLabel).toBe('Wide')
  })

  test('a malformed CIDR is skipped rather than throwing', () => {
    const networks: FarmNetwork[] = [{ cidr: 'not-a-cidr', label: 'Bad', medium: 'wired', scan: true }]
    expect(() => deriveConnection('10.20.0.37:5555', networks)).not.toThrow()
    expect(deriveConnection('10.20.0.37:5555', networks).mediumSource).toBe('unknown')
  })

  test('a bracketed IPv6 host parses its address but never matches an IPv4-only network', () => {
    const networks: FarmNetwork[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]
    expect(deriveConnection('[::1]:5555', networks)).toEqual({
      kind: 'tcp',
      medium: null,
      mediumSource: 'unknown',
      address: '::1',
      port: 5555,
      networkLabel: null,
    })
  })
})

describe('rowToDeviceInfo / listDevicesWithTags — connection (plan 88 §3.1, §4.1)', () => {
  test('GET-style listing returns a connection object for every device: usb stays usb, a tcp address inside the configured network reads OTG-eligible, one outside it stays TCP-unknown', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd-usb', stableId: 's-usb', serial: 'ZP2222RMBS', label: 'USB phone', status: 'online' }).run()
    db.insert(devices).values({ id: 'd-tcp-known', stableId: 's-tcp-known', serial: '10.20.0.37:5555', label: 'Chassis phone', status: 'online' }).run()
    db.insert(devices).values({ id: 'd-tcp-unknown', stableId: 's-tcp-unknown', serial: '192.168.1.51:5555', label: 'Mystery phone', status: 'online' }).run()

    const networks: FarmNetwork[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]
    const infos = listDevicesWithTags(db, undefined, undefined, networks)
    const byId = new Map(infos.map((d) => [d.id, d]))

    expect(byId.get('d-usb')?.connection).toEqual({
      kind: 'usb',
      medium: null,
      mediumSource: 'unknown',
      address: null,
      port: null,
      networkLabel: null,
    })
    expect(byId.get('d-tcp-known')?.connection).toEqual({
      kind: 'tcp',
      medium: 'wired',
      mediumSource: 'network',
      address: '10.20.0.37',
      port: 5555,
      networkLabel: 'Chassis A',
    })
    expect(byId.get('d-tcp-unknown')?.connection).toEqual({
      kind: 'tcp',
      medium: null,
      mediumSource: 'unknown',
      address: '192.168.1.51',
      port: 5555,
      networkLabel: null,
    })
  })

  test('omitting networks entirely still parses (defaulted to [], every existing call site keeps working)', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: '10.20.0.37:5555', label: 'Phone', status: 'online' }).run()
    const infos = listDevicesWithTags(db)
    expect(infos[0]?.connection.kind).toBe('tcp')
    expect(infos[0]?.connection.mediumSource).toBe('unknown')
  })

  test('rowToDeviceInfo called directly (no networks arg) also defaults connection to usb/unknown for a usb serial', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ZP2222RMBS', label: 'Phone', status: 'online' }).run()
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    const info = rowToDeviceInfo(row)
    expect(info.connection.kind).toBe('usb')
  })
})

describe('deriveAgentState / DeviceInfo.agent (plan 106 §5 step 106.5)', () => {
  test('reads devices.preparation[guest-agent] — the authoritative store since 106.5 — not devices.agent', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices)
      .values({
        id: 'd1',
        stableId: 's1',
        serial: 'ZP2222RMBS',
        label: 'Phone',
        status: 'online',
        preparation: { 'guest-agent': { state: 'outdated', version: '1.2.0', reason: 'update available', checkedAt: 1, attempts: 0, nextAttemptAt: null } },
        // A stale/absent devices.agent must not win — preparation is authoritative.
        agent: { appVersion: '1.2.0', versionCode: 3, androidSdkInt: 30, capabilities: [] },
      })
      .run()
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(deriveAgentState(row)).toBe('outdated')
    expect(rowToDeviceInfo(row).agent).toBe('outdated')
  })

  test('a pre-106.5 row (legacy devices.agent, no preparation entry) still reports its real state — a known-failed phone never reads as healthy', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices)
      .values({
        id: 'd1',
        stableId: 's1',
        serial: 'ZP2222RMBS',
        label: 'Phone',
        status: 'online',
        agent: { state: 'failed', appVersion: null, versionCode: null, androidSdkInt: 30, capabilities: [], reason: 'device offline mid-install', checkedAt: 1, attempts: 3, nextAttemptAt: null },
        // No `preparation` column at all — exactly a row written before this migration.
      })
      .run()
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(deriveAgentState(row)).toBe('failed')
    expect(rowToDeviceInfo(row).agent).toBe('failed')
  })

  test('a device that has never been provisioned reads absent, not a crash', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ZP2222RMBS', label: 'Phone', status: 'online' }).run()
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(deriveAgentState(row)).toBe('absent')
  })
})

/**
 * The device number (plan 89 §3.1, §3.2, §4.2, §4.3) — a lookup against
 * `device_numbers`, keyed by `stableId`, never a column on `devices` (§3.2).
 * `rowToDeviceInfo` defaults `number` to `null` so every existing call site
 * that omits it keeps parsing exactly as before this plan; `listDevicesWithTags`
 * resolves it once for the whole fleet, the same N+1 discipline `networks`/
 * `tags`/`groups` above already follow.
 */
describe('rowToDeviceInfo / listDevicesWithTags — number (plan 89 §4.2, §4.3)', () => {
  test('listDevicesWithTags populates every device\'s number from one query, never N+1', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ZP2222RMBS', label: 'Phone 1', status: 'online' }).run()
    db.insert(devices).values({ id: 'd2', stableId: 's2', serial: 'ZP2222RMBT', label: 'Phone 2', status: 'online' }).run()
    allocateDeviceNumber(db, 's1')
    allocateDeviceNumber(db, 's2')

    let numberQueries = 0
    const originalPrepare = opened.sqlite.prepare.bind(opened.sqlite) as (sql: string, params?: unknown) => unknown
    opened.sqlite.prepare = ((sql: string, params?: unknown) => {
      if (sql.includes('device_numbers')) numberQueries++
      return originalPrepare(sql, params)
    }) as typeof opened.sqlite.prepare

    const infos = listDevicesWithTags(db)
    const byId = new Map(infos.map((d) => [d.id, d.number]))
    expect(byId.get('d1')).toBe(1)
    expect(byId.get('d2')).toBe(2)
    expect(numberQueries).toBe(1)
  })

  test('a device with no reservation reads number: null through listDevicesWithTags, not 0 or undefined', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ZP2222RMBS', label: 'Phone', status: 'online' }).run()
    const infos = listDevicesWithTags(db)
    expect(infos[0]?.number).toBeNull()
  })

  test('rowToDeviceInfo called directly (no number arg) defaults to null, so every existing call site keeps parsing', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ZP2222RMBS', label: 'Phone', status: 'online' }).run()
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    const info = rowToDeviceInfo(row)
    expect(info.number).toBeNull()
  })

  test('rowToDeviceInfo passed a number returns it verbatim', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ZP2222RMBS', label: 'Phone', status: 'online' }).run()
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    const info = rowToDeviceInfo(row, [], null, null, null, undefined, [], new Map(), 7)
    expect(info.number).toBe(7)
  })

  test('admitDevice → the row carries a real number the moment it is fetched (the class of bug this plan is against: a schema field no route populates)', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(discoveredDevices).values({ stableId: 'sid-new', serial: 'serial-new', label: 'New Phone', firstSeen: new Date(), lastSeen: new Date() }).run()
    const row = admitDevice(db, 'sid-new')
    expect(row).not.toBeNull()
    const info = rowToDeviceInfo(row!, [], null, null, null, undefined, [], new Map(), lookupDeviceNumber(db, row!.stableId))
    expect(info.number).toBe(1)
  })
})

/**
 * Residual gap left by plan 88 step 88.5's own pass (fixed here):
 * `DeviceRegistryDeps` had no `networks` accessor at all — `onOnline`'s own
 * `device.added` broadcast and this registry's `listDevices()` were both
 * hardcoded to `[]`, so a device on a configured wired network could never
 * badge OTG through either path. Proven through the registry's own public
 * surface (`createDeviceRegistry(...).listDevices()`), not `deriveConnection`
 * in isolation.
 */
describe('DeviceRegistry — networks (plan 88 §3.6, §4.1, residual gap)', () => {
  test('listDevices() reflects a configured farm network — medium: wired, not TCP-unknown', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: '10.20.0.37:5555', label: 'Chassis phone', status: 'online' }).run()

    const registry = createDeviceRegistry({
      client: fakeAdb(),
      db,
      hub: new WsHub(log),
      log,
      states: createDeviceStateMachine({ db, log, onChange: () => {} }),
      networks: () => [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }],
    })

    const infos = registry.listDevices()
    expect(infos).toHaveLength(1)
    expect(infos[0]?.connection).toMatchObject({ medium: 'wired', mediumSource: 'network', networkLabel: 'Chassis A' })
  })

  test('without a networks accessor, listDevices() matches no network — same as before this field existed', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: '10.20.0.37:5555', label: 'Chassis phone', status: 'online' }).run()

    const registry = createDeviceRegistry({
      client: fakeAdb(),
      db,
      hub: new WsHub(log),
      log,
      states: createDeviceStateMachine({ db, log, onChange: () => {} }),
    })

    const infos = registry.listDevices()
    expect(infos[0]?.connection).toMatchObject({ medium: null, mediumSource: 'unknown' })
  })
})

describe('EndpointStore wiring — observe() on a successful probe (plan 88 §3.2, §4.3, fixes F10)', () => {
  type AddEvent = { kind: 'add'; serial: string; state: string }

  function fakeEndpointStore(): { store: EndpointStore; calls: Array<{ stableId: string; serial: string }> } {
    const calls: Array<{ stableId: string; serial: string }> = []
    const store: EndpointStore = {
      observe: (stableId, serial) => {
        calls.push({ stableId, serial })
      },
      declare: () => {},
      candidates: () => [],
      noteAttempt: () => {},
      forget: () => {},
      allWithEndpoints: () => [],
    }
    return { store, calls }
  }

  test('a successful probe of an ADMITTED device calls observe(stableId, serial) — the whole cost of the address book (plan 88 §3.2)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const client = fakeAdb()
    const listeners: Array<(ev: AddEvent) => void> = []
    ;(client as unknown as { trackDevices: () => unknown }).trackDevices = () => ({
      on: (cb: (ev: AddEvent) => void) => {
        listeners.push(cb)
        return () => {}
      },
      start: async () => {},
      stop: () => {},
    })
    const { store, calls } = fakeEndpointStore()

    const registry = createDeviceRegistry({
      client,
      db,
      hub: new WsHub(log),
      log,
      states: createDeviceStateMachine({ db, log, onChange: () => {} }),
      endpoints: store,
    })
    await registry.start()

    // First sighting: plan 56 routes an unadmitted device to the Discovered
    // tray, not into `devices` — observe() must NOT fire for a sighting
    // nobody admitted (the address book only ever serves an enrolled device).
    for (const cb of listeners) cb({ kind: 'add', serial: '10.0.0.5:5555', state: 'device' })
    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toEqual([])

    admitDevice(db, 'HW-SERIAL-1', {})
    for (const cb of listeners) cb({ kind: 'add', serial: '10.0.0.5:5555', state: 'device' })
    await new Promise((r) => setTimeout(r, 150))

    expect(calls).toEqual([{ stableId: 'HW-SERIAL-1', serial: '10.0.0.5:5555' }])
    await registry.stop()
  })

  test('a USB serial still reaches observe() — filtering non-TCP shapes is EndpointStore\'s own job, not the registry\'s', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const client = fakeAdb()
    const listeners: Array<(ev: AddEvent) => void> = []
    ;(client as unknown as { trackDevices: () => unknown }).trackDevices = () => ({
      on: (cb: (ev: AddEvent) => void) => {
        listeners.push(cb)
        return () => {}
      },
      start: async () => {},
      stop: () => {},
    })
    const { store, calls } = fakeEndpointStore()
    const registry = createDeviceRegistry({
      client,
      db,
      hub: new WsHub(log),
      log,
      states: createDeviceStateMachine({ db, log, onChange: () => {} }),
      endpoints: store,
    })
    await registry.start()
    for (const cb of listeners) cb({ kind: 'add', serial: 'USB-SERIAL-1', state: 'device' })
    await new Promise((r) => setTimeout(r, 150))
    admitDevice(db, 'HW-SERIAL-1', {})
    for (const cb of listeners) cb({ kind: 'add', serial: 'USB-SERIAL-1', state: 'device' })
    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toEqual([{ stableId: 'HW-SERIAL-1', serial: 'USB-SERIAL-1' }])
    await registry.stop()
  })

  test('without an EndpointStore dependency the registry behaves exactly as before this plan (optional dep, no crash)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const client = fakeAdb()
    const listeners: Array<(ev: AddEvent) => void> = []
    ;(client as unknown as { trackDevices: () => unknown }).trackDevices = () => ({
      on: (cb: (ev: AddEvent) => void) => {
        listeners.push(cb)
        return () => {}
      },
      start: async () => {},
      stop: () => {},
    })
    const registry = createDeviceRegistry({ client, db, hub: new WsHub(log), log, states: createDeviceStateMachine({ db, log, onChange: () => {} }) })
    await registry.start()
    admitDevice(db, 'HW-SERIAL-1', {}) // no sighting yet — returns null, harmless
    for (const cb of listeners) cb({ kind: 'add', serial: '10.0.0.5:5555', state: 'device' })
    await expect(new Promise((r) => setTimeout(r, 150))).resolves.toBeUndefined()
    await registry.stop()
  })
})
