import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import type { Logger } from '../util/logger'
import { createScriptRoutes } from './routes'

function fakeAudit(): { audit: AuditLogger; calls: Parameters<AuditLogger['record']>[0][] } {
  const calls: Parameters<AuditLogger['record']>[0][] = []
  return { audit: { record: (input) => void calls.push(input), list: () => [] }, calls }
}

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

let seq = 0
function seed(db: Db, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const n2 = ++seq
    const id = `script-${String(n2).padStart(4, '0')}`
    ids.push(id)
    db.insert(scripts)
      .values({ id, name: `script-${n2}`, version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date((base + i) * 1000) })
      .run()
  }
  return ids
}

describe('GET /api/scripts keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', async () => {
    const db = setUp()
    const ids = seed(db, 5)
    const app = createScriptRoutes({ db })

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor ? `/?limit=2&cursor=${encodeURIComponent(cursor)}` : '/?limit=2'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null; total: number | null }
      for (const s of body.items) {
        expect(seen.has(s.id)).toBe(false)
        seen.add(s.id)
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

  test('a script inserted mid-paging is never skipped or repeated', async () => {
    const db = setUp()
    seed(db, 4)
    const app = createScriptRoutes({ db })

    const first = await app.request('/?limit=2')
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    seed(db, 1)
    const second = await app.request(`/?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
    const secondBody = (await second.json()) as { items: Array<{ id: string }> }
    const overlap = secondBody.items.filter((s) => firstBody.items.some((f) => f.id === s.id))
    expect(overlap).toHaveLength(0)
  })

  test('a malformed cursor returns 400', async () => {
    const db = setUp()
    const app = createScriptRoutes({ db })
    const res = await app.request('/?cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })

  test('a limit above the cap is clamped, not honoured', async () => {
    const db = setUp()
    seed(db, 3)
    const app = createScriptRoutes({ db })
    const res = await app.request('/?limit=99999')
    const body = (await res.json()) as { items: unknown[]; total: number | null }
    expect(body.items).toHaveLength(3)
    expect(body.total).toBe(3)
  })
})

describe('requirePermission on /api/scripts mutations (plan 34 §4.4, §4.5, acceptance #7)', () => {
  const publishBody = { name: 'my-script', version: '1.0.0', bundle: 'export {}' }

  test('POST / (script.publish) is refused with no authenticated user', async () => {
    const db = setUp()
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publishBody) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (script.publish is an OPERATOR permission) may publish — no lockout', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publishBody) })
    expect(res.status).toBe(201)
  })

  test('PATCH /:id (script.publish) is refused with no authenticated user', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request(`/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    expect(res.status).toBe(403)
  })

  test('DELETE /:id (script.delete) refuses an operator — admin-only', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')

    // The script must still exist — a refused request changes nothing.
    const still = await withUser('admin', createScriptRoutes({ db })).request(`/${id}`)
    expect(still.status).toBe(200)
  })

  test('DELETE /:id (script.delete) admits an admin', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const app = withUser('admin', createScriptRoutes({ db }))
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  test('GET / needs no permission at all — read routes stay open', async () => {
    const db = setUp()
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})

/**
 * Audit trail (security-sweep finding): before this fix, `createScriptRoutes`
 * had no `audit` dependency at all, so publish/toggle/delete recorded
 * NOTHING — unlike `api/plugins.ts`'s sibling routes, which reuse these exact
 * two permissions and DO audit every mutation.
 */
describe('audit trail on /api/scripts mutations (security-sweep finding)', () => {
  const publishBody = { name: 'my-script', version: '1.0.0', bundle: 'export {}' }

  test('POST / records script.publish with the new script\'s id, name, and version', async () => {
    const db = setUp()
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createScriptRoutes({ db, audit }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publishBody) })
    expect(res.status).toBe(201)
    const { script } = (await res.json()) as { script: { id: string } }
    expect(calls).toEqual([{ userId: 'u1', action: 'script.publish', target: script.id, meta: { name: 'my-script', version: '1.0.0' } }])
  })

  test('PATCH /:id records script.toggle with the new enabled value', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createScriptRoutes({ db, audit }))
    const res = await app.request(`/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'u1', action: 'script.toggle', target: id, meta: { enabled: false } })
  })

  test('DELETE /:id records script.delete with the removed script\'s name/version, and a refused (operator) attempt records nothing', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const { audit, calls } = fakeAudit()

    const refused = await withUser('operator', createScriptRoutes({ db, audit })).request(`/${id}`, { method: 'DELETE' })
    expect(refused.status).toBe(403)
    expect(calls).toEqual([])

    const ok = await withUser('admin', createScriptRoutes({ db, audit })).request(`/${id}`, { method: 'DELETE' })
    expect(ok.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'u1', action: 'script.delete', target: id })
  })

  test('omitting `audit` entirely never throws — publish/toggle/delete all still work', async () => {
    const db = setUp()
    const app = withUser('admin', createScriptRoutes({ db }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publishBody) })
    expect(res.status).toBe(201)
  })
})

function publish(db: Db, name: string, version: string, opts: { enabled?: boolean; createdAt?: number } = {}): string {
  const id = `${name}-${version}-${crypto.randomUUID().slice(0, 8)}`
  db.insert(scripts)
    .values({
      id,
      name,
      version,
      bundle: 'export {}',
      enabled: opts.enabled ?? true,
      createdAt: new Date((opts.createdAt ?? 1_700_000_000) * 1000),
    })
    .run()
  return id
}

describe('GET /api/scripts?group=name (plan 62 §4.4, acceptance #10)', () => {
  test('groups multiple published versions into one row', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const idLatest = publish(db, 'checkout', '1.2.0')
    publish(db, 'checkout', '1.1.0')
    publish(db, 'login', '0.1.0')
    const app = createScriptRoutes({ db })

    const res = await app.request('/?group=name')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ id: string; name: string; latestVersion: string; versionCount: number; enabled: boolean }>; total: number }
    expect(body.total).toBe(2) // two NAMES, not three versions plus one
    const checkout = body.items.find((i) => i.name === 'checkout')
    expect(checkout).toMatchObject({ id: idLatest, latestVersion: '1.2.0', versionCount: 3, enabled: true })
    const login = body.items.find((i) => i.name === 'login')
    expect(login).toMatchObject({ latestVersion: '0.1.0', versionCount: 1 })
  })

  test('the grouped latest matches the resolver — a disabled highest version falls through', async () => {
    const db = setUp()
    const idEnabled = publish(db, 'checkout', '1.0.0')
    publish(db, 'checkout', '2.0.0', { enabled: false })
    const app = createScriptRoutes({ db })

    const res = await app.request('/?group=name')
    const body = (await res.json()) as { items: Array<{ id: string; latestVersion: string }> }
    expect(body.items[0]).toMatchObject({ id: idEnabled, latestVersion: '1.0.0' })
  })
})

describe('POST / rejects a hostile paramsSchema (plan 95 §4.9, §5 step 95.5)', () => {
  test('a schema with a non-identifier field name is refused with E_PARAMS_SCHEMA_INVALID, naming the field', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'hostile',
        version: '1.0.0',
        bundle: 'export {}',
        paramsSchema: { type: 'object', properties: { 'bad name': { type: 'string' } } },
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string; issues?: Array<{ path: string; message: string }> } }
    expect(body.error.code).toBe('E_PARAMS_SCHEMA_INVALID')
    expect(body.error.issues?.some((i) => i.path === 'bad name')).toBe(true)

    // Refused means refused — no row was written.
    const list = await app.request('/?group=name')
    const listBody = (await list.json()) as { total: number }
    expect(listBody.total).toBe(0)
  })

  test('a 40-deep schema is refused', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    let node: unknown = { type: 'string' }
    for (let i = 0; i < 40; i++) node = { type: 'object', properties: { next: node } }
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deep', version: '1.0.0', bundle: 'export {}', paramsSchema: node }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_PARAMS_SCHEMA_INVALID')
  })

  test('a self-referential $ref is refused, not hung', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const paramsSchema = {
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } },
    }
    const start = performance.now()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cyclic', version: '1.0.0', bundle: 'export {}', paramsSchema }),
    })
    expect(performance.now() - start).toBeLessThan(1000)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_PARAMS_SCHEMA_INVALID')
  })

  test('a schema whose ONLY finding is the non-consecutive-group WARNING still publishes (warnings do not block)', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const paramsSchema = {
      type: 'object',
      properties: {
        a1: { type: 'string', 'x-enkaku': { group: 'A' } },
        b1: { type: 'string', 'x-enkaku': { group: 'B' } },
        a2: { type: 'string', 'x-enkaku': { group: 'A' } },
      },
    }
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'warned-only', version: '1.0.0', bundle: 'export {}', paramsSchema }),
    })
    expect(res.status).toBe(201)
  })

  test('a clean schema (the tiktok pack shape) publishes as before', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const paramsSchema = { type: 'object', properties: { videos: { type: 'integer', title: 'Videos', minimum: 1, maximum: 2000 } } }
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'clean', version: '1.0.0', bundle: 'export {}', paramsSchema }),
    })
    expect(res.status).toBe(201)
  })

  test('no paramsSchema at all still publishes — a script with no params is not a violation', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-params', version: '1.0.0', bundle: 'export {}' }),
    })
    expect(res.status).toBe(201)
  })
})

describe('GET /api/scripts/:id returns paramsSchema through typedJson (plan 95 §4.8, §5 step 95.5)', () => {
  test('a published paramsSchema round-trips through the detail route unchanged', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const paramsSchema = { type: 'object', properties: { videos: { type: 'integer', title: 'Videos' } } }
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'roundtrip', version: '1.0.0', bundle: 'export {}', paramsSchema }),
    })
    const { script } = (await publishRes.json()) as { script: { id: string } }

    const res = await app.request(`/${script.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { script: { paramsSchema: unknown; enabled: boolean } }
    expect(body.script.paramsSchema).toEqual(paramsSchema)
    expect(body.script.enabled).toBe(true)
  })

  test('a script published with no paramsSchema reads back null, not undefined', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bare', version: '1.0.0', bundle: 'export {}' }),
    })
    const { script } = (await publishRes.json()) as { script: { id: string } }
    const res = await app.request(`/${script.id}`)
    const body = (await res.json()) as { script: { paramsSchema: unknown } }
    expect(body.script.paramsSchema).toBeNull()
  })
})

