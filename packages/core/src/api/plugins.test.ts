import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore } from '../kv/store'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createPluginRuntime } from '../plugins/runtime'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
import { createPluginRoutes } from './plugins'
import type { VerifyReport } from '../plugins/verify-child'

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u1@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function healthyReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    ok: true,
    pluginId: 'tiktok',
    version: '1.0.0',
    scripts: [{ id: 'login', paramsSchema: { type: 'object' } }],
    resetPackages: [],
    ...overrides,
  }
}

function setUp(role: 'admin' | 'operator' | null = 'admin', verify?: (bundlePath: string, o?: { expectedVersion?: string }) => Promise<VerifyReport>) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const dataDir = `/tmp/enkaku-plugin-api-test-${crypto.randomUUID()}`
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, verify: verify ?? (async () => healthyReport()) })
  const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1000, maxTotalBytesPerScope: 10_000_000 }))
  const audit = createAuditLogger(db)
  const app = withUser(role, createPluginRoutes({ runtime, audit, workspace }))
  return { app, runtime, db }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('POST /api/plugins — stage + verify (criterion 1)', () => {
  test('publishes and immediately verifies, returning the manifest', async () => {
    const { app } = setUp()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' }),
    })
    expect(res.status).toBe(201)
    const body = await jsonBody(res)
    expect((body.verify as VerifyReport).ok).toBe(true)
    expect((body.plugin as { status: string }).status).toBe('staged') // verified, not yet active — §3.7 step 3 is a separate call
  })

  test('stageOnly: true skips verification', async () => {
    const { app } = setUp()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}', stageOnly: true }),
    })
    const body = await jsonBody(res)
    expect(body.verify).toBeUndefined()
    expect((body.plugin as { verifiedAt: unknown }).verifiedAt).toBeNull()
  })

  test('republishing the same (name, version) is refused with 409', async () => {
    const { app } = setUp()
    const publish = () =>
      app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' }),
      })
    await publish()
    const second = await publish()
    expect(second.status).toBe(409)
  })

  test('an anonymous (signed-out) caller is refused with 403', async () => {
    const { app } = setUp(null)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('activate / rollback / disable / restart', () => {
  test('the full lifecycle through the REST surface', async () => {
    const { app, runtime } = setUp()
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' }),
    })
    const staged = (await jsonBody(publishRes)).plugin as { id: string }

    const activateRes = await app.request(`/${staged.id}/activate`, { method: 'POST' })
    expect(activateRes.status).toBe(200)
    expect(((await jsonBody(activateRes)).plugin as { status: string }).status).toBe('active')

    const listRes = await app.request('/')
    const list = (await jsonBody(listRes)).items as { status: string }[]
    expect(list.some((p) => p.status === 'active')).toBe(true)

    const disableRes = await app.request('/tiktok/disable', { method: 'POST' })
    expect(disableRes.status).toBe(200)
    expect(runtime.active('tiktok')).toBeNull()

    const restartRes = await app.request('/restart', { method: 'POST' })
    expect(restartRes.status).toBe(200)
    const restartBody = await jsonBody(restartRes)
    expect(typeof restartBody.ok).toBe('number')
  })

  test('DELETE removes a version, honouring ?deleteKv=1', async () => {
    const { app } = setUp()
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' }),
    })
    const del = await app.request('/tiktok/1.0.0?deleteKv=1', { method: 'DELETE' })
    expect(del.status).toBe(200)
    const body = await jsonBody(del)
    expect(body.removed).toBe(true)

    const admin403check = await app.request('/tiktok/9.9.9', { method: 'DELETE' })
    expect(admin403check.status).toBe(404) // plugin_not_found
  })

  test('DELETE requires script.delete (admin-only) — an operator is refused', async () => {
    const { app } = setUp('operator')
    const res = await app.request('/tiktok/1.0.0', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/plugins/:name/:version', () => {
  test('404 for a version that does not exist', async () => {
    const { app } = setUp()
    const res = await app.request('/nope/1.0.0')
    expect(res.status).toBe(404)
  })
})

describe('dev slots — POST/DELETE /api/plugins/dev', () => {
  test('a bundle-form dev push (front-end B) creates a slot and shows up in the list', async () => {
    const { app } = setUp()
    const res = await app.request('/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', bundle: 'export {}' }),
    })
    expect(res.status).toBe(200)
    const body = await jsonBody(res)
    expect(body.ok).toBe(true)

    const list = await app.request('/dev')
    const items = (await jsonBody(list)).items as { pluginName: string }[]
    expect(items.map((s) => s.pluginName)).toEqual(['tiktok'])

    const dropped = await app.request('/dev/tiktok', { method: 'DELETE' })
    expect(dropped.status).toBe(200)
    const listAfter = await app.request('/dev')
    expect(((await jsonBody(listAfter)).items as unknown[]).length).toBe(0)
  })

  test('exactly one of entryPath/bundle is required', async () => {
    const { app } = setUp()
    const neither = await app.request('/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok' }),
    })
    expect(neither.status).toBe(400)
  })
})
