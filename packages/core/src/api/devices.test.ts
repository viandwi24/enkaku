import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegistryResponse } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, auditLog, blockedDevices, clusters, deletedDevices, deviceEvents, deviceTags, devices, discoveredDevices } from '../db/schema'
import { createDeviceLifecycle } from '../device/lifecycle'
import type { Lease, LeaseManager } from '../lease/lease-manager'
import { deleteDeviceTags } from '../registry/device-tags'
import { createLogger } from '../util/logger'
import { createDeviceRoutes } from './devices'

function emptyRegistry(): RegistryResponse {
  return { transports: [], displays: [], inputs: [], inspectors: [], networks: [], tools: [] }
}

/** No test in this file exercises a live manual lease — `getLease` always answers "none held". */
function fakeLeases(): LeaseManager {
  return {
    acquireManual: (): Lease => {
      throw new Error('not used in this test')
    },
    touchManual: () => {},
    releaseManual: () => false,
    releaseAllForClient: () => {},
    noteJobLease: () => {},
    clearJobLease: () => {},
    getLease: () => null,
    checkInputAllowed: () => ({ ok: true }),
    startReaper: () => {},
    stopReaper: () => {},
  }
}

function seedDevice(db: Db, id: string, tags: string[] = []): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: 'Test Phone', status: 'idle' })
    .run()
  const now = new Date()
  for (const tag of tags) db.insert(deviceTags).values({ deviceId: id, tag, at: now }).run()
}

/**
 * `PUT /:id/tags` and `PUT /:id/cluster` now require `device.settings` (plan
 * 34 §4.4, §4.5) — an admin user by default, matching what these
 * pre-existing tests already assumed implicitly. The wiring itself is
 * covered by the dedicated describe block at the end of this file.
 */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function makeApp(role: 'admin' | 'operator' | null = 'admin') {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const audit = createAuditLogger(db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
  const broadcast: Array<{ type: string; payload: unknown }> = []
  const lifecycle = createDeviceLifecycle({ db, leases: fakeLeases(), log: createLogger('test') })
  const app = withUser(
    role,
    createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      broadcast: (msg) => broadcast.push(msg),
    }),
  )
  return { db, app, dataDir, broadcast }
}

const json = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('GET /api/devices tag filtering', () => {
  test('?tag=a&tag=b returns only devices carrying BOTH tags', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['pool:smoke', 'android:15'])
    seedDevice(db, 'b', ['pool:smoke'])
    seedDevice(db, 'c', ['android:15'])

    const both = await app.request('/?tag=pool:smoke&tag=android:15')
    expect(both.status).toBe(200)
    const bothBody = (await both.json()) as { items: Array<{ id: string }> }
    expect(bothBody.items.map((d) => d.id)).toEqual(['a'])

    const one = await app.request('/?tag=pool:smoke')
    const oneBody = (await one.json()) as { items: Array<{ id: string }> }
    expect(oneBody.items.map((d) => d.id).sort()).toEqual(['a', 'b'])

    const none = await app.request('/')
    const noneBody = (await none.json()) as { items: Array<{ id: string }> }
    expect(noneBody.items).toHaveLength(3)
  })

  test('a single GET /api/devices?tag=... issues exactly one device_tags query, not one per device', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    for (let i = 0; i < 50; i++) seedDevice(db, `dev-${i}`, ['pool:smoke'])
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const lifecycle = createDeviceLifecycle({ db, leases: fakeLeases(), log: createLogger('test') })
    const app = createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      broadcast: () => {},
    })

    // Every drizzle bun-sqlite query goes through `client.prepare(sql)` — count
    // how many of those touch device_tags (acceptance #7: one query, not N+1).
    let tagQueries = 0
    const originalPrepare = opened.sqlite.prepare.bind(opened.sqlite) as (sql: string, params?: unknown) => unknown
    opened.sqlite.prepare = ((sql: string, params?: unknown) => {
      if (sql.includes('device_tags')) tagQueries++
      return originalPrepare(sql, params)
    }) as typeof opened.sqlite.prepare

    const res = await app.request('/?tag=pool:smoke')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toHaveLength(50)
    expect(tagQueries).toBe(1)
  })
})

