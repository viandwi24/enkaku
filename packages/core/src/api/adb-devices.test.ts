import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import { AdbRawListResponseSchema, type ShellMode } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { blockedDevices, devices, deviceNumbers, discoveredDevices } from '../db/schema'
import { createAdbDeviceRoutes } from './adb-devices'

/**
 * Two things are worth a test here, and they are both about the JOIN.
 *
 * The first is that the farm column is right: this page exists because adb's
 * list and the farm's list disagree, so a row that mislabels an unadmitted
 * phone as enrolled (or the reverse) would defeat the whole screen. The
 * second is the shell gate — a second door onto `privacy.adbCommand` that
 * honoured a different switch would make that switch a lie, and unlike the
 * rest of this router it takes a bare serial with no device row to own.
 *
 * The adb client is a stub. There is no value in asserting that `host:connect`
 * is spelled correctly (`@enkaku/adb`'s own tests do that against a real
 * socket); what this file checks is what this router does with the answer.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function stubClient(tracked: TrackedDevice[], overrides: Partial<AdbClient> = {}): AdbClient {
  return {
    listDevices: async () => tracked,
    version: async () => '0041',
    listForward: async () => [],
    pending: () => 0,
    ...overrides,
  } as unknown as AdbClient
}

function makeApp(
  db: Db,
  opts: { client?: AdbClient | null; role?: 'admin' | 'operator' | null; mode?: ShellMode } = {},
) {
  const role = opts.role === undefined ? 'admin' : opts.role
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route(
    '/',
    createAdbDeviceRoutes({
      db,
      audit: createAuditLogger(db),
      client: () => (opts.client === undefined ? stubClient([]) : opts.client),
      shellSettings: () => ({ mode: opts.mode ?? 'operator' }),
    }),
  )
  return wrapper
}

function seedDevice(db: Db, row: { id: string; stableId: string; serial: string; label: string; status?: string }): void {
  db.insert(devices)
    .values({ id: row.id, stableId: row.stableId, serial: row.serial, label: row.label, status: row.status ?? 'online' })
    .run()
}

async function listRaw(app: Hono<AuthEnv>) {
  const res = await app.request('/devices')
  expect(res.status).toBe(200)
  return AdbRawListResponseSchema.parse(await res.json())
}

describe('GET /api/adb/devices', () => {
  test('says which of adb’s serials the farm knows, and which it has never seen', async () => {
    const db = setUp()
    seedDevice(db, { id: 'd1', stableId: 'S1', serial: 'ABC123', label: 'Moto one' })
    db.insert(deviceNumbers).values({ stableId: 'S1', number: 7, assignedAt: new Date(), assignedBy: null }).run()
    db.insert(discoveredDevices)
      .values({ stableId: 'S2', serial: 'DEF456', label: 'Pixel 6', androidVersion: null, firstSeen: new Date(), lastSeen: new Date() })
      .run()

    const app = makeApp(db, {
      client: stubClient([
        { serial: 'ABC123', state: 'device', usb: '3-1.4', transportId: 4, model: 'moto_g06' },
        { serial: 'DEF456', state: 'device' },
        // The whole reason this page exists: no stableId can be read until
        // the RSA prompt is accepted, so this phone has no farm row anywhere.
        { serial: 'GHI789', state: 'unauthorized' },
      ]),
    })

    const body = await listRaw(app)
    const [enrolled, discovered, stranger] = body.devices
    expect(enrolled?.farm).toEqual({ kind: 'enrolled', deviceId: 'd1', name: 'Moto one', number: 7, status: 'online' })
    expect(enrolled?.usb).toBe('3-1.4')
    expect(enrolled?.model).toBe('moto_g06')
    expect(discovered?.farm.kind).toBe('discovered')
    expect(discovered?.farm.name).toBe('Pixel 6')
    expect(stranger?.farm).toEqual({ kind: 'unknown', deviceId: null, name: null, number: null, status: null })
  })

  test('a blocked serial reads blocked, not enrolled', async () => {
    const db = setUp()
    seedDevice(db, { id: 'd1', stableId: 'S1', serial: 'ABC123', label: 'Moto one' })
    db.insert(blockedDevices).values({ stableId: 'S1', label: 'Moto one', reason: 'personal', blockedAt: new Date(), blockedBy: 'u1' }).run()

    const app = makeApp(db, { client: stubClient([{ serial: 'ABC123', state: 'device' }]) })
    expect((await listRaw(app)).devices[0]?.farm.kind).toBe('blocked')
  })

  test('splits a TCP serial into an endpoint and leaves a USB serial alone', async () => {
    const db = setUp()
    const app = makeApp(db, {
      client: stubClient([
        { serial: '10.0.0.4:5555', state: 'device' },
        { serial: 'ABC123', state: 'device' },
      ]),
    })

    const body = await listRaw(app)
    expect(body.devices[0]?.endpoint).toEqual({ host: '10.0.0.4', port: 5555 })
    expect(body.devices[1]?.endpoint).toBeNull()
  })

  test('a server that cannot list forwards still returns its devices', async () => {
    const db = setUp()
    const app = makeApp(db, {
      client: stubClient([{ serial: 'ABC123', state: 'device' }], {
        listForward: async () => {
          throw new Error('unknown host service')
        },
        version: async () => {
          throw new Error('nope')
        },
      }),
    })

    const body = await listRaw(app)
    expect(body.devices).toHaveLength(1)
    expect(body.forwards).toEqual([])
    // Reported as absent, never fabricated.
    expect(body.serverVersion).toBeNull()
  })

  test('503 rather than a crash when the adb subsystem is not up', async () => {
    const app = makeApp(setUp(), { client: null })
    const res = await app.request('/devices')
    expect(res.status).toBe(503)
  })
})

describe('POST /api/adb/shell', () => {
  test('refuses on a farm where adb commands are off, whatever the role', async () => {
    const db = setUp()
    const app = makeApp(db, { role: 'admin', mode: 'off' })
    const res = await app.request('/shell', {
      method: 'POST',
      body: JSON.stringify({ serial: 'ABC123', command: 'getprop' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(403)
  })

  test('normalises the command, so `adb shell getprop` and `getprop` are one command', async () => {
    const db = setUp()
    const ran: string[] = []
    const app = makeApp(db, {
      mode: 'operator',
      role: 'operator',
      client: stubClient([], {
        exec: async (_serial: string, cmd: string) => {
          ran.push(cmd)
          return { stdout: 'moto_g06\n', stderr: '', exitCode: 0 }
        },
      } as Partial<AdbClient>),
    })

    const res = await app.request('/shell', {
      method: 'POST',
      body: JSON.stringify({ serial: 'ABC123', command: 'adb shell getprop ro.product.model' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(ran).toEqual(['getprop ro.product.model'])
    expect((await res.json()) as { stdout: string }).toMatchObject({ stdout: 'moto_g06\n', code: 0 })
  })
})

describe('POST /api/adb/connect', () => {
  test('a port nothing is listening on is answered without ever calling host:connect', async () => {
    const db = setUp()
    const dialled: string[] = []
    const app = makeApp(db, {
      client: stubClient([], {
        connectDevice: async () => {
          dialled.push('called')
          return 'connected to 127.0.0.1:1'
        },
      } as Partial<AdbClient>),
    })

    // Port 1 on loopback: refused instantly, and the point is that the
    // measured minute-long `host:connect` worst case is never reached.
    const res = await app.request('/connect', {
      method: 'POST',
      body: JSON.stringify({ host: '127.0.0.1', port: 1 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false })
    expect(dialled).toEqual([])
  })
})
