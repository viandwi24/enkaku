import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PluginDataCountResponseSchema, PluginDataEntryResponseSchema, PluginDataListResponseSchema, PluginDataScanResponseSchema } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createKvStore, type KvStore } from '../kv/store'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createPluginRuntime, type PluginRuntime } from '../plugins/runtime'
import { setDeviceNumber } from '../registry/device-number'
import type { VerifyReport } from '../plugins/verify-child'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
import { createKvRoutes } from './kv'
import { createPluginRoutes } from './plugins'

/**
 * Step 108.4 — `/api/plugins/:name/data/*`. Everything here runs against a
 * REAL `Db` and a REAL `KvStore` (the setup style of `kv.test.ts`), because
 * the two claims these routes make — the namespace is forced, and a secret
 * never leaves — are claims about what actually reaches SQLite, not about
 * what a mock was told.
 */

function withRole(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u1@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function healthyReport(): VerifyReport {
  return { ok: true, version: '1.0.0', scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: null }], resetPackages: [] }
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-data-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

interface Harness {
  db: Db
  kv: KvStore
  runtime: PluginRuntime
  app: Hono<AuthEnv>
  kvApp: Hono<AuthEnv>
}

function setUp(role: 'admin' | 'operator' | null = 'operator'): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify: async () => healthyReport() })
  const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 10_000_000 }))
  const audit = createAuditLogger(db)
  const app = withRole(role, createPluginRoutes({ runtime, audit, workspace, data: { db, kv } }))
  const kvApp = withRole(role, createKvRoutes({ store: kv, audit }))
  return { db, kv, runtime, app, kvApp }
}

/** Stage → verify → activate, so `runtime.active(name)` answers and the data routes are reachable. */
async function activate(runtime: PluginRuntime, name: string): Promise<void> {
  const staged = await runtime.stage({ name, version: '1.0.0', bundle: 'export {}' })
  await runtime.verify(staged.id)
  runtime.activate(staged.id)
}