describe('PUT /api/devices/:id/tags', () => {
  test('normalises, replaces the whole set atomically, and records an audit entry', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['stale:tag'])

    const res = await app.request('/a/tags', json({ tags: [' Pool: Smoke ', 'android:15', 'android:15'] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tags: string[] }
    expect(body.tags).toEqual(['android:15', 'pool:smoke'])

    const rows = db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()
    expect(rows.map((r) => r.tag).sort()).toEqual(['android:15', 'pool:smoke'])

    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.settings')
    expect(entries[0]!.target).toBe('a')
  })

  test('an invalid tag rejects the whole request and leaves existing tags untouched', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['pool:smoke'])

    const res = await app.request('/a/tags', json({ tags: ['pool:smoke', 'bad tag!'] }))
    expect(res.status).toBe(400)

    const rows = db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()
    expect(rows.map((r) => r.tag)).toEqual(['pool:smoke'])
  })

  test('an empty array clears all tags', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['pool:smoke', 'android:15'])

    const res = await app.request('/a/tags', json({ tags: [] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tags: string[] }
    expect(body.tags).toEqual([])

    const rows = db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()
    expect(rows).toHaveLength(0)
  })

  test('404s for an unknown device', async () => {
    const { app } = makeApp()
    const res = await app.request('/does-not-exist/tags', json({ tags: [] }))
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/devices/:id/cluster (plan 22.0 §4.4, acceptance #1, #2)', () => {
  const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('assigns an unclustered device and reports movedFrom: null', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()

    const res = await app.request('/a/cluster', put({ clusterId: 'c1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { cluster: { id: string; name: string } | null }; movedFrom: string | null }
    expect(body.device.cluster).toEqual({ id: 'c1', name: 'Jakarta' })
    expect(body.movedFrom).toBeNull()

    const entries = db.select().from(auditLog).all()
    expect(entries.find((e) => e.action === 'cluster.assign')).toBeTruthy()
  })

  test('assigning a device already in another cluster moves it and reports what it moved from', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'jakarta', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    db.insert(clusters).values({ id: 'bandung', name: 'Bandung', description: null, createdAt: new Date() }).run()
    await app.request('/a/cluster', put({ clusterId: 'jakarta' }))

    const res = await app.request('/a/cluster', put({ clusterId: 'bandung' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { cluster: { id: string } | null }; movedFrom: string | null }
    expect(body.device.cluster?.id).toBe('bandung')
    expect(body.movedFrom).toBe('jakarta')
  })

  test('clusterId: null unassigns and records cluster.unassign', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    await app.request('/a/cluster', put({ clusterId: 'c1' }))

    const res = await app.request('/a/cluster', put({ clusterId: null }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { cluster: unknown } }
    expect(body.device.cluster).toBeNull()
    const entries = db.select().from(auditLog).all()
    expect(entries.find((e) => e.action === 'cluster.unassign')).toBeTruthy()
  })

  test('an unknown cluster id 404s', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/a/cluster', put({ clusterId: 'ghost' }))
    expect(res.status).toBe(404)
  })
})

describe('GET /api/devices?clusterId= (plan 22.0 §4.4, acceptance #4)', () => {
  test('clusterId=<id> returns only that cluster\'s members; clusterId=none returns exactly the unclustered devices', async () => {
    const { db, app } = makeApp()
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    seedDevice(db, 'c')
    db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, 'a')).run()
    db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, 'b')).run()

    const clustered = await app.request('/?clusterId=c1')
    const clusteredBody = (await clustered.json()) as { items: Array<{ id: string }> }
    expect(clusteredBody.items.map((d) => d.id).sort()).toEqual(['a', 'b'])

    const none = await app.request('/?clusterId=none')
    const noneBody = (await none.json()) as { items: Array<{ id: string }> }
    expect(noneBody.items.map((d) => d.id)).toEqual(['c'])
  })
})

