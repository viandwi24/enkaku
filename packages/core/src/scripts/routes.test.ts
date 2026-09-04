import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { jobs, plugins, scripts } from '../db/schema'
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

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/** A `plugins` row at a given status, minimally valid. */
function seedPlugin(db: Db, opts: { id: string; name: string; version: string; status: 'active' | 'staged' | 'superseded' | 'disabled' }): void {
  db.insert(plugins)
    .values({
      id: opts.id,
      name: opts.name,
      version: opts.version,
      title: null,
      description: null,
      bundle: 'export {}',
      source: null,
      bundleHash: 'deadbeef',
      status: opts.status,
      verifiedAt: new Date(),
      verifyError: null,
      verifyErrorCode: null,
      manifest: { scripts: [{ id: 'main' }] },
      resetPackages: null,
      createdBy: null,
      createdAt: new Date(),
    })
    .run()
}

/** A member row of `pluginId`, matching what `writeScriptRows` writes. */
function seedMember(db: Db, opts: { id: string; name: string; version: string; pluginId: string; exportId?: string; createdAt?: number }): void {
  db.insert(scripts)
    .values({
      id: opts.id,
      name: opts.name,
      version: opts.version,
      bundle: 'export {}',
      enabled: true,
      createdAt: new Date((opts.createdAt ?? 1_700_000_000) * 1000),
      pluginId: opts.pluginId,
      exportId: opts.exportId ?? 'main',
    })
    .run()
}

/** An unowned row, exactly the shape a farm might already have on disk. */
function seedUnowned(db: Db, name: string, version: string): string {
  const id = `${name}-${version}`
  db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
  return id
}

describe('GET /api/scripts (plan 210 §4.2, §4.5)', () => {
  test('needs no permission at all — read routes stay open', async () => {
    const db = setUp()
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })

  test('lists one row per member of an ACTIVE plugin, with plugin, exportId, paramsSchema and lastRun', async () => {
    const db = setUp()
    seedPlugin(db, { id: 'active-1', name: 'tiktok', version: '1.1.0', status: 'active' })
    seedMember(db, { id: 's-login', name: 'tiktok/login', version: '1.1.0', pluginId: 'active-1', exportId: 'login' })
    // A superseded version of the SAME plugin — its member row must not double the list.
    seedPlugin(db, { id: 'superseded-1', name: 'tiktok', version: '1.0.0', status: 'superseded' })
    seedMember(db, { id: 's-login-old', name: 'tiktok/login', version: '1.0.0', pluginId: 'superseded-1', exportId: 'login' })
    db.insert(jobs)
      .values({
        id: 'job-1',
        scriptId: 's-login',
        deviceId: 'd1',
        status: 'success',
        scriptName: 'tiktok/login',
        createdAt: new Date(1_700_000_500 * 1000),
        finishedAt: new Date(1_700_000_600 * 1000),
      })
      .run()

    const app = createScriptRoutes({ db })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string; name: string; exportId: string; plugin: { name: string; version: string }; paramsSchema: unknown; hasResult: boolean; lastRun: { jobId: string; status: string } | null }>
      nextCursor: string | null
      total: number
    }
    expect(body.items).toHaveLength(1)
    expect(body.nextCursor).toBeNull()
    expect(body.total).toBe(1)
    const item = body.items[0]!
    expect(item.id).toBe('s-login')
    expect(item.name).toBe('tiktok/login')
    expect(item.exportId).toBe('login')
    expect(item.plugin).toEqual({ name: 'tiktok', version: '1.1.0' })
    expect(item.lastRun).toMatchObject({ jobId: 'job-1', status: 'success' })
    expect(item.paramsSchema).toBeNull()
    expect(item.hasResult).toBe(false)
    // No `version`, `kind`, or `enabled` key on the wire.
    expect('version' in item).toBe(false)
    expect('kind' in item).toBe(false)
    expect('enabled' in item).toBe(false)
  })

  test("a disabled plugin's members are absent from the list", async () => {
    const db = setUp()
    seedPlugin(db, { id: 'disabled-1', name: 'demo', version: '1.0.0', status: 'disabled' })
    seedMember(db, { id: 's-demo', name: 'demo/checkout', version: '1.0.0', pluginId: 'disabled-1' })
    const app = createScriptRoutes({ db })
    const res = await app.request('/')
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
  })

  test('an unowned row is absent from the list and 404 on detail', async () => {
    const db = setUp()
    const orphanId = seedUnowned(db, 'debug-node', '1.0.0')
    seedPlugin(db, { id: 'active-1', name: 'demo', version: '1.0.0', status: 'active' })
    seedMember(db, { id: 's-demo', name: 'demo/checkout', version: '1.0.0', pluginId: 'active-1' })
    const app = createScriptRoutes({ db })

    const list = await app.request('/')
    const listBody = (await list.json()) as { items: Array<{ name: string }> }
    expect(listBody.items.map((i) => i.name)).toEqual(['demo/checkout'])

    const detail = await app.request(`/${orphanId}`)
    expect(detail.status).toBe(404)
    const detailBody = (await detail.json()) as { error: { code: string } }
    expect(detailBody.error.code).toBe('script_not_found')
  })
})

