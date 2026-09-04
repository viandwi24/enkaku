import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  PluginActionResponseSchema,
  PluginActivateResponseSchema,
  PluginRowResponseSchema,
  PluginResponseSchema,
  PluginsListResponseSchema,
  PluginStageResponseSchema,
  PluginUiResponseSchema,
  PluginVerifyResponseSchema,
  PluginViewResponseSchema,
  validatePluginSurface,
  type JobInfo,
  type PluginSurface,
  type PluginSurfaceInput,
} from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { auditLog, jobs, plugins, scripts } from '../db/schema'
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
    const { app, db } = setUp()
    const archive = writePluginPackage({
      manifest: { name: 'tiktok', version: '1.0.0', source: 'the original source' },
      scripts: 'export {}',
      ui: [{ path: 'index.html', data: new TextEncoder().encode('<h1>hi</h1>') }],
    })
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: archive })
    expect(res.status).toBe(201)
    const body = await jsonBody(res)
    expect((body.verify as VerifyReport).ok).toBe(true)
    // Read from the TABLE, not through `runtime.get`: since plan 126 step 126.1
    // the runtime's reads are projected and no longer carry `bundle`/`source` at
    // all (they are what this route must store and what no screen may receive),
    // so the only honest place to assert they were stored is the row itself.
    const row = db.select().from(plugins).where(and(eq(plugins.name, 'tiktok'), eq(plugins.version, '1.0.0'))).get()
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

  test('the version route carries the manifest and NOT the bundle (plan 126 step 126.1)', async () => {
    const { app, runtime } = setUp()
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: `export const marker = "${BUNDLE_MARKER}"`, source: SOURCE_MARKER })
    await runtime.verify(staged.id)

    const res = await app.request('/tiktok/1.0.0')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(BUNDLE_MARKER)
    expect(raw).not.toContain(SOURCE_MARKER)
    // …and it still carries what the detail page reads it FOR.
    const plugin = PluginResponseSchema.parse(JSON.parse(raw)).plugin
    expect(plugin.manifest?.scripts.map((s) => s.id)).toEqual(['login'])
  })
})

/**
 * Plan 126 (M91) §0.1, §3.1, criterion 1 — **the guard that stops the bundle
 * coming back.**
 *
 * The owner's report was *"the Plugins menu is very heavy when I open it"*, and
 * the cause was `db.select()` with no argument over a table whose largest column
 * is the complete built JavaScript pack, ~1 MB per version row. `PluginRowSchema`
 * never declared `bundle`, so Zod stripped it on arrival and the browser
 * downloaded megabytes to throw them away on the next line.
 *
 * **These search the SERIALISED BODY for a marker, rather than asserting a
 * shape**, and the difference is the whole value of the file. A shape assertion
 * (`expect(item.bundle).toBeUndefined()`) pins the columns that exist today and
 * says nothing about the seventh one someone adds to `plugins` next year; a body
 * search fails the moment any column carrying the bundle text reaches the wire,
 * whatever it is called and however it got there. That is the failure mode this
 * plan exists to make impossible.
 */
const BUNDLE_MARKER = '__ENKAKU_BUNDLE_MARKER_DO_NOT_SHIP__'
const SOURCE_MARKER = '__ENKAKU_SOURCE_MARKER_DO_NOT_SHIP__'

