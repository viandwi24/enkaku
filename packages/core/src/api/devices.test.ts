import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReconcileReport, RegistryResponse, SweepReport } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, auditLog, blockedDevices, clusters, deletedDevices, deviceEvents, deviceTags, devices, discoveredDevices } from '../db/schema'
import type { BatteryMonitor } from '../device/battery'
import { createDeviceLifecycle } from '../device/lifecycle'
import type { Lease, LeaseManager } from '../lease/lease-manager'
import { deleteDeviceTags } from '../registry/device-tags'
import { EnkakuError } from '../util/errors'
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
    getHolder: () => null,
    lastManualReleaseAt: () => null,
    lastManualHolder: () => null,
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

function makeApp(
  role: 'admin' | 'operator' | null = 'admin',
  opts: {
    rescan?: () => Promise<ReconcileReport> | null
    battery?: () => BatteryMonitor | null
    registry?: () => Promise<RegistryResponse>
    sweeper?: { sweep(opts?: { expect?: string[] }): Promise<SweepReport> }
  } = {},
) {
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
      registry: opts.registry ?? (async () => emptyRegistry()),
      battery: opts.battery ?? (() => null),
      audit,
      dataDir,
      lifecycle,
      heldByOf: () => null,
      broadcast: (msg) => broadcast.push(msg),
      ...(opts.rescan ? { rescan: opts.rescan } : {}),
      ...(opts.sweeper ? { sweeper: opts.sweeper } : {}),
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
      heldByOf: () => null,
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

/**
 * Plan 71 §4.4, criterion 1 — `heldBy` on every `DeviceInfo` this router
 * builds: the list endpoint, the single-device endpoint, and everywhere else
 * `rowToDeviceInfo`/`listDevicesWithTags` are called from here.
 */
describe('GET /api/devices — heldBy (plan 71 §3.2, §4.4, criterion 1)', () => {
  const holder = {
    kind: 'agent' as const,
    id: 'agent-7',
    label: 'checkout-bot',
    runId: 'run-1',
    takeable: true,
    acquiredAt: 100,
    expiresAt: 200,
  }

  function appWithHeldBy(db: Db, heldByOf: (deviceId: string) => typeof holder | null) {
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const lifecycle = createDeviceLifecycle({ db, leases: fakeLeases(), log: createLogger('test') })
    return createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      heldByOf,
      broadcast: () => {},
    })
  }

  test('a held device carries heldBy on the list endpoint; an unheld one carries null', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    const app = appWithHeldBy(db, (deviceId) => (deviceId === 'a' ? holder : null))

    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; heldBy: unknown }> }
    const a = body.items.find((d) => d.id === 'a')!
    const b = body.items.find((d) => d.id === 'b')!
    expect(a.heldBy).toEqual(holder)
    expect(b.heldBy).toBeNull()
  })

  test('the single-device endpoint carries the same heldBy', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    const app = appWithHeldBy(db, () => holder)

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { heldBy: unknown } }
    expect(body.device.heldBy).toEqual(holder)
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

/**
 * Security fix (plan 09 §4.4's `device.owner.set`, never carried into the
 * ACL until now): `PATCH /:id` let any authenticated operator set a
 * device's `ownerId` to themselves or anyone else, with no permission check
 * and no audit trail — defeating the ownership model `canUseDevice`
 * otherwise enforces for lease acquisition, job enqueue, and the adb
 * endpoint. Only the `ownerId` transition is gated; `label`/`settings`
 * stay ordinary operator work.
 */