describe('GET /api/scripts/:id', () => {
  test('returns the owned row, active or superseded', async () => {
    const db = setUp()
    seedPlugin(db, { id: 'active-1', name: 'demo', version: '1.0.0', status: 'active' })
    seedMember(db, { id: 's-demo', name: 'demo/checkout', version: '1.0.0', pluginId: 'active-1' })
    const app = createScriptRoutes({ db })
    const res = await app.request('/s-demo')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { script: { id: string; name: string; plugin: { name: string; version: string } } }
    expect(body.script).toMatchObject({ id: 's-demo', name: 'demo/checkout', plugin: { name: 'demo', version: '1.0.0' } })
  })

  test('?bundle=1 includes the bundle', async () => {
    const db = setUp()
    seedPlugin(db, { id: 'active-1', name: 'demo', version: '1.0.0', status: 'active' })
    seedMember(db, { id: 's-demo', name: 'demo/checkout', version: '1.0.0', pluginId: 'active-1' })
    const app = createScriptRoutes({ db })
    const without = await app.request('/s-demo')
    const withoutBody = (await without.json()) as { script: { bundle?: string } }
    expect(withoutBody.script.bundle).toBeUndefined()
    const withBundle = await app.request('/s-demo?bundle=1')
    const withBundleBody = (await withBundle.json()) as { script: { bundle?: string } }
    expect(withBundleBody.script.bundle).toBe('export {}')
  })
})

describe('DELETE /api/scripts/:id (plan 210 §4.3)', () => {
  test('refuses an operator — admin-only', async () => {
    const db = setUp()
    const id = seedUnowned(db, 'debug-node', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('refuses an owned row with E_SCRIPT_OWNED and deletes an unowned one', async () => {
    const db = setUp()
    seedPlugin(db, { id: 'active-1', name: 'demo', version: '1.0.0', status: 'active' })
    seedMember(db, { id: 's-demo', name: 'demo/checkout', version: '1.0.0', pluginId: 'active-1' })
    const orphanId = seedUnowned(db, 'debug-node', '1.0.0')
    const app = withUser('admin', createScriptRoutes({ db }))

    const owned = await app.request('/s-demo', { method: 'DELETE' })
    expect(owned.status).toBe(409)
    const ownedBody = (await owned.json()) as { error: { code: string; message: string } }
    expect(ownedBody.error.code).toBe('E_SCRIPT_OWNED')
    expect(ownedBody.error.message).toContain('demo@1.0.0')
    expect(db.select().from(scripts).where(eq(scripts.id, 's-demo')).all()).toHaveLength(1)

    const unowned = await app.request(`/${orphanId}`, { method: 'DELETE' })
    expect(unowned.status).toBe(200)
    expect(db.select().from(scripts).where(eq(scripts.id, orphanId)).all()).toHaveLength(0)
  })

  test('admits an admin and audits script.delete', async () => {
    const db = setUp()
    const id = seedUnowned(db, 'debug-node', '1.0.0')
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createScriptRoutes({ db, audit }))
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'u1', action: 'script.delete', target: id })
  })
})