describe('GET /api/plugins — the list carries no plugin source (plan 126)', () => {
  /** `n` published versions of one plugin, each with a distinctively-marked bundle — the shape of a farm that has iterated on a plugin all week (§0.3). */
  async function publishVersions(runtime: PluginRuntime, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const staged = await runtime.stage({
        name: 'tiktok',
        version: `1.0.${i}`,
        // Padded to a realistic size: the built packs this plan measured are
        // 818–1065 KB, and a marker in a 40-byte string would prove the field is
        // gone without proving the WEIGHT is.
        bundle: `export const marker = "${BUNDLE_MARKER}"\n${'// filler\n'.repeat(20_000)}`,
        source: SOURCE_MARKER,
      })
      await runtime.verify(staged.id)
    }
  }

  test('no version of the bundle, the source, or the hash appears anywhere in the response body', async () => {
    const { app, runtime } = setUp()
    await publishVersions(runtime, 3)

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const raw = await res.text()

    expect(raw).not.toContain(BUNDLE_MARKER)
    expect(raw).not.toContain(SOURCE_MARKER)
    expect(raw).not.toContain('// filler')
    expect(raw).not.toContain('bundleHash')
    expect(raw).not.toContain('resetPackages')
    // The rows really are there — otherwise the assertions above would pass on
    // an empty list, which is the one way this test could lie.
    const body = PluginsListResponseSchema.parse(JSON.parse(raw))
    expect(body.items).toHaveLength(3)
  })

  test('the response stays in the tens of kilobytes at twenty versions (criterion 2)', async () => {
    const { app, runtime } = setUp()
    await publishVersions(runtime, 20)

    const raw = await (await app.request('/')).text()
    // Twenty versions of one plugin, each holding a ~200 KB bundle: the old
    // `SELECT *` answered ~4 MB here. The bound is deliberately loose — this
    // guards an ORDER OF MAGNITUDE, not a byte count, so it does not fail the
    // day someone adds an honest field to the list item.
    expect(raw.length).toBeLessThan(50_000)
    expect(PluginsListResponseSchema.parse(JSON.parse(raw)).items).toHaveLength(20)
  })

  test('what the list DOES carry: the manifest projected to declaredScripts + hasService (§3.2)', async () => {
    const { app, runtime } = setUp('admin', async () =>
      healthyReport({
        scripts: [
          { id: 'login', paramsSchema: { type: 'object', properties: { user: { type: 'string' } } }, title: 'Log in', runtime: null },
          { id: 'warmup', paramsSchema: { type: 'object' }, runtime: null },
        ],
      }),
    )
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)

    const raw = await (await app.request('/')).text()
    // The member SCHEMAS are what `declaredScripts` exists to leave behind.
    expect(raw).not.toContain('paramsSchema')
    const [item] = PluginsListResponseSchema.parse(JSON.parse(raw)).items
    expect(item?.declaredScripts).toEqual([{ id: 'login', title: 'Log in' }, { id: 'warmup' }])
    expect(item?.hasService).toBe(false)
    expect(item?.scriptCount).toBe(0) // verified, not activated — nothing registered yet
  })

  test('scriptCount is the live registered count, produced by COUNT(*) (§4.2, criterion 5)', async () => {
    const { app, runtime } = setUp('admin', async () =>
      healthyReport({ scripts: [{ id: 'login', paramsSchema: {}, runtime: null }, { id: 'warmup', paramsSchema: {}, runtime: null }] }),
    )
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)

    const body = PluginsListResponseSchema.parse(JSON.parse(await (await app.request('/')).text()))
    expect(body.items[0]?.scriptCount).toBe(2)
  })

  test('the list requires script.view — an anonymous caller is refused (step 126.4)', async () => {
    const { app } = setUp(null)
    expect((await app.request('/')).status).toBe(403)
  })

  test('…and an OPERATOR is not: script.view is in the OPERATOR set, which is what makes the gate safe for the sidebar', async () => {
    const { app } = setUp('operator')
    expect((await app.request('/')).status).toBe(200)
  })
})

/**
 * Plan 126 (M91) step 126.6 — **the same guard, on the routes that WRITE.**
 *
 * Step 126.1 fixed the two reads and measured the win, and the plan recorded
 * what it had deliberately left: `POST /api/plugins`, `POST /:id/activate`,
 * `POST /:name/rollback` and `POST /:name/enable` each answered `c.json()` with
 * a raw table row, so **a publish sent the ~1 MB bundle up and got the same
 * ~1 MB straight back down**, and every activate/rollback/enable paid it too.
 * `PluginRowSchema` declares none of those columns, so the browser parsed the
 * echo and dropped it — the identical waste, on the identical schema, one
 * handler over.
 *
 * These are body searches for a marker, for the reason the list's guard states
 * at length above: a shape assertion pins the columns that exist today and says
 * nothing about the one someone adds to `plugins` next year. The fix these
 * cover is a projection at the runtime's edge (`PluginWireRow`) rather than a
 * strip at each `c.json`, so a route added later inherits it — but "inherits it
 * by construction" is a claim about types, and these tests are the claim about
 * bytes.
 */