describe('PATCH /api/devices/:id — ownerId reassignment (security fix, plan 09 §4.4)', () => {
  const patchReq = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('an operator cannot reassign ownerId — 403 auth.forbidden, the row is untouched, and nothing is audited', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ ownerId: 'operator-self' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')

    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.ownerId).toBeNull()
    expect(db.select().from(auditLog).all()).toHaveLength(0)
  })

  test('an operator cannot CLEAR an existing owner\'s ownerId either', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    db.update(devices).set({ ownerId: 'owner-1' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', patchReq({ ownerId: null }))
    expect(res.status).toBe(403)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.ownerId).toBe('owner-1')
  })

  test('an admin CAN reassign ownerId, and it is audited with both the old and the new owner', async () => {
    const { db, app } = makeApp('admin')
    seedDevice(db, 'a')
    db.update(devices).set({ ownerId: 'owner-1' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', patchReq({ ownerId: 'owner-2' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.ownerId).toBe('owner-2')

    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.owner')
    expect(entries[0]!.target).toBe('a')
    expect(entries[0]!.meta).toEqual({ from: 'owner-1', to: 'owner-2' })
  })

  test('no authenticated user is refused (403), same as every other admin-shaped mutation on this router', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ ownerId: 'someone' }))
    expect(res.status).toBe(403)
  })

  test('a PATCH that repeats the CURRENT ownerId is a no-op — not gated, not audited (idempotent)', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    db.update(devices).set({ ownerId: 'owner-1' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', patchReq({ ownerId: 'owner-1' }))
    expect(res.status).toBe(200)
    expect(db.select().from(auditLog).all()).toHaveLength(0)
  })

  test('an operator CAN still patch label/settings on the SAME request when ownerId is left out entirely', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Renamed')
  })
})

/**
 * `PATCH /:id` had NO blanket `requirePermission` at all before this fix —
 * only the targeted `device.owner.set` check on the `ownerId` transition
 * (the describe block above). A caller with no `ownerId` in the body could
 * reach `label`/`settings` with no permission check whatsoever. Now gated on
 * `device.settings`, the same permission every sibling mutation on this
 * router already declares (`PUT /:id/tags`, `PATCH /:id/drivers`, …) — a
 * no-op for who gets in today (both `admin` and `operator` already hold
 * `device.settings`) but not for what the router says it requires.
 */