function seedDevice(db: Db, n: number, over: { clusterId?: string | null } = {}): { id: string; stableId: string } {
  const id = `d${String(n).padStart(4, '0')}`
  const stableId = `s${String(n).padStart(4, '0')}`
  db.insert(devices)
    .values({ id, stableId, serial: `ser-${n}`, label: `Pixel ${n}`, status: 'idle', clusterId: over.clusterId ?? null })
    .run()
  return { id, stableId }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

async function putEntry(app: Hono<AuthEnv>, name: string, body: unknown): Promise<Response> {
  return app.request(`/${name}/data/entry`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('the five data routes, happy path', () => {
  test('PUT then GET /:name/data lists the plugin\'s own namespace', async () => {
    const { app, runtime } = setUp()
    await activate(runtime, 'tiktok')

    const put = await putEntry(app, 'tiktok', { scope: 'global', key: 'catalogue', value: { rows: 2 } })
    expect(put.status).toBe(200)
    const written = PluginDataEntryResponseSchema.parse(await put.json())
    expect(written.key).toBe('catalogue')
    expect(written.value).toEqual({ rows: 2 })
    expect(written.version).toBe(1)

    const list = await app.request('/tiktok/data?scope=global')
    expect(list.status).toBe(200)
    const page = PluginDataListResponseSchema.parse(await list.json())
    expect(page.items.map((i) => i.key)).toEqual(['catalogue'])
  })

  test('PUT with ifVersion overwrites; a stale ifVersion is 409 E_STALE', async () => {
    const { app, runtime } = setUp()
    await activate(runtime, 'tiktok')
    await putEntry(app, 'tiktok', { scope: 'global', key: 'k', value: 'v1' })

    const ok = await putEntry(app, 'tiktok', { scope: 'global', key: 'k', value: 'v2', ifVersion: 1 })
    expect(ok.status).toBe(200)
    expect((await jsonBody(ok)).version).toBe(2)

    const stale = await putEntry(app, 'tiktok', { scope: 'global', key: 'k', value: 'v3', ifVersion: 1 })
    expect(stale.status).toBe(409)
    expect(((await jsonBody(stale)).error as { code: string }).code).toBe('E_STALE')
  })

  test('DELETE accepts a query and a body, and reports ok:false the second time', async () => {
    const { app, runtime } = setUp()
    await activate(runtime, 'tiktok')
    await putEntry(app, 'tiktok', { scope: 'global', key: 'a', value: 1 })
    await putEntry(app, 'tiktok', { scope: 'global', key: 'b', value: 1 })

    const byQuery = await app.request('/tiktok/data/entry?scope=global&key=a', { method: 'DELETE' })
    expect(await jsonBody(byQuery)).toEqual({ ok: true })

    const byBody = await app.request('/tiktok/data/entry', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', key: 'b' }),
    })
    expect(await jsonBody(byBody)).toEqual({ ok: true })

    const again = await app.request('/tiktok/data/entry?scope=global&key=a', { method: 'DELETE' })
    expect(await jsonBody(again)).toEqual({ ok: false })
  })

  test('device-scoped writes need a stableId, and land under that device', async () => {
    const { app, runtime, db, kv } = setUp()
    await activate(runtime, 'tiktok')
    const d = seedDevice(db, 1)

    const missing = await putEntry(app, 'tiktok', { scope: 'device', key: 'accounts', value: ['a'] })
    expect(missing.status).toBe(400)

    const ok = await putEntry(app, 'tiktok', { scope: 'device', stableId: d.stableId, key: 'accounts', value: ['a'] })
    expect(ok.status).toBe(200)
    expect(kv.get({ kind: 'device', stableId: d.stableId }, 'tiktok', 'accounts')?.value).toEqual(['a'])
  })

  test('GET /:name/data/count returns real global and device counts', async () => {
    const { app, runtime, db } = setUp()
    await activate(runtime, 'tiktok')
    const d1 = seedDevice(db, 1)
    const d2 = seedDevice(db, 2)
    await putEntry(app, 'tiktok', { scope: 'global', key: 'catalogue', value: 1 })
    await putEntry(app, 'tiktok', { scope: 'global', key: 'settings', value: 1 })
    await putEntry(app, 'tiktok', { scope: 'device', stableId: d1.stableId, key: 'accounts', value: 1 })
    await putEntry(app, 'tiktok', { scope: 'device', stableId: d2.stableId, key: 'accounts', value: 1 })
    await putEntry(app, 'tiktok', { scope: 'device', stableId: d2.stableId, key: 'other', value: 1 })

    const res = await app.request('/tiktok/data/count')
    expect(res.status).toBe(200)
    expect(PluginDataCountResponseSchema.parse(await res.json())).toEqual({ global: 2, device: 3 })
  })

  test('another plugin\'s entries never reach this plugin\'s count or list', async () => {
    const { app, runtime, kv, db } = setUp()
    await activate(runtime, 'tiktok')
    await activate(runtime, 'shopee')
    const d = seedDevice(db, 1)
    kv.set({ kind: 'global' }, 'shopee', 'catalogue', 'not mine')
    kv.set({ kind: 'device', stableId: d.stableId }, 'shopee', 'accounts', 'not mine either')

    expect(await jsonBody(await app.request('/tiktok/data/count'))).toEqual({ global: 0, device: 0 })
    const page = PluginDataListResponseSchema.parse(await (await app.request('/tiktok/data?scope=global')).json())
    expect(page.items).toEqual([])
  })

  test('GET /:name/data/scan returns one row per device, joined to the key', async () => {
    const { app, runtime, db, kv } = setUp()
    await activate(runtime, 'tiktok')
    const d1 = seedDevice(db, 1, { clusterId: 'c1' })
    seedDevice(db, 2)
    kv.set({ kind: 'device', stableId: d1.stableId }, 'tiktok', 'accounts', ['alice'])

    const res = await app.request('/tiktok/data/scan?key=accounts')
    expect(res.status).toBe(200)
    const body = PluginDataScanResponseSchema.parse(await res.json())
    expect(body.items.length).toBe(2)
    expect(body.items[0]?.entry?.value).toEqual(['alice'])
    expect(body.items[0]?.clusterId).toBe('c1')
    // A device with no entry is still a row — that is what the LEFT JOIN buys.
    expect(body.items[1]?.entry).toBeNull()
    expect(body.nextCursor).toBeNull()
  })

  test('GET /:name/data/scan without a key is 400', async () => {
    const { app, runtime } = setUp()
    await activate(runtime, 'tiktok')
    expect((await app.request('/tiktok/data/scan')).status).toBe(400)
  })
})

describe('plugin.data is an operator permission, and does NOT widen kv.manage', () => {
  test('an operator succeeds on /:name/data/* and is refused by /api/kv (both asserted)', async () => {
    const { app, kvApp, runtime } = setUp('operator')
    await activate(runtime, 'tiktok')

    expect((await putEntry(app, 'tiktok', { scope: 'global', key: 'k', value: 'v' })).status).toBe(200)
    expect((await app.request('/tiktok/data?scope=global')).status).toBe(200)
    expect((await app.request('/tiktok/data/count')).status).toBe(200)
    expect((await app.request('/tiktok/data/scan?key=k')).status).toBe(200)
    expect((await app.request('/tiktok/data/entry?scope=global&key=k', { method: 'DELETE' })).status).toBe(200)

    // The SAME operator, the SAME store, through the admin-only surface: still refused.
    expect((await kvApp.request('/?scope=global&namespace=tiktok')).status).toBe(403)
    expect((await kvApp.request('/entry?scope=global&namespace=tiktok&key=k')).status).toBe(403)
    expect(
      (
        await kvApp.request('/entry', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'global', namespace: 'tiktok', key: 'k', value: 'v' }),
        })
      ).status,
    ).toBe(403)
  })

  test('an anonymous caller is refused with 403 on every data route', async () => {
    const { app, runtime } = setUp(null)
    await activate(runtime, 'tiktok')
    expect((await app.request('/tiktok/data?scope=global')).status).toBe(403)
    expect((await app.request('/tiktok/data/count')).status).toBe(403)
    expect((await app.request('/tiktok/data/scan?key=k')).status).toBe(403)
    expect((await putEntry(app, 'tiktok', { scope: 'global', key: 'k', value: 'v' })).status).toBe(403)
    expect((await app.request('/tiktok/data/entry?scope=global&key=k', { method: 'DELETE' })).status).toBe(403)
  })
})