describe('the write routes echo no plugin source either (plan 126 step 126.6)', () => {
  /**
   * Padded to a realistic size for the same reason `publishVersions` pads: a
   * marker inside a 40-byte bundle would prove the FIELD is gone without proving
   * the WEIGHT is, and weight is what the owner felt.
   */
  const MARKED_BUNDLE = `export const marker = "${BUNDLE_MARKER}"\n${'// filler\n'.repeat(20_000)}`

  /**
   * Publish through the ROUTE rather than through `runtime.stage`, because on
   * this route the request body IS the bundle — the round trip is the thing
   * being measured, and staging behind the router's back would not exercise it.
   */
  async function publish(app: Hono<AuthEnv>, version: string, opts: { stageOnly?: boolean } = {}): Promise<Response> {
    return await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version, bundle: MARKED_BUNDLE, source: SOURCE_MARKER, ...opts }),
    })
  }

  /** The assertion every case in this block shares. Named once so a new case cannot check three of the five and look complete. */
  function expectNoPluginSource(raw: string): void {
    expect(raw).not.toContain(BUNDLE_MARKER)
    expect(raw).not.toContain(SOURCE_MARKER)
    expect(raw).not.toContain('// filler')
    expect(raw).not.toContain('bundleHash')
    // `resetPackages` is checked against the `plugin` MEMBER rather than the
    // whole body, and the distinction is real rather than a way around a red
    // test: `VerifyReport` declares a field of that name of its own (the
    // packages a plugin's Reset data clears), several of these routes answer a
    // report alongside the row, and that field is exactly what the caller asked
    // for. It is the `plugins` COLUMN of that name — the stored copy nobody
    // reads off a row — that must not ride along.
    const seen = z.object({ plugin: z.unknown() }).safeParse(JSON.parse(raw))
    if (seen.success && seen.data.plugin !== undefined) expect(JSON.stringify(seen.data.plugin)).not.toContain('resetPackages')
  }

  /** Publish `version` and hand back its id — the handle `activate`/`verify` need. */
  async function publishId(app: Hono<AuthEnv>, version: string): Promise<string> {
    const res = await publish(app, version)
    expect(res.status).toBe(201)
    const { plugin } = PluginStageResponseSchema.parse(await res.json())
    if (!plugin) throw new Error(`publishing tiktok@${version} answered no plugin row`)
    return plugin.id
  }

  test('POST /api/plugins does not send the upload back down with the 201', async () => {
    const { app } = setUp()
    const res = await publish(app, '1.0.0')
    expect(res.status).toBe(201)
    const raw = await res.text()

    expectNoPluginSource(raw)
    // The bound is an ORDER OF MAGNITUDE, not a byte count, exactly as the
    // list's own size guard is: ~200 KB went up, and what comes back is a row's
    // worth of identity plus a manifest — a couple of kilobytes, not a copy.
    expect(MARKED_BUNDLE.length).toBeGreaterThan(200_000)
    expect(raw.length).toBeLessThan(5_000)
    // …and it still says what a publish is asked for: which row now exists, and
    // whether it verified. Without this the assertions above would pass on an
    // empty body, which is the one way this test could lie.
    const body = PluginStageResponseSchema.parse(JSON.parse(raw))
    expect(body.verify?.ok).toBe(true)
    expect(body.plugin?.status).toBe('staged')
    expect(body.plugin?.manifest?.scripts.map((s) => s.id)).toEqual(['login'])
  })

  test('…including on the stageOnly path, which answers the pre-verify row rather than a re-read', async () => {
    const { app } = setUp()
    // The two exits of this handler are different objects — `staged` here, a
    // fresh `runtime.get` on the verifying path above — so both need covering.
    const raw = await (await publish(app, '1.0.0', { stageOnly: true })).text()
    expectNoPluginSource(raw)
    expect(raw.length).toBeLessThan(5_000)
    const body = PluginStageResponseSchema.parse(JSON.parse(raw))
    expect(body.verify).toBeUndefined()
    expect(body.plugin?.verifiedAt).toBeNull()
  })

  test('POST /:id/verify answers the report and nothing off the row', async () => {
    const { app } = setUp()
    const id = await publishId(app, '1.0.0')
    const res = await app.request(`/${id}/verify`, { method: 'POST' })
    expect(res.status).toBe(200)
    const raw = await res.text()
    expectNoPluginSource(raw)
    expect(PluginVerifyResponseSchema.parse(JSON.parse(raw)).verify.ok).toBe(true)
  })

  test('POST /:id/activate answers the activated row, projected', async () => {
    const { app } = setUp()
    const id = await publishId(app, '1.0.0')
    const res = await app.request(`/${id}/activate`, { method: 'POST' })
    expect(res.status).toBe(200)
    const raw = await res.text()

    expectNoPluginSource(raw)
    const plugin = PluginActivateResponseSchema.parse(JSON.parse(raw)).plugin
    expect(plugin.status).toBe('active')
    expect(plugin.version).toBe('1.0.0')
    // `scriptCount` is read after activation wrote the member rows, so it
    // reports what just became runnable rather than the pre-activation zero.
    expect(plugin.scriptCount).toBe(1)
  })

  test('activate answers scriptsMoved and queuedKeepingPrevious (plan 210 §4.7)', async () => {
    const { app, db } = setUp()
    const v1Id = await publishId(app, '1.0.0')
    await app.request(`/${v1Id}/activate`, { method: 'POST' })
    const v1Member = db.select().from(scripts).where(eq(scripts.pluginId, v1Id)).all()[0]!
    db.insert(jobs)
      .values({ id: 'job-queued', scriptId: v1Member.id, deviceId: 'd1', status: 'queued', createdAt: new Date(), priority: 0 })
      .run()

    const v2Id = await publishId(app, '2.0.0')
    const res = await app.request(`/${v2Id}/activate`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = PluginActivateResponseSchema.parse(await res.json())
    expect(body.scriptsMoved).toBe(1)
    expect(body.queuedKeepingPrevious).toBe(1)
  })

  test('POST /:name/rollback answers the version it went back to, projected', async () => {
    const { app } = setUp()
    await app.request(`/${await publishId(app, '1.0.0')}/activate`, { method: 'POST' })
    await app.request(`/${await publishId(app, '1.0.1')}/activate`, { method: 'POST' })

    const res = await app.request('/tiktok/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toVersion: '1.0.0' }),
    })
    expect(res.status).toBe(200)
    const raw = await res.text()

    expectNoPluginSource(raw)
    const plugin = PluginRowResponseSchema.parse(JSON.parse(raw)).plugin
    expect(plugin.version).toBe('1.0.0')
    expect(plugin.status).toBe('active')
  })

  test('POST /:name/enable answers the re-enabled row, projected', async () => {
    const { app } = setUp()
    await app.request(`/${await publishId(app, '1.0.0')}/activate`, { method: 'POST' })
    expect((await app.request('/tiktok/disable', { method: 'POST' })).status).toBe(200)

    const res = await app.request('/tiktok/enable', { method: 'POST' })
    expect(res.status).toBe(200)
    const raw = await res.text()

    expectNoPluginSource(raw)
    const plugin = PluginRowResponseSchema.parse(JSON.parse(raw)).plugin
    expect(plugin.status).toBe('active')
    expect(plugin.version).toBe('1.0.0')
  })

  test('the row itself still holds everything the farm needs — the projection is a wire shape, not a deletion', async () => {
    const { app, db } = setUp()
    await publish(app, '1.0.0')
    // The counterpart to every assertion above: a publish that answered nothing
    // about the bundle would also pass them, and that would be a far worse bug
    // than the one this step fixes.
    const row = db.select().from(plugins).where(and(eq(plugins.name, 'tiktok'), eq(plugins.version, '1.0.0'))).get()
    expect(row?.bundle).toContain(BUNDLE_MARKER)
    expect(row?.source).toBe(SOURCE_MARKER)
    expect(row?.bundleHash).toBeString()
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
