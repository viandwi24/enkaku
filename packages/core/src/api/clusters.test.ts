import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { clusters, devices } from '../db/schema'
import { createClusterRoutes } from './clusters'

function seedDevice(db: Db, id: string, clusterId: string | null = null): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'idle', clusterId })
    .run()
}

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/**
 * Every mutating route below now requires `device.settings` (plan 34 §4.4,
 * §4.5) — an admin user by default, matching what these pre-existing tests
 * already assumed implicitly. The `requirePermission` wiring itself is
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

function makeApp(db: Db, role: 'admin' | 'operator' | null = 'admin') {
  const audit = createAuditLogger(db)
  return withUser(role, createClusterRoutes({ db, audit }))
}

let seq = 0
function seed(db: Db, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `cluster-${String(++seq).padStart(4, '0')}`
    ids.push(id)
    db.insert(clusters)
      .values({ id, name: `pool-${i}`, description: null, createdAt: new Date((base + i) * 1000) })
      .run()
  }
  return ids
}

describe('GET /api/clusters keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', async () => {
    const db = setUp()
    const ids = seed(db, 5)
    const app = makeApp(db)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor ? `/?limit=2&cursor=${encodeURIComponent(cursor)}` : '/?limit=2'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null; total: number | null }
      for (const cl of body.items) {
        expect(seen.has(cl.id)).toBe(false)
        seen.add(cl.id)
      }
      expect(body.total).toBe(5)
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a row inserted mid-paging is never skipped or repeated', async () => {
    const db = setUp()
    seed(db, 4)
    const app = makeApp(db)

    const first = await app.request('/?limit=2')
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    seed(db, 1)
    const second = await app.request(`/?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
    const secondBody = (await second.json()) as { items: Array<{ id: string }> }
    const overlap = secondBody.items.filter((cl) => firstBody.items.some((f) => f.id === cl.id))
    expect(overlap).toHaveLength(0)
  })

  test('a malformed cursor returns 400', async () => {
    const db = setUp()
    const app = makeApp(db)
    const res = await app.request('/?cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })
})

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('POST /api/clusters/:id/devices (plan 22.0 §4.4, acceptance #2)', () => {
  test('assigns devices and reports what each moved from', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    const app = makeApp(db)

    const res = await app.request(`/${c1}/devices`, json({ deviceIds: ['a', 'b'] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { moved: Array<{ deviceId: string; from: string | null }> }
    expect(body.moved.sort((x, y) => x.deviceId.localeCompare(y.deviceId))).toEqual([
      { deviceId: 'a', from: null },
      { deviceId: 'b', from: null },
    ])
  })

  test('an unknown device id 404s and assigns nothing', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a')
    const app = makeApp(db)

    const res = await app.request(`/${c1}/devices`, json({ deviceIds: ['a', 'ghost'] }))
    expect(res.status).toBe(404)
    const a = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(a?.clusterId).toBeNull()
  })

  test('an unknown cluster id 404s', async () => {
    const db = setUp()
    seedDevice(db, 'a')
    const app = makeApp(db)
    const res = await app.request('/ghost/devices', json({ deviceIds: ['a'] }))
    expect(res.status).toBe(404)
  })
})

describe('GET /api/clusters/:id/devices', () => {
  test('lists exactly this cluster\'s members', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a', c1)
    seedDevice(db, 'b', c1)
    seedDevice(db, 'c')
    const app = makeApp(db)

    const res = await app.request(`/${c1}/devices`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ id: string }> }
    expect(body.items.map((d) => d.id).sort()).toEqual(['a', 'b'])
  })
})

describe('DELETE /api/clusters/:id/devices/:deviceId', () => {
  test('unassigns exactly that device, idempotently', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a', c1)
    const app = makeApp(db)

    const res = await app.request(`/${c1}/devices/a`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const a = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(a?.clusterId).toBeNull()

    // Idempotent — removing an already-unassigned device is not an error.
    const again = await app.request(`/${c1}/devices/a`, { method: 'DELETE' })
    expect(again.status).toBe(204)
  })
})

describe('DELETE /api/clusters/:id (plan 22.0 §3.6, acceptance #3)', () => {
  test('unassigns members but deletes no device', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a', c1)
    seedDevice(db, 'b', c1)
    const app = makeApp(db)

    const res = await app.request(`/${c1}`, { method: 'DELETE' })
    expect(res.status).toBe(204)

    const a = db.select().from(devices).where(eq(devices.id, 'a')).get()
    const b = db.select().from(devices).where(eq(devices.id, 'b')).get()
    expect(a).toBeTruthy()
    expect(a?.clusterId).toBeNull()
    expect(b).toBeTruthy()
    expect(b?.clusterId).toBeNull()

    const stillThere = db.select().from(clusters).where(eq(clusters.id, c1!)).get()
    expect(stillThere).toBeUndefined()
  })
})

describe('requirePermission("device.settings") on every cluster mutation (plan 34 §4.4, §4.5, acceptance #7)', () => {
  test('POST / is refused with no authenticated user', async () => {
    const db = setUp()
    const app = makeApp(db, null)
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (device.settings is an OPERATOR permission) may still create a cluster — no lockout', async () => {
    const db = setUp()
    const app = makeApp(db, 'operator')
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    expect(res.status).toBe(201)
  })

  test('POST /:id/devices is refused with no authenticated user', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a')
    const app = makeApp(db, null)
    const res = await app.request(`/${c1}/devices`, json({ deviceIds: ['a'] }))
    expect(res.status).toBe(403)
  })

  test('GET / needs no permission at all — read routes stay open', async () => {
    const db = setUp()
    const app = makeApp(db, null)
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