describe('the namespace is forced from :name — no request shape reaches another one', () => {
  test('a plugin name that is not live is refused with 404 plugin_not_found', async () => {
    const { app, runtime, kv } = setUp()
    await activate(runtime, 'tiktok')
    kv.set({ kind: 'global' }, 'ghost', 'k', 'someone else\'s data')

    for (const path of ['/ghost/data?scope=global', '/ghost/data/count', '/ghost/data/scan?key=k']) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(((await jsonBody(res)).error as { code: string }).code).toBe('plugin_not_found')
    }
    expect((await putEntry(app, 'ghost', { scope: 'global', key: 'k', value: 'v' })).status).toBe(404)
    expect((await app.request('/ghost/data/entry?scope=global&key=k', { method: 'DELETE' })).status).toBe(404)
    // Refused means untouched: the pre-existing value is still there, unread and unwritten.
    expect(kv.get({ kind: 'global' }, 'ghost', 'k')?.value).toBe('someone else\'s data')
  })

  test('traversal- and absolute-looking names are refused, never resolved', async () => {
    const { app, runtime, kv } = setUp()
    await activate(runtime, 'tiktok')
    kv.set({ kind: 'global' }, 'tiktok', 'k', 'mine')

    const hostile = [
      '/..%2Ftiktok/data?scope=global',
      '/%2E%2E%2Ftiktok/data?scope=global',
      '/..%2F..%2Ftiktok/data/count',
      '/%2Ftiktok/data?scope=global',
      '/%2Fetc%2Fpasswd/data?scope=global',
      '/tiktok%00/data?scope=global',
      '/TIKTOK/data?scope=global',
    ]
    for (const path of hostile) {
      const res = await app.request(path)
      // Never 200: either the router does not match it at all, or the live-plugin guard refuses it.
      expect(res.status).not.toBe(200)
    }
    // The control: the honest spelling of the same route, on the same app, does answer — so the
    // seven refusals above are the guard doing its job, not the harness being broken.
    expect((await app.request('/tiktok/data?scope=global')).status).toBe(200)
  })

  test('a `namespace` in the write body is dropped, not honoured', async () => {
    const { app, runtime, kv } = setUp()
    await activate(runtime, 'tiktok')
    await activate(runtime, 'shopee')

    const res = await putEntry(app, 'tiktok', { scope: 'global', namespace: 'shopee', key: 'k', value: 'hijacked' })
    expect(res.status).toBe(200)
    expect(kv.get({ kind: 'global' }, 'tiktok', 'k')?.value).toBe('hijacked')
    expect(kv.get({ kind: 'global' }, 'shopee', 'k')).toBeNull()
  })

  test('a `namespace` on the list/delete query is ignored', async () => {
    const { app, runtime, kv } = setUp()
    await activate(runtime, 'tiktok')
    await activate(runtime, 'shopee')
    kv.set({ kind: 'global' }, 'shopee', 'secretish', 'shopee value')
    kv.set({ kind: 'global' }, 'tiktok', 'mine', 'tiktok value')

    const page = PluginDataListResponseSchema.parse(await (await app.request('/tiktok/data?scope=global&namespace=shopee')).json())
    expect(page.items.map((i) => i.key)).toEqual(['mine'])

    const del = await app.request('/tiktok/data/entry?scope=global&namespace=shopee&key=secretish', { method: 'DELETE' })
    expect(await jsonBody(del)).toEqual({ ok: false })
    expect(kv.get({ kind: 'global' }, 'shopee', 'secretish')?.value).toBe('shopee value')
  })

  test('a dev slot alone makes a name live (no active version needed)', async () => {
    const { app, runtime } = setUp()
    const report = await runtime.putDevSlot({ name: 'tiktok', owner: { kind: 'cli', label: 'u1@host' }, source: { kind: 'bundle', bundle: 'export {}' } })
    expect(report.ok).toBe(true)
    expect(runtime.active('tiktok')).toBeNull()
    expect((await app.request('/tiktok/data?scope=global')).status).toBe(200)
  })
})