describe('GET /api/devices keyset pagination (label ASC, id ASC)', () => {
  function seedLabelled(db: Db, id: string, label: string): void {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label, status: 'idle' }).run()
  }

  test('pages through 5 devices with limit=2: the union is exactly the 5, no duplicates', async () => {
    const { db, app } = makeApp()
    const ids = ['e', 'a', 'd', 'c', 'b']
    for (const id of ids) seedLabelled(db, id, `label-${id}`)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor ? `/?limit=2&cursor=${encodeURIComponent(cursor)}` : '/?limit=2'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null; total: number | null }
      for (const item of body.items) {
        expect(seen.has(item.id)).toBe(false)
        seen.add(item.id)
      }
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual(ids.sort())
  })

  test('is sorted by label ascending, not insertion order', async () => {
    const { db, app } = makeApp()
    seedLabelled(db, 'x', 'zzz-last')
    seedLabelled(db, 'y', 'aaa-first')
    const res = await app.request('/?limit=10')
    const body = (await res.json()) as { items: Array<{ id: string; label: string }> }
    expect(body.items.map((d) => d.label)).toEqual(['aaa-first', 'zzz-last'])
  })

  test('a malformed cursor returns 400, not a silently-ignored one', async () => {
    const { app } = makeApp()
    const res = await app.request('/?cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })

  test('a limit above the cap is clamped, not honoured', async () => {
    const { db, app } = makeApp()
    for (let i = 0; i < 5; i++) seedLabelled(db, `d${i}`, `label-${i}`)
    const res = await app.request('/?limit=99999')
    const body = (await res.json()) as { items: unknown[]; total: number | null }
    expect(body.items).toHaveLength(5) // fewer than the cap anyway, but the request itself must not 400 or hang
    expect(body.total).toBe(5)
  })
})

describe('device deletion cleans up its tags', () => {
  // There is no device-delete endpoint in this codebase yet (plan 19 §4.1
  // notes this as an assumption); this exercises the cleanup helper that
  // whichever plan adds deletion must call in the same transaction.
  test('deleteDeviceTags leaves no orphan rows once the device row is gone', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a', ['pool:smoke', 'android:15'])
    seedDevice(db, 'b', ['pool:smoke'])

    db.transaction((tx) => {
      deleteDeviceTags(tx as unknown as Db, 'a')
      tx.delete(devices).where(eq(devices.id, 'a')).run()
    })

    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()).toHaveLength(0)
    // The other device's tags are untouched.
    expect(db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'b')).all()).toHaveLength(1)
  })
})

describe('POST /:id/monitor/save (plan 24 §4.6) — "save last N lines" writes a device-scoped artifact', () => {
  test('writes a .log artifact tied to the device (not a job) and returns it', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'logcat', lines: ['line one', 'line two', 'line three'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { artifact: { id: string; jobId: string | null; deviceId: string | null; kind: string } }
    expect(body.artifact.jobId).toBeNull()
    expect(body.artifact.deviceId).toBe('dev-1')
    expect(body.artifact.kind).toBe('log')

    const row = db.select().from(artifacts).where(eq(artifacts.id, body.artifact.id)).get()
    expect(row?.deviceId).toBe('dev-1')
    expect(row?.jobId).toBeNull()
  })

  test('rejects more than 5000 lines', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'logcat', lines: Array.from({ length: 5001 }, (_, i) => String(i)) }),
    })
    expect(res.status).toBe(400)
  })

  test('rejects an unknown device', async () => {
    const { app } = makeApp()
    const res = await app.request('/ghost/monitor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'top', lines: ['x'] }),
    })
    expect(res.status).toBe(404)
  })
})

