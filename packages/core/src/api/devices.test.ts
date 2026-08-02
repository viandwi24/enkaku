import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegistryResponse } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, auditLog, clusters, devices, deviceTags } from '../db/schema'
import { deleteDeviceTags } from '../registry/device-tags'
import { createDeviceRoutes } from './devices'

function emptyRegistry(): RegistryResponse {
  return { transports: [], displays: [], inputs: [], inspectors: [], tools: [] }
}

function seedDevice(db: Db, id: string, tags: string[] = []): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: 'Test Phone', status: 'idle' })
    .run()
  const now = new Date()
  for (const tag of tags) db.insert(deviceTags).values({ deviceId: id, tag, at: now }).run()
}

function makeApp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const audit = createAuditLogger(db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
  const app = createDeviceRoutes({ db, registry: async () => emptyRegistry(), battery: () => null, audit, dataDir })
  return { db, app, dataDir }
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
    const bothBody = (await both.json()) as { devices: Array<{ id: string }> }
    expect(bothBody.devices.map((d) => d.id)).toEqual(['a'])

    const one = await app.request('/?tag=pool:smoke')
    const oneBody = (await one.json()) as { devices: Array<{ id: string }> }
    expect(oneBody.devices.map((d) => d.id).sort()).toEqual(['a', 'b'])

    const none = await app.request('/')
    const noneBody = (await none.json()) as { devices: Array<{ id: string }> }
    expect(noneBody.devices).toHaveLength(3)
  })

  test('a single GET /api/devices?tag=... issues exactly one device_tags query, not one per device', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    for (let i = 0; i < 50; i++) seedDevice(db, `dev-${i}`, ['pool:smoke'])
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const app = createDeviceRoutes({ db, registry: async () => emptyRegistry(), battery: () => null, audit, dataDir })

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
    const body = (await res.json()) as { devices: unknown[] }
    expect(body.devices).toHaveLength(50)
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
    const clusteredBody = (await clustered.json()) as { devices: Array<{ id: string }> }
    expect(clusteredBody.devices.map((d) => d.id).sort()).toEqual(['a', 'b'])

    const none = await app.request('/?clusterId=none')
    const noneBody = (await none.json()) as { devices: Array<{ id: string }> }
    expect(noneBody.devices.map((d) => d.id)).toEqual(['c'])
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