describe('a secret is never returned with its value, on every route that can return one', () => {
  const SECRET = 'sk-plugin-real-secret-value-abcdef'

  test('PUT echo, list, and scan all redact', async () => {
    const { app, runtime, db } = setUp()
    await activate(runtime, 'tiktok')
    const d = seedDevice(db, 1)

    const put = await putEntry(app, 'tiktok', { scope: 'global', key: 'token', value: SECRET, secret: true })
    const written = await jsonBody(put)
    expect(written.value).toBeNull()
    expect(written.secret).toBe(true)
    expect(written.hint).not.toBeNull()
    expect(JSON.stringify(written)).not.toContain(SECRET)

    const list = await jsonBody(await app.request('/tiktok/data?scope=global'))
    expect(JSON.stringify(list)).not.toContain(SECRET)
    expect((list.items as { value: unknown }[])[0]?.value).toBeNull()

    await putEntry(app, 'tiktok', { scope: 'device', stableId: d.stableId, key: 'token', value: SECRET, secret: true })
    const scan = await jsonBody(await app.request('/tiktok/data/scan?key=token'))
    expect(JSON.stringify(scan)).not.toContain(SECRET)
    const row = (scan.items as { entry: { value: unknown; secret: boolean; hint: string | null } | null }[])[0]
    expect(row?.entry?.value).toBeNull()
    expect(row?.entry?.secret).toBe(true)
    expect(row?.entry?.hint).not.toBeNull()
  })

  test('the audit trail never carries the plaintext either', async () => {
    const { app, runtime, db } = setUp()
    await activate(runtime, 'tiktok')
    await putEntry(app, 'tiktok', { scope: 'global', key: 'token', value: SECRET, secret: true })
    await app.request('/tiktok/data/entry?scope=global&key=token', { method: 'DELETE' })
    const audit = createAuditLogger(db)
    const entries = audit.list(20)
    expect(entries.some((e) => e.action === 'plugin.data.set')).toBe(true)
    expect(entries.some((e) => e.action === 'plugin.data.delete')).toBe(true)
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })
})

