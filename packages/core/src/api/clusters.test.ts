import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ConnectionMedium } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { clusters, devices } from '../db/schema'
import type { DeviceActivityState, FarmNetwork } from '../registry/device-registry'
import { allocateDeviceNumber } from '../registry/device-number'
import { createClusterRoutes } from './clusters'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'

function seedDevice(db: Db, id: string, clusterId: string | null = null): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'online', clusterId })
    .run()
}

/** Seeds a device whose serial is already `host:port`-shaped — `deriveConnection`'s ONLY signal for `kind: 'tcp'` (plan 88 §3.1). `seedDevice` alone always seeds a USB-shaped serial. */
function seedTcpDevice(db: Db, id: string, clusterId: string | null = null, address = '10.0.0.5:5555'): void {
  seedDevice(db, id, clusterId)
  db.update(devices).set({ serial: address }).where(eq(devices.id, id)).run()
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

function makeApp(
  db: Db,
  role: 'admin' | 'operator' | null = 'admin',
  opts: {
    networks?: FarmNetwork[]
    declaredMedia?: Map<string, ConnectionMedium | null>
    activitiesOf?: (deviceId: string) => DeviceActivityState
  } = {},
) {
  const audit = createAuditLogger(db)
  return withUser(
    role,
    createClusterRoutes({
      db,
      audit,
      ...(opts.networks ? { networks: () => opts.networks! } : {}),
      ...(opts.declaredMedia ? { declaredMedia: () => opts.declaredMedia } : {}),
      ...(opts.activitiesOf ? { activitiesOf: opts.activitiesOf } : {}),
    }),
  )
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

/**
 * Plan 89 §3.1, §3.2, §4.2, §4.3 — this route builds `DeviceInfo` through its
 * own direct `rowToDeviceInfo` call (`api/clusters.ts`), not through
 * `listDevicesWithTags`, so the number has to be threaded here explicitly —
 * the same class of gap plan 88 §5 step 88.5 already found and fixed for
 * `connection.medium` on this exact route (see the describe block above).
 */
describe('GET /api/clusters/:id/devices — number (plan 89 §4.2, §4.3)', () => {
  test('a member device\'s number reads the same as GET /api/devices would', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a', c1)
    allocateDeviceNumber(db, 'stable-a')
    const app = makeApp(db)

    const res = await app.request(`/${c1}/devices`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ id: string; number: number | null }> }
    expect(body.items.find((d) => d.id === 'a')?.number).toBe(1)
  })
})

/**
 * Residual gap left by plan 88 step 88.5's own pass (fixed here): this route
 * called `rowToDeviceInfo(r, tags, cluster, null, null, activityState)` with NEITHER
 * `networks` NOR `declaredMedia` — both defaulted to `[]`/`new Map()`, so a
 * device's connection badge on its own device page (`GET /api/devices/:id`,
 * already fixed) could read `OTG` while the exact same device, viewed
 * through its cluster's device list, read the honest-but-incomplete `TCP`.
 * Proven through the real HTTP route and the real response payload, not
 * `deriveConnection`/`rowToDeviceInfo` in isolation.
 */
describe('GET /api/clusters/:id/devices — connection.medium (plan 88 §3.6, §4.1, residual gap)', () => {
  test('a farm network match badges a member device OTG, not TCP', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedTcpDevice(db, 'a', c1) // 10.0.0.5:5555 — inside the configured /24
    const app = makeApp(db, 'admin', { networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }] })

    const res = await app.request(`/${c1}/devices`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string; connection: { medium: string | null; mediumSource: string; networkLabel: string | null } }>
    }
    const item = body.items.find((d) => d.id === 'a')
    expect(item?.connection).toMatchObject({ medium: 'wired', mediumSource: 'network', networkLabel: 'Chassis A' })
  })

  test('a declared medium wins over a network match', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedTcpDevice(db, 'a', c1)
    const declaredMedia = new Map<string, ConnectionMedium | null>([['stable-a 10.0.0.5:5555', 'wired']])
    const app = makeApp(db, 'admin', {
      networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wireless', scan: true }],
      declaredMedia,
    })

    const res = await app.request(`/${c1}/devices`)
    const body = (await res.json()) as { items: Array<{ id: string; connection: { medium: string | null; mediumSource: string } }> }
    const item = body.items.find((d) => d.id === 'a')
    expect(item?.connection).toMatchObject({ medium: 'wired', mediumSource: 'declared' })
  })

  test('with no networks configured, a member device reads the honest TCP — never a guessed WI-FI', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedTcpDevice(db, 'a', c1)
    const app = makeApp(db)

    const res = await app.request(`/${c1}/devices`)
    const body = (await res.json()) as { items: Array<{ id: string; connection: { medium: string | null; mediumSource: string } }> }
    const item = body.items.find((d) => d.id === 'a')
    expect(item?.connection).toMatchObject({ medium: null, mediumSource: 'unknown' })
  })
})

/**
 * Plan 205 §4.10 — this router's own device list reads `activities`/
 * `lastControl` straight off the SAME `ActivityRegistry` `evaluateActivity`/
 * `touchActivity` read and write, replacing the separate per-holder and
 * per-secondary-operator producer-gap accessors this file used to thread through.
 * Proven through the real HTTP route, the same discipline the
 * `connection.medium` describe block just above already established.
 */
describe('GET /api/clusters/:id/devices — activities (plan 205 §4.10)', () => {
  test('a member device with a live activity reports it; a quiet one reports []', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a', c1)
    seedDevice(db, 'b', c1)
    const activities = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
    activities.start('a', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const app = makeApp(db, 'admin', { activitiesOf: (deviceId) => ({ activities: activities.list(deviceId), lastControl: activities.lastControl(deviceId) }) })

    const res = await app.request(`/${c1}/devices`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ id: string; activities: unknown[] }> }
    expect(body.items.find((d) => d.id === 'a')?.activities).toMatchObject([{ kind: 'job' }])
    expect(body.items.find((d) => d.id === 'b')?.activities).toEqual([])
  })

  test('an omitted activitiesOf dep falls back to [] rather than throwing or guessing', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a', c1)
    const app = makeApp(db)

    const res = await app.request(`/${c1}/devices`)
    const body = (await res.json()) as { items: Array<{ id: string; activities: unknown[] }> }
    expect(body.items.find((d) => d.id === 'a')?.activities).toEqual([])
  })

  /**
   * The two tests above prove `createClusterRoutes` correctly threads
   * whatever `activitiesOf` it is handed; this one drives the SAME
   * `touchControl` a real WS `input.tap` would (through the registry
   * itself, not a hand-rolled seed), then checks the route sees the marker
   * it created — the mechanism under test is the production wiring end to
   * end, not a fake array.
   */
  test('a control marker touched through the registry reaches GET /api/clusters/:id/devices', async () => {
    const db = setUp()
    const [c1] = seed(db, 1)
    seedDevice(db, 'a', c1)
    const activities = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
    activities.touchControl('a', 'user:u1', { kind: 'user', id: 'other-operator', label: 'other-operator' })

    const app = makeApp(db, 'admin', { activitiesOf: (deviceId) => ({ activities: activities.list(deviceId), lastControl: activities.lastControl(deviceId) }) })
    const res = await app.request(`/${c1}/devices`)
    const body = (await res.json()) as { items: Array<{ id: string; activities: Array<{ kind: string; actor: { kind: string; id: string } }> }> }
    const found = body.items.find((d) => d.id === 'a')?.activities
    expect(found).toHaveLength(1)
    expect(found?.[0]).toMatchObject({ kind: 'control', actor: { kind: 'user', id: 'other-operator' } })
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