describe('/api/scripts/:name/param-sets (plan 95 §4.7, §4.8, §5 step 95.8)', () => {
  function jsonReq(method: string, body: unknown) {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  }

  test('GET on a script with no sets returns an empty list, not an error', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/checkout/param-sets')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
  })

  test('GET requires script.view — refused with no authenticated user', async () => {
    const db = setUp()
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request('/checkout/param-sets')
    expect(res.status).toBe(403)
  })

  test('POST creates a set (name, params, scriptName all round-trip), lists it back, and audits script.param_set.create', async () => {
    const db = setUp()
    seedUnowned(db, 'checkout', '1.0.0')
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

  test('POST with a duplicate name for the SAME script is refused 409; the SAME name under a different script is unaffected', async () => {
    const db = setUp()
    seedUnowned(db, 'checkout', '1.0.0')
    seedUnowned(db, 'login', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    const first = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'Aggressive', params: {} }))
    expect(first.status).toBe(201)

    const dup = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'Aggressive', params: {} }))
    expect(dup.status).toBe(409)
    const dupBody = (await dup.json()) as { error: { code: string } }
    expect(dupBody.error.code).toBe('param_set_name_exists')

    const otherScript = await app.request('/login/param-sets', jsonReq('POST', { name: 'Aggressive', params: {} }))
    expect(otherScript.status).toBe(201)

    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: unknown[] }
    expect(listBody.items).toHaveLength(1)
  })

  test('POST/PATCH/DELETE all require job.run — refused with no authenticated user, and nothing is written', async () => {
    const db = setUp()
    seedUnowned(db, 'checkout', '1.0.0')
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
    seedUnowned(db, 'checkout', '1.0.0')
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createScriptRoutes({ db, audit }))
    const create = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'A', params: { videos: 1 } }))
    const { paramSet: a } = (await create.json()) as { paramSet: { id: string } }

    const patch = await app.request(`/checkout/param-sets/${a.id}`, jsonReq('PATCH', { params: { videos: 2 } }))
    expect(patch.status).toBe(200)
    const { paramSet: updated } = (await patch.json()) as { paramSet: { name: string; params: unknown } }
    expect(updated).toMatchObject({ name: 'A', params: { videos: 2 } })
    expect(calls.at(-1)).toMatchObject({ userId: 'u1', action: 'script.param_set.update', target: a.id, meta: { scriptName: 'checkout', name: 'A' } })

    const rename = await app.request(`/checkout/param-sets/${a.id}`, jsonReq('PATCH', { name: 'Renamed' }))
    expect(rename.status).toBe(200)
    const { paramSet: renamed } = (await rename.json()) as { paramSet: { name: string; params: unknown } }
    expect(renamed).toMatchObject({ name: 'Renamed', params: { videos: 2 } })
  })

  test('PATCH renaming to an existing name for the same script 409s, and changes nothing', async () => {
    const db = setUp()
    seedUnowned(db, 'checkout', '1.0.0')
    const app = withUser('operator', createScriptRoutes({ db }))
    const createA = await app.request('/checkout/param-sets', jsonReq('POST', { name: 'A', params: { videos: 1 } }))
    const { paramSet: a } = (await createA.json()) as { paramSet: { id: string } }
    await app.request('/checkout/param-sets', jsonReq('POST', { name: 'B', params: {} }))

    const dupRename = await app.request(`/checkout/param-sets/${a.id}`, jsonReq('PATCH', { name: 'B' }))
    expect(dupRename.status).toBe(409)
    const body = (await dupRename.json()) as { error: { code: string } }
    expect(body.error.code).toBe('param_set_name_exists')

    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as { items: Array<{ name: string; params: unknown }> }
    expect(listBody.items.find((i) => i.name === 'A')).toMatchObject({ params: { videos: 1 } })
  })

  test('PATCH/DELETE on an unknown id, or an id that belongs to a DIFFERENT script name, both 404 — the route param and the row must agree', async () => {
    const db = setUp()
    seedUnowned(db, 'checkout', '1.0.0')
    seedUnowned(db, 'login', '1.0.0')
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

    const list = await app.request('/checkout/param-sets')
    const listBody = (await list.json()) as {
      items: Array<{ id: string; name: string; params: unknown; scriptName: string; createdBy: string | null; createdAt: number; updatedAt: number }>
    }
    expect(listBody.items).toEqual([{ id: paramSet.id, name: 'A', params: {}, scriptName: 'checkout', createdBy: 'u1', createdAt: listBody.items[0]!.createdAt, updatedAt: listBody.items[0]!.updatedAt }])
  })

  test('DELETE removes the set and audits script.param_set.delete', async () => {
    const db = setUp()
    seedUnowned(db, 'checkout', '1.0.0')
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
})
