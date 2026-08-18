import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import {
  PluginActionResponseSchema,
  PluginUiResponseSchema,
  PluginViewResponseSchema,
  validatePluginSurface,
  type JobInfo,
  type PluginSurface,
  type PluginSurfaceInput,
} from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { auditLog, scripts } from '../db/schema'
import { createKvStore } from '../kv/store'
import { createTarGz } from '../backup/tar'
import { createDevSlotStore } from '../plugins/dev-slots'
import { writePluginPackage } from '../plugins/package'
import { createPluginRuntime, type PluginRuntime } from '../plugins/runtime'
import { createScriptRegistry } from '../scripts/registry'
import type { JobService } from '../services/job-service'
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
    scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: null }],
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

  test('a `.enkaku` package posted as raw bytes stages the same row the JSON body would (plan 108 §3.8, step 108.2)', async () => {
    const { app, runtime } = setUp()
    const archive = writePluginPackage({
      manifest: { name: 'tiktok', version: '1.0.0', source: 'the original source' },
      scripts: 'export {}',
      ui: [{ path: 'index.html', data: new TextEncoder().encode('<h1>hi</h1>') }],
    })
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: archive })
    expect(res.status).toBe(201)
    const body = await jsonBody(res)
    expect((body.verify as VerifyReport).ok).toBe(true)
    const row = runtime.get('tiktok', '1.0.0')
    expect(row?.bundle).toBe('export {}')
    expect(row?.source).toBe('the original source')
    expect(row?.status).toBe('staged')
  })

  test('?stageOnly=1 is the package transport\'s equivalent of the JSON body flag', async () => {
    const { app } = setUp()
    const archive = writePluginPackage({ manifest: { name: 'tiktok', version: '1.0.0' }, scripts: 'export {}' })
    const res = await app.request('/?stageOnly=1', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: archive })
    const body = await jsonBody(res)
    expect(body.verify).toBeUndefined()
    expect((body.plugin as { verifiedAt: unknown }).verifiedAt).toBeNull()
  })

  test('a malformed package is a 400 naming the offending entry, not a 500', async () => {
    const { app } = setUp()
    const bad = createTarGz([
      { name: 'plugin.json', data: new TextEncoder().encode(JSON.stringify({ name: 'tiktok', version: '1.0.0' })) },
      { name: 'scripts.mjs', data: new TextEncoder().encode('export {}') },
      { name: '../escape.sh', data: new TextEncoder().encode('rm -rf /') },
    ])
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bad })
    expect(res.status).toBe(400)
    const body = await jsonBody(res)
    expect((body.error as { code: string }).code).toBe('E_PLUGIN_PACKAGE_INVALID')
    expect((body.error as { message: string }).message).toContain('../escape.sh')
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

  test('POST /:name/enable brings a disabled plugin back — the round trip through the REST surface', async () => {
    const { app, runtime, db } = setUp()
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' }),
    })
    const staged = (await jsonBody(publishRes)).plugin as { id: string }
    await app.request(`/${staged.id}/activate`, { method: 'POST' })

    expect((await app.request('/tiktok/disable', { method: 'POST' })).status).toBe(200)
    expect(runtime.active('tiktok')).toBeNull()

    const enableRes = await app.request('/tiktok/enable', { method: 'POST' })
    expect(enableRes.status).toBe(200)
    const enabled = (await jsonBody(enableRes)).plugin as { id: string; status: string; version: string }
    expect(enabled.status).toBe('active')
    expect(enabled.id).toBe(staged.id)
    expect(runtime.active('tiktok')?.version).toBe('1.0.0')
    // The member scripts rows came back on too, not just the plugin row.
    expect(db.select().from(scripts).all().every((r) => r.enabled === true)).toBe(true)
    // …and it is audited under its own action.
    expect(db.select().from(auditLog).all().map((r) => r.action)).toContain('plugin.enable')
  })

  test('POST /:name/enable on a plugin with no disabled row is 404, and 409 when another version is active', async () => {
    const { app, runtime } = setUp()
    const publish = async (version: string) => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'tiktok', version, bundle: `export {} // ${version}` }),
      })
      return (await jsonBody(res)).plugin as { id: string }
    }

    const missing = await app.request('/tiktok/enable', { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(((await jsonBody(missing)).error as { code: string }).code).toBe('plugin_not_found')

    const v1 = await publish('1.0.0')
    await app.request(`/${v1.id}/activate`, { method: 'POST' })
    await app.request('/tiktok/disable', { method: 'POST' })
    const v2 = await publish('2.0.0')
    await app.request(`/${v2.id}/activate`, { method: 'POST' })

    const conflict = await app.request('/tiktok/enable', { method: 'POST' })
    expect(conflict.status).toBe(409)
    const body = await jsonBody(conflict)
    expect((body.error as { code: string }).code).toBe('plugin_enable_conflict')
    expect((body.error as { message: string }).message).toContain('2.0.0')
    expect(runtime.active('tiktok')?.version).toBe('2.0.0')
  })

  test('POST /:name/enable requires script.publish — an anonymous caller is refused before anything runs', async () => {
    const { app, runtime } = setUp(null)
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)
    runtime.disable('tiktok')

    const res = await app.request('/tiktok/enable', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('disabled') // the gate ran first
  })

  test('POST /:name/enable is not shadowed by any earlier route, and does not shadow them either', async () => {
    const { app, runtime } = setUp()
    const staged = await runtime.stage({ name: 'enable', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)

    // `/:id/activate` and `/:id/verify` still reach their own handlers…
    expect((await app.request(`/${staged.id}/verify`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/${staged.id}/activate`, { method: 'POST' })).status).toBe(200)
    // …`GET /:name/:version` is untouched (a GET never reaches the POST route)…
    expect((await app.request('/enable/1.0.0')).status).toBe(200)
    // …and a plugin literally NAMED "enable" still enables through `/enable/enable`,
    // proving `:name` is bound to the first segment and `enable` to the second.
    await app.request('/enable/disable', { method: 'POST' })
    expect(runtime.get('enable', '1.0.0')?.status).toBe('disabled')
    const res = await app.request('/enable/enable', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(runtime.active('enable')?.version).toBe('1.0.0')
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

/**
 * Plan 108 §4.5, §5 steps 108.5/108.6 — the three surface routes on this
 * router: `GET /ui`, `GET /:name/view/:viewId`, and
 * `POST /:name/action/:actionId`.
 *
 * The executor's own behaviour (which id a batch resolves to, what the audit
 * row says) is `plugins/action-executor.test.ts`'s subject. What is asserted
 * HERE is what only a mounted router can show: the wire shape each route
 * answers with, the permission split between the read routes (`script.view`)
 * and a write action (`plugin.data`), and the 404 a plugin that is not live
 * gives — the inactive-plugin case of §3.5 that Studio renders as a named
 * error rather than an empty table.
 */

function surfaceFixture(input: PluginSurfaceInput): PluginSurface {
  const checked = validatePluginSurface(input)
  if (!checked.ok) throw new Error(`test fixture is not a valid surface: ${checked.errors.join('; ')}`)
  return checked.value
}

const SURFACE = surfaceFixture({
  nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
  views: {
    accounts: {
      title: 'TikTok accounts',
      data: { kind: 'kv.list', scope: 'global' },
      table: { rowKey: 'key', columns: [{ field: 'key', header: 'Key' }] },
      toolbar: ['note'],
    },
    unused: {
      title: 'Unused',
      data: { kind: 'kv.list', scope: 'global' },
      table: { rowKey: 'key', columns: [{ field: 'key', header: 'Key' }] },
      toolbar: ['run'],
    },
  },
  actions: {
    note: { kind: 'kv.set', label: 'Note', scope: 'global', key: { $literal: 'note' }, value: { $literal: 'hello' } },
    run: { kind: 'job', label: 'Run', script: 'tiktok/login@latest', device: 'picker' },
  },
})

function setUpSurface(role: 'admin' | 'operator' | null = 'operator') {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const dataDir = `/tmp/enkaku-plugin-surface-test-${crypto.randomUUID()}`
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  const audit = createAuditLogger(db)
  const runtime = createPluginRuntime({
    db,
    dataDir,
    registry,
    kv,
    devSlots,
    verify: async (_p, opts) => ({ ...healthyReport({ version: opts?.expectedVersion ?? '1.0.0' }), surface: SURFACE }),
  })
  const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1000, maxTotalBytesPerScope: 10_000_000 }))
  const jobService: Pick<JobService, 'enqueue'> = {
    enqueue: (input): JobInfo => {
      throw new Error(`the surface-route tests never enqueue (got ${input.scriptId})`)
    },
  }
  const app = withUser(
    role,
    createPluginRoutes({
      runtime,
      audit,
      workspace,
      data: { db, kv },
      actions: {
        registry,
        kv,
        jobService,
        batch: () => ({ db, scheduler: { kick: () => {}, start: () => {}, stop: () => {} }, audit, onJobStatus: () => {} }),
      },
    }),
  )
  return { app, runtime, db, kv }
}

async function activateSurfacePlugin(runtime: PluginRuntime, name = 'tiktok'): Promise<void> {
  const staged = await runtime.stage({ name, version: '1.0.0', bundle: 'export {}' })
  await runtime.verify(staged.id)
  runtime.activate(staged.id)
}

describe('GET /api/plugins/ui', () => {
  test('lists an active plugin\'s nav in the declared wire shape', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)

    const res = await app.request('/ui')
    expect(res.status).toBe(200)
    const body = PluginUiResponseSchema.parse(await res.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.plugin).toBe('tiktok')
    expect(body.items[0]?.origin).toBe('plugin')
    expect(body.items[0]?.nav[0]?.icon).toBe('users')
  })

  test('a plugin that is not active is absent (criterion 6)', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)
    runtime.disable('tiktok')

    const body = PluginUiResponseSchema.parse(await (await app.request('/ui')).json())
    expect(body.items).toEqual([])
  })

  test('requires script.view — an anonymous caller is refused', async () => {
    const { app } = setUpSurface(null)
    expect((await app.request('/ui')).status).toBe(403)
  })
})

describe('GET /api/plugins/:name/view/:viewId', () => {
  test('answers the view plus ONLY the actions it references', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)

    const res = await app.request('/tiktok/view/accounts')
    expect(res.status).toBe(200)
    const body = PluginViewResponseSchema.parse(await res.json())
    expect(body.viewId).toBe('accounts')
    expect(body.view.title).toBe('TikTok accounts')
    expect(Object.keys(body.actions)).toEqual(['note'])
  })

  test('a plugin that is neither active nor dev is 404 plugin_not_found (§3.5)', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)
    runtime.disable('tiktok')

    const res = await app.request('/tiktok/view/accounts')
    expect(res.status).toBe(404)
    const body = await jsonBody(res)
    expect((body.error as { code: string }).code).toBe('plugin_not_found')
    expect((body.error as { message: string }).message).toContain('tiktok')
  })

  test('a live plugin with no such view is 404 view_not_found, not plugin_not_found', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)

    const res = await app.request('/tiktok/view/nope')
    expect(res.status).toBe(404)
    expect(((await jsonBody(res)).error as { code: string }).code).toBe('view_not_found')
  })

  test('requires script.view — an anonymous caller is refused', async () => {
    const { app } = setUpSurface(null)
    expect((await app.request('/tiktok/view/accounts')).status).toBe(403)
  })
})

describe('POST /api/plugins/:name/action/:actionId', () => {
  const post = (app: Hono<AuthEnv>, path: string, body: unknown = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('an operator runs a kv.set action — the namespace is the plugin, never the caller\'s', async () => {
    const { app, runtime, kv } = setUpSurface('operator')
    await activateSurfacePlugin(runtime)

    const res = await post(app, '/tiktok/action/note')
    expect(res.status).toBe(200)
    const body = PluginActionResponseSchema.parse(await res.json())
    expect(body.plugin).toBe('tiktok')
    expect(body.actionId).toBe('note')
    expect(body.result).toEqual({ kind: 'kv.set', scope: 'global', stableId: null, key: 'note' })
    expect(kv.get({ kind: 'global' }, 'tiktok', 'note')?.value).toBe('hello')
  })

  test('an unknown action id is 404 action_not_found', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)
    const res = await post(app, '/tiktok/action/nope')
    expect(res.status).toBe(404)
    expect(((await jsonBody(res)).error as { code: string }).code).toBe('action_not_found')
  })

  test('a plugin that is not live is 404 plugin_not_found', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)
    runtime.disable('tiktok')
    const res = await post(app, '/tiktok/action/note')
    expect(res.status).toBe(404)
    expect(((await jsonBody(res)).error as { code: string }).code).toBe('plugin_not_found')
  })

  test('the gate is per ACTION KIND — an anonymous caller is told which permission the action needed', async () => {
    const { app, runtime } = setUpSurface(null)
    await activateSurfacePlugin(runtime)

    const write = await post(app, '/tiktok/action/note')
    expect(write.status).toBe(403)
    expect(((await jsonBody(write)).error as { message: string }).message).toContain('plugin.data')

    const run = await post(app, '/tiktok/action/run')
    expect(run.status).toBe(403)
    expect(((await jsonBody(run)).error as { message: string }).message).toContain('job.run')
  })

  test('the action route is not shadowed by /:name/:version', async () => {
    const { app, runtime } = setUpSurface()
    await activateSurfacePlugin(runtime)
    // A GET of the same two leading segments still reaches the version route.
    const version = await app.request('/tiktok/1.0.0')
    expect(version.status).toBe(200)
    expect(((await jsonBody(version)).plugin as { version: string }).version).toBe('1.0.0')
  })
})

/**
 * `POST /api/plugins/:name/versions/remove` — the two bulk variants of the farm
 * owner's three-way Remove (2026-08-17). The third, one specific version, is
 * `DELETE /:name/:version` and is covered above.
 */
describe('POST /api/plugins/:name/versions/remove — bulk version removal', () => {
  async function publish(app: Hono<AuthEnv>, version: string): Promise<string> {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version, bundle: `export {} // ${version}` }),
    })
    const body = await jsonBody(res)
    return (body.plugin as { id: string }).id
  }

  /** Publishes and activates each version in turn, so the earlier rows end up `superseded` as they do on a real farm. */
  async function history(app: Hono<AuthEnv>, versions: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const v of versions) {
      const id = await publish(app, v)
      await app.request(`/${id}/activate`, { method: 'POST' })
      ids.push(id)
    }
    return ids
  }

  const removeAll = (app: Hono<AuthEnv>, scope: string, deleteKv = false) =>
    app.request('/tiktok/versions/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, deleteKv }),
    })

  test('scope "except-latest" prunes the history and reports every version, kept ones included', async () => {
    const { app } = setUp()
    await history(app, ['1.0.0', '1.1.0', '1.2.0'])

    const res = await removeAll(app, 'except-latest')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      plugin: string
      scope: string
      total: number
      webhooksDeleted: number
      results: { version: string; skip: { code: string } | null; error: { code: string } | null }[]
    }
    expect(body.plugin).toBe('tiktok')
    expect(body.total).toBe(3)
    // results.length === total: a kept row is a RESULT, not an omission, which
    // is what lets the screen say "two of three stayed" from one array.
    expect(body.results).toHaveLength(3)
    expect(body.results.filter((r) => !r.skip && !r.error).map((r) => r.version)).toEqual(['1.0.0', '1.1.0'])
    expect(body.results.find((r) => r.version === '1.2.0')!.skip!.code).toBe('plugin_kept_active')
  })

  test('scope "all" empties the plugin', async () => {
    const { app } = setUp()
    await history(app, ['1.0.0', '1.1.0'])
    const res = await removeAll(app, 'all')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { skip: unknown; error: unknown }[] }
    expect(body.results).toHaveLength(2)
    expect(body.results.every((r) => !r.skip && !r.error)).toBe(true)
    const list = (await jsonBody(await app.request('/'))) as unknown as { items: unknown[] }
    expect(list.items).toHaveLength(0)
  })

  /**
   * The report is the answer, so a request where two of eleven were refused is
   * a 200 with two named refusals — not a 4xx that would tell the caller nothing
   * happened when nine rows are gone.
   */
  test('a partial success is a 200, and the refusal is named per version', async () => {
    const { app, db } = setUp()
    const ids = await history(app, ['1.0.0', '1.1.0', '1.2.0'])
    // A queued job pinned to 1.1.0's `login` script — the same thing that makes
    // `DELETE /api/scripts/:id` answer `script_in_use`.
    const held = db.select().from(scripts).all().find((s) => s.id.startsWith(ids[1]!))!
    db.run(
      `INSERT INTO jobs (id, script_id, device_id, status, created_at) VALUES ('j-bulk', '${held.id}', 'dev-1', 'queued', ${Math.floor(Date.now() / 1000)})`,
    )

    const res = await removeAll(app, 'except-latest')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { version: string; error: { code: string; message: string } | null }[] }
    const failed = body.results.filter((r) => r.error)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.version).toBe('1.1.0')
    expect(failed[0]!.error!.code).toBe('script_in_use')
    // The other one still went — one refusal must not stop the rest.
    expect(body.results.find((r) => r.version === '1.0.0')!.error).toBeNull()
  })

  test('an unknown plugin is a 404, and a malformed scope a 400', async () => {
    const { app } = setUp()
    expect((await removeAll(app, 'all')).status).toBe(404)
    await history(app, ['1.0.0'])
    expect((await removeAll(app, 'everything')).status).toBe(400)
  })

  test('operator cannot; the route needs script.delete', async () => {
    const { app } = setUp('operator')
    expect((await removeAll(app, 'all')).status).toBe(403)
  })

  /**
   * One audit row per version PLUS one envelope row. A bulk action that wrote a
   * single row for eleven deletions would lose exactly what an operator needs
   * afterwards: which version went, and when.
   */
  test('audits one plugin.delete per version touched, with the same target shape the single route uses, plus one envelope row', async () => {
    const { app, db } = setUp()
    await history(app, ['1.0.0', '1.1.0', '1.2.0'])
    await removeAll(app, 'except-latest')

    const rows = db.select().from(auditLog).all()
    const perVersion = rows.filter((r) => r.action === 'plugin.delete')
    expect(perVersion.map((r) => r.target).sort()).toEqual(['tiktok@1.0.0', 'tiktok@1.1.0'])

    const envelope = rows.filter((r) => r.action === 'plugin.delete.bulk')
    expect(envelope).toHaveLength(1)
    const meta = envelope[0]!.meta as { scope: string; removed: number; kept: number; failed: number; keptVersions: string[] }
    expect(meta.scope).toBe('except-latest')
    expect(meta.removed).toBe(2)
    expect(meta.kept).toBe(1)
    expect(meta.failed).toBe(0)
    // The kept versions have no row of their own — nothing was attempted on
    // them — so the envelope is the only place they are recorded.
    expect(meta.keptVersions).toEqual(['1.2.0'])
  })

  test('a refused version is audited too, as a plugin.delete that did not remove', async () => {
    const { app, db } = setUp()
    const ids = await history(app, ['1.0.0', '1.1.0'])
    const held = db.select().from(scripts).all().find((s) => s.id.startsWith(ids[0]!))!
    db.run(
      `INSERT INTO jobs (id, script_id, device_id, status, created_at) VALUES ('j-bulk', '${held.id}', 'dev-1', 'running', ${Math.floor(Date.now() / 1000)})`,
    )
    await removeAll(app, 'all')

    const refused = db
      .select()
      .from(auditLog)
      .all()
      .filter((r) => r.action === 'plugin.delete' && r.target === 'tiktok@1.0.0')
    expect(refused).toHaveLength(1)
    expect((refused[0]!.meta as { removed: boolean; error: { code: string } }).removed).toBe(false)
    expect((refused[0]!.meta as { error: { code: string } }).error.code).toBe('script_in_use')
  })
})