describe('GET /:name/data/scan — the allowlist, paging, and the N+1 tripwire', () => {
  test('exposes exactly the six allowlisted device fields and no others', async () => {
    const { app, runtime, db, kv } = setUp()
    await activate(runtime, 'tiktok')
    const d = seedDevice(db, 1, { clusterId: 'c1' })
    kv.set({ kind: 'device', stableId: d.stableId }, 'tiktok', 'accounts', ['alice'])

    const body = await jsonBody(await app.request('/tiktok/data/scan?key=accounts'))
    const row = (body.items as Record<string, unknown>[])[0]
    expect(row).toBeDefined()
    expect(Object.keys(row as Record<string, unknown>).sort()).toEqual(['clusterId', 'deviceId', 'entry', 'label', 'number', 'stableId', 'status'])
    // The columns a device row actually has but a view may never see (§3.6).
    for (const forbidden of ['serial', 'ownerId', 'settings', 'battery', 'nodeId', 'agent', 'preparation', 'networkRoute']) {
      expect(Object.keys(row as Record<string, unknown>)).not.toContain(forbidden)
    }
  })

  /**
   * The device NUMBER (plan 108 §3.6, extended) — the sixth allowlisted field.
   * It lives in its own table, keyed on `stableId`, and is LEFT JOINed by the
   * same statement, so "this device has no number yet" must read as `null`
   * rather than as a missing row or a 500.
   */
  test('number comes from device_numbers for a device that has one, and is null for one that does not', async () => {
    const { app, runtime, db, kv } = setUp()
    await activate(runtime, 'tiktok')
    const d1 = seedDevice(db, 1)
    const d2 = seedDevice(db, 2)
    setDeviceNumber(db, d1.stableId, 7, { userId: 'u1' })
    kv.set({ kind: 'device', stableId: d2.stableId }, 'tiktok', 'accounts', ['alice'])

    const body = PluginDataScanResponseSchema.parse(await (await app.request('/tiktok/data/scan?key=accounts')).json())
    expect(body.items.map((i) => [i.stableId, i.number])).toEqual([
      [d1.stableId, 7],
      [d2.stableId, null],
    ])
    // A number is device identity, never a property of the entry: the device WITHOUT the key still
    // reports its number, and the device WITH the key still reports null when it has none.
    expect(body.items[0]?.entry).toBeNull()
    expect(body.items[1]?.entry?.value).toEqual(['alice'])
  })

  test('pages by stableId with an opaque cursor, covering every device exactly once', async () => {
    const { app, runtime, db, kv } = setUp()
    await activate(runtime, 'tiktok')
    for (let i = 1; i <= 7; i++) {
      const d = seedDevice(db, i)
      if (i % 2 === 1) kv.set({ kind: 'device', stableId: d.stableId }, 'tiktok', 'accounts', [`u${i}`])
    }

    const seen: string[] = []
    let cursor: string | null = null
    let guard = 0
    do {
      const url: string = `/tiktok/data/scan?key=accounts&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = PluginDataScanResponseSchema.parse(await (await app.request(url)).json())
      seen.push(...page.items.map((i) => i.stableId))
      cursor = page.nextCursor
      guard++
    } while (cursor && guard < 10)

    expect(seen).toEqual(['s0001', 's0002', 's0003', 's0004', 's0005', 's0006', 's0007'])
    expect(new Set(seen).size).toBe(7)
  })

  test('~200 devices scan in one statement, well under a second (an N+1 regression tripwire)', async () => {
    const { app, runtime, db, kv } = setUp()
    await activate(runtime, 'tiktok')
    for (let i = 1; i <= 200; i++) {
      const d = seedDevice(db, i)
      if (i % 3 === 0) kv.set({ kind: 'device', stableId: d.stableId }, 'tiktok', 'accounts', [`u${i}`])
      // Half the fleet also holds a NUMBER, so the second LEFT JOIN is really exercised here rather
      // than short-circuited by an empty table — a per-device `lookupDeviceNumber` would show up in
      // exactly the same budget the entry join is held to.
      if (i % 2 === 0) setDeviceNumber(db, d.stableId, i, { userId: null })
    }

    const started = performance.now()
    const res = await app.request('/tiktok/data/scan?key=accounts&limit=200')
    const body = PluginDataScanResponseSchema.parse(await res.json())
    const elapsed = performance.now() - started

    expect(body.items.length).toBe(200)
    expect(body.items.filter((i) => i.entry !== null).length).toBe(66)
    expect(body.items.filter((i) => i.number !== null).length).toBe(100)
    // A per-device `kv.get` loop would put this in the hundreds of ms even on SQLite in memory,
    // and worse the moment the join is done in JS. One statement lands in single-digit ms.
    expect(elapsed).toBeLessThan(500)
  })

  test('an expired entry reads as absent in the scan and in the count', async () => {
    const { app, runtime, db, kv } = setUp()
    await activate(runtime, 'tiktok')
    const d = seedDevice(db, 1)
    // A TTL already in the past, rather than sleeping for one to elapse.
    kv.set({ kind: 'device', stableId: d.stableId }, 'tiktok', 'accounts', ['gone'], { ttlSec: -1 })

    const body = PluginDataScanResponseSchema.parse(await (await app.request('/tiktok/data/scan?key=accounts')).json())
    expect(body.items[0]?.entry).toBeNull()
    expect(await jsonBody(await app.request('/tiktok/data/count'))).toEqual({ global: 0, device: 0 })
  })
})