describe('requirePermission("device.settings") on tags/cluster (plan 34 §4.4, §4.5, acceptance #7)', () => {
  test('PUT /:id/tags is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a/tags', json({ tags: ['pool:smoke'] }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (device.settings is an OPERATOR permission) may still set tags — no lockout', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    const res = await app.request('/a/tags', json({ tags: ['pool:smoke'] }))
    expect(res.status).toBe(200)
  })

  test('PUT /:id/cluster is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    const res = await app.request('/a/cluster', json({ clusterId: 'c1' }))
    expect(res.status).toBe(403)
  })

  test('GET /:id needs no permission at all — read routes stay open', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a')
    expect(res.status).toBe(200)
  })

  // Plan 47 §4.4 — the same permission tags/cluster already use (§9 of the
  // plan says so explicitly), calling directly is refused exactly as the UI
  // would be (acceptance #12).
  test('DELETE /:id (Forget) is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('POST /:id/block is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a/block', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('GET /:id/history-counts is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a/history-counts')
    expect(res.status).toBe(403)
  })

  test('GET /blocked and DELETE /blocked/:stableId are refused with no authenticated user', async () => {
    const { app } = makeApp(null)
    expect((await app.request('/blocked')).status).toBe(403)
    expect((await app.request('/blocked/stable-a', { method: 'DELETE' })).status).toBe(403)
  })
})