describe('PATCH /api/devices/:id — blanket device.settings gate (plan 87, mvp-3 Finding 3)', () => {
  const patchReq = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('no authenticated user is refused (403) for a label-only patch — no ownerId in the body at all', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Test Phone')
  })

  test('an admin may still patch label — no lockout', async () => {
    const { db, app } = makeApp('admin')
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Renamed')
  })

  test('an operator (device.settings is an OPERATOR permission) may still patch label — no lockout', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Renamed')
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

/**
 * `POST /:id/monitor/save` had NO permission check at all before this fix
 * (plan 87, mvp-3 Finding 3 — the same "everyone has it anyway" gap `PATCH
 * /:id` had): any authenticated caller could reach it. Now gated on
 * `device.settings`, the same permission its siblings on this router
 * already use.
 */
describe('POST /:id/monitor/save — device.settings gate (plan 87, mvp-3 Finding 3)', () => {
  const saveReq = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('no authenticated user is refused (403)', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', saveReq({ kind: 'logcat', lines: ['x'] }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (device.settings is an OPERATOR permission) may still save — no lockout', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', saveReq({ kind: 'logcat', lines: ['x'] }))
    expect(res.status).toBe(200)
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

/**
 * `PATCH /:id/drivers` had NO `requirePermission` at all before this fix (a
 * security-sweep finding, `packages/core/src/api/devices.ts:549`): any
 * authenticated operator could change a device's transport/display/input/
 * inspector engines. Now gated on `device.settings` — the same OPERATOR
 * permission `PUT /:id/tags`/`PUT /:id/cluster` already use — and audited as
 * `device.drivers`.
 */
describe('PATCH /api/devices/:id/drivers (security fix)', () => {
  function driversRegistry(): RegistryResponse {
    const engine = (id: string, kind: 'transport' | 'display' | 'input' | 'inspector' | 'network') => ({
      id,
      displayName: id,
      kind,
      capabilities: [],
      locks: [],
      requires: [],
      configSchema: {},
      available: true,
    })
    return {
      transports: [engine('adb', 'transport')],
      displays: [engine('scrcpy', 'display')],
      inputs: [engine('adb', 'input')],
      inspectors: [engine('ui-server', 'inspector')],
      networks: [engine('none', 'network')],
      tools: [],
    }
  }
  const driversBody = { transport: 'adb', display: 'scrcpy', input: 'adb', inspection: 'ui-server' }
  const req = () => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(driversBody) })

  test('no authenticated user is refused (403), and the row is untouched', async () => {
    const { db, app } = makeApp(null, { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request('/a/drivers', req())
    expect(res.status).toBe(403)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    // The schema default (`db/schema.ts`) — `driversBody.transport` ('adb') never lands.
    expect(row?.transport).toBe('adb-usb')
  })

  test('an operator (device.settings is an OPERATOR permission) may still change drivers — no lockout', async () => {
    const { db, app } = makeApp('operator', { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request('/a/drivers', req())
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.transport).toBe('adb')
    expect(row?.display).toBe('scrcpy')
  })

  test('a successful change is audited as device.drivers with the before/after engines', async () => {
    const { db, app } = makeApp('admin', { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request('/a/drivers', req())
    expect(res.status).toBe(200)
    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.drivers')
    expect(entries[0]!.target).toBe('a')
    // `seedDevice` never sets these columns explicitly, so the schema's own defaults apply
    // (`db/schema.ts`) — asserted here rather than re-derived, so this test breaks loudly if
    // those defaults ever change.
    expect(entries[0]!.meta).toEqual({ from: { transport: 'adb-usb', display: 'scrcpy', input: 'scrcpy-uhid', inspection: 'ui-server' }, to: driversBody })
  })

  test('an unauthenticated request never even reaches engine-selection validation', async () => {
    // A bogus engine combination would 400 (UNKNOWN_ENGINE) if the request got past auth —
    // asserting 403 here proves the permission check runs FIRST, not merely that some check does.
    const { db, app } = makeApp(null, { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request(
      '/a/drivers',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transport: 'does-not-exist', display: 'x', input: 'x', inspection: 'x' }) },
    )
    expect(res.status).toBe(403)
  })
})

/**
 * `POST /:id/unquarantine` had NO permission check at all before this fix (a
 * security-sweep finding, `packages/core/src/api/devices.ts:561`), while
 * `device.quarantine` is admin-only in `auth/acl.ts`: any authenticated
 * operator could clear a thermal/safety quarantine. Now gated on
 * `device.quarantine` and audited as `device.unquarantine`.
 */
describe('POST /api/devices/:id/unquarantine (security fix)', () => {
  function quarantinedBattery(unquarantined: string[]): () => BatteryMonitor {
    return () => ({
      start: () => {},
      stop: () => {},
      pollOnce: async () => {},
      unquarantine: (deviceId: string) => {
        unquarantined.push(deviceId)
        return true
      },
    })
  }

  test('an operator is refused (403) — device.quarantine is admin-only — and unquarantine is never called', async () => {
    const calls: string[] = []
    const { db, app } = makeApp('operator', { battery: quarantinedBattery(calls) })
    seedDevice(db, 'a')
    const res = await app.request('/a/unquarantine', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
    expect(db.select().from(auditLog).all()).toHaveLength(0)
  })

  test('no authenticated user is refused (403)', async () => {
    const calls: string[] = []
    const { db, app } = makeApp(null, { battery: quarantinedBattery(calls) })
    seedDevice(db, 'a')
    const res = await app.request('/a/unquarantine', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an admin CAN unquarantine, and it is audited', async () => {
    const calls: string[] = []
    const { db, app } = makeApp('admin', { battery: quarantinedBattery(calls) })
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'quarantined', quarantineReason: 'overheating' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a/unquarantine', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['a'])

    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.unquarantine')
    expect(entries[0]!.target).toBe('a')
    expect(entries[0]!.meta).toEqual({ reason: 'overheating' })
  })
})

describe('POST /rescan (plan 85 §3.3, §4.4, §4.6, §5 step 85.2)', () => {
  const sampleReport: ReconcileReport = {
    seen: 5,
    adopted: ['SER1'],
    dropped: [],
    offline: [],
    unauthorized: [],
    reconnectIssued: false,
    retriesPending: 0,
  }

  test('returns the reconciler\'s report and audits the action', async () => {
    const { app, db } = makeApp('admin', { rescan: async () => sampleReport })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(sampleReport)
    const entries = db.select().from(auditLog).all()
    expect(entries.some((e) => e.action === 'device.rescan')).toBe(true)
  })

  test('is refused with no authenticated user, same as every other admin-style device mutation here', async () => {
    const { app } = makeApp(null, { rescan: async () => sampleReport })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an operator (device.settings is an OPERATOR permission) may still rescan', async () => {
    const { app } = makeApp('operator', { rescan: async () => sampleReport })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('refuses E_NOT_SUPPORTED when no reconciler is wired (orchestrator mode, or adb never came up)', async () => {
    const { app } = makeApp('admin')
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('also refuses E_NOT_SUPPORTED when the accessor itself resolves to null (the forward-ref default before boot assigns it)', async () => {
    const { app } = makeApp('admin', { rescan: () => null })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(501)
  })
})

describe('POST /scan (plan 88 §3.5, §4.5, §4.6, §5 step 88.3)', () => {
  const sampleReport: SweepReport = {
    networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', addresses: 256 }],
    scanned: 251,
    skipped: 3,
    answered: 2,
    connected: 2,
    identified: 2,
    adopted: ['SER1'],
    discovered: ['SER2'],
    conflicts: [],
    durationMs: 1234,
  }

  test('returns the sweeper\'s report and audits it (as device.rescan, meta.via: "scan" — see the route\'s own comment)', async () => {
    const { app, db } = makeApp('admin', { sweeper: { sweep: async () => sampleReport } })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(sampleReport)
    const entries = db.select().from(auditLog).all()
    const entry = entries.find((e) => e.action === 'device.rescan' && (e.meta as { via?: string } | null)?.via === 'scan')
    expect(entry).toBeDefined()
  })

  test('is refused with no authenticated user, same as every other admin-style device mutation here', async () => {
    const { app } = makeApp(null, { sweeper: { sweep: async () => sampleReport } })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an operator (device.settings is an OPERATOR permission) may still trigger a scan', async () => {
    const { app } = makeApp('operator', { sweeper: { sweep: async () => sampleReport } })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('refuses E_NOT_SUPPORTED when no sweeper is wired (orchestrator mode, or the adb subsystem is not ready)', async () => {
    const { app } = makeApp('admin')
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('a sweeper that rejects E_SCAN_BUSY surfaces as 409, not a 500', async () => {
    const { app } = makeApp('admin', {
      sweeper: {
        sweep: async () => {
          throw new EnkakuError('E_SCAN_BUSY', 'a sweep is already running')
        },
      },
    })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_SCAN_BUSY')
  })

  test('a sweeper that rejects E_SCAN_UNAVAILABLE surfaces as 409, not a 500', async () => {
    const { app } = makeApp('admin', {
      sweeper: {
        sweep: async () => {
          throw new EnkakuError('E_SCAN_UNAVAILABLE', 'no scannable network is configured')
        },
      },
    })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_SCAN_UNAVAILABLE')
  })
})

describe('DELETE /api/devices/:id — Forget (plan 47 §4.4, §6)', () => {
  test('an offline device is forgotten: 200, gone from the list, a device.removed broadcast, an audit entry', async () => {
    const { db, app, broadcast } = makeApp()
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      forgotten: { deviceId: string; stableId: string; historyDeleted: boolean; counts: unknown; kvDeleted: number }
    }
    // `kvDeleted: 0` — this test's `makeApp()` wires no `kv` dependency into `createDeviceLifecycle`
    // (plan 79 §3.3, §4.6); the kv store's own lifecycle integration is covered directly in
    // `device/lifecycle.test.ts`.
    expect(body.forgotten).toEqual({ deviceId: 'a', stableId: 'stable-a', historyDeleted: false, counts: null, kvDeleted: 0 })

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