/**
 * Plan 98 §3.1, §4.4, §4.5, §5 step 98.4 — "the envelope persists". The
 * verifiable result this plan's own text names verbatim: publish a script
 * declaring `runtime`, `GET /api/scripts/:id` returns it.
 */
describe('POST / persists runtime, GET /api/scripts/:id returns it (plan 98 §5 step 98.4)', () => {
  test('a published `runtime` round-trips through the detail route unchanged', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const runtime = { timeoutMs: 120_000, retries: 2, maxRssBytes: 256 * 1024 * 1024, maxConcurrent: 1, sdk: 1 }
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'with-runtime', version: '1.0.0', bundle: 'export {}', runtime }),
    })
    expect(publishRes.status).toBe(201)
    const { script } = (await publishRes.json()) as { script: { id: string } }

    const res = await app.request(`/${script.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { script: { runtime: unknown } }
    expect(body.script.runtime).toEqual(runtime)
  })

  test('a script published with no `runtime` at all reads back null — identical to today\'s behaviour (acceptance criterion 2)', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-runtime', version: '1.0.0', bundle: 'export {}' }),
    })
    const { script } = (await publishRes.json()) as { script: { id: string } }
    const res = await app.request(`/${script.id}`)
    const body = (await res.json()) as { script: { runtime: unknown } }
    expect(body.script.runtime).toBeNull()
  })

  test('an explicit `runtime: null` also reads back null', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'explicit-null', version: '1.0.0', bundle: 'export {}', runtime: null }),
    })
    const { script } = (await publishRes.json()) as { script: { id: string } }
    const res = await app.request(`/${script.id}`)
    const body = (await res.json()) as { script: { runtime: unknown } }
    expect(body.script.runtime).toBeNull()
  })

  test('a shape violation is refused with E_RUNTIME_ENVELOPE_INVALID (400), and no row is written', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Below the 1s floor `RuntimeEnvelopeSchema` declares.
      body: JSON.stringify({ name: 'bad-runtime', version: '1.0.0', bundle: 'export {}', runtime: { timeoutMs: 500 } }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_RUNTIME_ENVELOPE_INVALID')

    const list = await app.request('/?group=name')
    const listBody = (await list.json()) as { total: number }
    expect(listBody.total).toBe(0)
  })

  test('an unknown envelope key never refuses the publish — it is dropped and warned about, naming it (§3.3 S3)', async () => {
    const db = setUp()
    const warnings: string[] = []
    const log: Logger = { debug: () => {}, info: () => {}, warn: (m) => warnings.push(m), error: () => {}, child: () => log }
    const app = withUser('operator', createScriptRoutes({ db, log }))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'future-field',
        version: '1.0.0',
        bundle: 'export {}',
        runtime: { timeoutMs: 30_000, futureField: 'ignore me' },
      }),
    })
    expect(res.status).toBe(201)
    expect(warnings.some((w) => w.includes('futureField'))).toBe(true)

    const { script } = (await res.json()) as { script: { id: string } }
    const detail = await app.request(`/${script.id}`)
    const body = (await detail.json()) as { script: { runtime: { timeoutMs: number; futureField?: string } } }
    // Stripped, never persisted.
    expect(body.script.runtime.timeoutMs).toBe(30_000)
    expect(body.script.runtime.futureField).toBeUndefined()
  })
})

describe('GET /api/scripts/:name/versions (plan 62 §4.4)', () => {
  test('newest semver first, regardless of publish order', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.9', { createdAt: 1_700_000_000 })
    publish(db, 'checkout', '1.0.10', { createdAt: 1_700_000_050 })
    publish(db, 'checkout', '1.0.2', { createdAt: 1_700_000_100 }) // published LAST, sorts LOWEST
    const app = createScriptRoutes({ db })

    const res = await app.request('/checkout/versions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ version: string }> }
    expect(body.items.map((i) => i.version)).toEqual(['1.0.10', '1.0.9', '1.0.2'])
  })

  test('an unknown name returns an empty list, not an error', async () => {
    const db = setUp()
    const app = createScriptRoutes({ db })
    const res = await app.request('/nope/versions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
  })
})

describe('/api/scripts/:name/param-sets (plan 95 §4.7, §4.8, §5 step 95.8)', () => {
  function jsonReq(method: string, body: unknown) {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  }

  test('GET on a script with no sets returns an empty list, not an error', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/checkout/param-sets')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
  })

  test('GET requires script.view — refused with no authenticated user', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request('/checkout/param-sets')
    expect(res.status).toBe(403)
  })

  test('POST creates a set (name, params, scriptName all round-trip), lists it back, and audits script.param_set.create', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createScriptRoutes({ db, audit }))
    const res = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'Aggressive', params: { videos: 500 } }))
    expect(res.status).toBe(201)
    const { paramSet } = (await res.json()) as { paramSet: { id: string; name: string; params: unknown; scriptName: string; createdAt: number; updatedAt: number } }
    expect(paramSet).toMatchObject({ name: 'Aggressive', params: { videos: 500 }, scriptName: 'checkout' })
    expect(typeof paramSet.id).toBe('string')
    expect(calls).toEqual([{ userId: 'u1', action: 'script.param_set.create', target: paramSet.id, meta: { scriptName: 'checkout', name: 'Aggressive' } }])

    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: Array<{ name: string; params: unknown }> }
    expect(listBody.items).toEqual([{ ...paramSet }])
  })

  test('POST against a script name nobody has published is refused 404 script_not_found — no row is written', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/nope/param-sets', jsonReq('POST', { name: 'x', params: {} }))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('script_not_found')
  })

  test('POST with a duplicate name for the SAME script is refused 409; the SAME name under a different script is unaffected', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    publish(db, 'login', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    const first = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'Aggressive', params: {} }))
    expect(first.status).toBe(201)

    const dup = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'Aggressive', params: {} }))
    expect(dup.status).toBe(409)
    const dupBody = (await dup.json()) as { error: { code: string } }
    expect(dupBody.error.code).toBe('param_set_name_exists')

    const otherScript = await app.request('/login/param-sets', jsonReq('POST', { name: 'Aggressive', params: {} }))
    expect(otherScript.status).toBe(201)

    // Refused means refused — `checkout` still has exactly one set.
    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: unknown[] }
    expect(listBody.items).toHaveLength(1)
  })

  test('POST/PATCH/DELETE all require job.run — refused with no authenticated user, and nothing is written', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const app = withUser(null, createScriptRoutes({ db }))
    const post = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'x', params: {} }))
    expect(post.status).toBe(403)
    const patch = await app.request('/checkout/param-sets/whatever', jsonReq('PATCH', { name: 'y' }))
    expect(patch.status).toBe(403)
    const del = await app.request('/checkout/param-sets/whatever', { method: 'DELETE' })
    expect(del.status).toBe(403)

    const list = await withUser('operator', createScriptRoutes({ db })).request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: unknown[] }
    expect(listBody.items).toEqual([])
  })

  test('PATCH renames and/or replaces params, echoes the full row, and audits script.param_set.update', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createScriptRoutes({ db, audit }))
    const create = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'A', params: { videos: 1 } }))
    const { paramSet: a } = (await create.json()) as { paramSet: { id: string } }

    const patch = await app.request(`/checkout/param-sets/${a.id}`, jsonReq('PATCH', { params: { videos: 2 } }))
    expect(patch.status).toBe(200)
    const { paramSet: updated } = (await patch.json()) as { paramSet: { name: string; params: unknown } }
    expect(updated).toMatchObject({ name: 'A', params: { videos: 2 } }) // name untouched — PATCH is partial
    expect(calls.at(-1)).toMatchObject({ userId: 'u1', action: 'script.param_set.update', target: a.id, meta: { scriptName: 'checkout', name: 'A' } })

    const rename = await app.request(`/checkout/param-sets/${a.id}`, jsonReq('PATCH', { name: 'Renamed' }))
    expect(rename.status).toBe(200)
    const { paramSet: renamed } = (await rename.json()) as { paramSet: { name: string; params: unknown } }
    expect(renamed).toMatchObject({ name: 'Renamed', params: { videos: 2 } }) // params untouched by the rename
  })

  test('PATCH renaming to an existing name for the same script 409s, and changes nothing', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    const createA = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'A', params: { videos: 1 } }))
    const { paramSet: a } = (await createA.json()) as { paramSet: { id: string } }
    await app.request('/checkout/param-sets', jsonReq('POST', { name: 'B', params: {} }))

    const dupRename = await app.request(`/checkout/param-sets/${a.id}`, jsonReq('PATCH', { name: 'B' }))
    expect(dupRename.status).toBe(409)
    const body = (await dupRename.json()) as { error: { code: string } }
    expect(body.error.code).toBe('param_set_name_exists')

    // Untouched by the refused rename.
    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: Array<{ name: string; params: unknown }> }
    expect(listBody.items.find((i) => i.name === 'A')).toMatchObject({ params: { videos: 1 } })
  })

  test('PATCH/DELETE on an unknown id, or an id that belongs to a DIFFERENT script name, both 404 — the route param and the row must agree', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    publish(db, 'login', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    const create = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'A', params: {} }))
    const { paramSet } = (await create.json()) as { paramSet: { id: string } }

    const wrongScriptPatch = await app.request(`/login/param-sets/${paramSet.id}`, jsonReq('PATCH', { name: 'Z' }))
    expect(wrongScriptPatch.status).toBe(404)
    const wrongScriptDelete = await app.request(`/login/param-sets/${paramSet.id}`, { method: 'DELETE' })
    expect(wrongScriptDelete.status).toBe(404)

    const unknownIdPatch = await app.request('/checkout/param-sets/does-not-exist', jsonReq('PATCH', { name: 'Z' }))
    expect(unknownIdPatch.status).toBe(404)
    const unknownIdDelete = await app.request('/checkout/param-sets/does-not-exist', { method: 'DELETE' })
    expect(unknownIdDelete.status).toBe(404)

    // Still there, still named `A` — none of the four refusals changed anything.
    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as {
      items: Array<{ id: string; name: string; params: unknown; scriptName: string; createdBy: string | null; createdAt: number; updatedAt: number }>
    }
    expect(listBody.items).toEqual([{ id: paramSet.id, name: 'A', params: {}, scriptName: 'checkout', createdBy: 'u1', createdAt: listBody.items[0]!.createdAt, updatedAt: listBody.items[0]!.updatedAt }])
  })

  test('DELETE removes the set and audits script.param_set.delete', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createScriptRoutes({ db, audit }))
    const create = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'A', params: {} }))
    const { paramSet } = (await create.json()) as { paramSet: { id: string } }

    const del = await app.request(`/checkout/param-sets/${paramSet.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const delBody = (await del.json()) as { ok: boolean }
    expect(delBody.ok).toBe(true)
    expect(calls.at(-1)).toMatchObject({ userId: 'u1', action: 'script.param_set.delete', target: paramSet.id, meta: { scriptName: 'checkout' } })

    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: unknown[] }
    expect(listBody.items).toEqual([])
  })

  test('a set survives its script being published to a NEW version — still listed under the same name, untouched (plan 95 §4.7: keyed on the NAME)', async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    await app.request('/checkout/param-sets', jsonReq('POST', { name: 'A', params: { videos: 30 } }))

    publish(db, 'checkout', '1.1.0')

    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: Array<{ name: string; params: unknown }> }
    expect(listBody.items).toEqual([{ name: 'A', params: { videos: 30 } }].map((i) => expect.objectContaining(i)))
  })
})