describe('DELETE /api/devices/:id — Forget (plan 47 §4.4, §6)', () => {
  test('an offline device is forgotten: 200, gone from the list, a device.removed broadcast, an audit entry', async () => {
    const { db, app, broadcast } = makeApp()
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { forgotten: { deviceId: string; stableId: string; historyDeleted: boolean; counts: unknown } }
    expect(body.forgotten).toEqual({ deviceId: 'a', stableId: 'stable-a', historyDeleted: false, counts: null })

    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(db.select().from(deletedDevices).where(eq(deletedDevices.id, 'a')).get()?.stableId).toBe('stable-a')
    expect(broadcast).toContainEqual({ type: 'device.removed', payload: { id: 'a', stableId: 'stable-a' } })
    const auditRows = db.select().from(auditLog).where(eq(auditLog.action, 'device.forget')).all()
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]?.target).toBe('a')
  })

  test('the round trip: forget a connected device, then admit it again — the loop the old refusal made impossible', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')

    expect((await app.request('/a', { method: 'DELETE' })).status).toBe(200)

    const tray = (await (await app.request('/discovered')).json()) as { discovered: Array<{ stableId: string }> }
    expect(tray.discovered.map((d) => d.stableId)).toEqual(['stable-a'])

    const admitted = await app.request('/discovered/stable-a/admit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Rack 3 slot 2' }),
    })
    expect(admitted.status).toBe(200)

    const rows = db.select().from(devices).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.label).toBe('Rack 3 slot 2')
    // The device kept its identity across the whole loop, which is the promise
    // `stableId` makes (spec §7.5) — only the row id is new.
    expect(rows[0]?.stableId).toBe('stable-a')
    expect(db.select().from(discoveredDevices).all()).toHaveLength(0)
  })

  test('admitting something that is not in the tray is a 404, not a server error', async () => {
    const { app } = makeApp()
    const res = await app.request('/discovered/never-seen/admit', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_DISCOVERED')
  })

  test('dismiss removes the entry without blocking anything (plan 56 §3.5)', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    await app.request('/a', { method: 'DELETE' })
    expect(db.select().from(discoveredDevices).all()).toHaveLength(1)

    expect((await app.request('/discovered/stable-a', { method: 'DELETE' })).status).toBe(200)

    expect(db.select().from(discoveredDevices).all()).toHaveLength(0)
    // Dismissal is not a quiet block — nothing was added to the block list, so
    // the phone is free to reappear the next time it connects.
    expect(db.select().from(blockedDevices).all()).toHaveLength(0)
  })

  test('forgetting an online device succeeds and lands it in the Discovered tray (plan 56 §3.2)', async () => {
    // Until plan 56 this was a 409 `device_online` with an offer to block
    // instead — the trap that made an operator declare a phone permanently
    // unwelcome just to take it out of the farm.
    const { db, app } = makeApp()
    seedDevice(db, 'a') // seedDevice leaves status: 'idle'

    const res = await app.request('/a', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(db.select().from(discoveredDevices).all()).toHaveLength(1)
    expect(db.select().from(blockedDevices).all()).toHaveLength(0)
  })

  test('?deleteHistory=true deletes exactly the counts GET /:id/history-counts promised', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, 'a')).run()
    db.insert(deviceEvents).values({ id: 'e1', deviceId: 'a', stream: 'main', kind: 'device.online', at: new Date() }).run()

    const before = await app.request('/a/history-counts')
    const beforeBody = (await before.json()) as { counts: { jobs: number; artifacts: number; events: number } }
    expect(beforeBody.counts.events).toBe(1)

    const res = await app.request('/a?deleteHistory=true', { method: 'DELETE' })
    const body = (await res.json()) as { forgotten: { historyDeleted: boolean; counts: unknown } }
    expect(body.forgotten.historyDeleted).toBe(true)
    expect(body.forgotten.counts).toEqual(beforeBody.counts)
    expect(db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, 'a')).all()).toHaveLength(0)
  })

  test('an unknown device is refused with 404', async () => {
    const { app } = makeApp()
    const res = await app.request('/ghost', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/devices/:id/block (plan 47 §4.4, §6)', () => {
  test('blocks a connected device: it disappears from the fleet, is listed under GET /blocked, and can be unblocked', async () => {
    const { db, app, broadcast } = makeApp()
    seedDevice(db, 'a') // idle — the connected case this verb exists for.

    const res = await app.request('/a/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'retired' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blocked: { stableId: string; reason: string | null } }
    expect(body.blocked).toMatchObject({ stableId: 'stable-a', reason: 'retired' })

    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(broadcast).toContainEqual({ type: 'device.removed', payload: { id: 'a', stableId: 'stable-a' } })

    const list = await app.request('/blocked')
    const listBody = (await list.json()) as { blocked: Array<{ stableId: string }> }
    expect(listBody.blocked.map((b) => b.stableId)).toEqual(['stable-a'])

    const unblock = await app.request('/blocked/stable-a', { method: 'DELETE' })
    expect(unblock.status).toBe(200)
    const listAfter = await app.request('/blocked')
    const listAfterBody = (await listAfter.json()) as { blocked: unknown[] }
    expect(listAfterBody.blocked).toEqual([])
    const auditRows = db.select().from(auditLog).where(eq(auditLog.action, 'device.unblock')).all()
    expect(auditRows).toHaveLength(1)
  })

  test('block is refused for a busy device, exactly like forget', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'busy' }).where(eq(devices.id, 'a')).run()
    const res = await app.request('/a/block', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('device_busy')
  })

  test('a blocked stableId never comes back through GET /api/devices — it is not in the live list', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(blockedDevices).values({ stableId: 'blocked-elsewhere', label: null, reason: null, blockedAt: new Date(), blockedBy: null }).run()
    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ stableId: string }> }
    expect(body.items.map((d) => d.stableId)).toEqual(['stable-a'])
  })
})

describe('GET /api/devices/refs — dangling-reference resolution (plan 47 §4.5)', () => {
  test('resolves a live device and a deleted one in the same call, and omits an id neither table has', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(deletedDevices).values({ id: 'gone-1', stableId: 'stable-gone-1', label: 'Old Phone', deletedAt: new Date() }).run()

    const res = await app.request('/refs?ids=a,gone-1,never-existed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      refs: Record<string, { id: string; label: string | null; stableId: string; deleted: boolean }>
    }
    expect(body.refs.a).toEqual({ id: 'a', label: 'Test Phone', stableId: 'stable-a', deleted: false })
    expect(body.refs['gone-1']).toEqual({ id: 'gone-1', label: 'Old Phone', stableId: 'stable-gone-1', deleted: true })
    expect(body.refs['never-existed']).toBeUndefined()
  })

  test('no permission required — the same "reads stay open" rule as GET /:id', async () => {
    const { app } = makeApp(null)
    const res = await app.request('/refs?ids=x')
    expect(res.status).toBe(200)
  })
})
