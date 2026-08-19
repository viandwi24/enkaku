import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PLUGIN_REQUEST_HEADER_ALLOWLIST, PluginQueryResponseSchema, parsePluginSocketPath, pluginSocketPath } from '@enkaku/protocol'
import { createPluginRoutes } from '../api/plugins'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { auditLog } from '../db/schema'
import { createKvStore } from '../kv/store'
import type { Logger } from '../util/logger'
import { createWorkspaceStore } from '../workspace/store'
import { createScriptRegistry } from '../scripts/registry'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import { FIXTURE_BUNDLE } from './runtime-host.bundle'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'
import { freshFixtureControl, type RuntimeHostFixtureControl } from './runtime-host.fixture'
import { createPluginSocketRouter } from './service-socket'
import type { VerifyReport } from './verify-child'

/**
 * Plan 109 (M74 — the plugin runtime), step **109.6**: the three route
 * families (`ctx.onRequest`, `ctx.onSocket`, `ctx.onQuery`) and plan 108's
 * `{ kind: 'handler' }` data source, against the same really-installed fixture
 * steps 109.2/109.4/109.5 use — bundled by `Bun.build`, staged, verified,
 * activated, and loaded by the real host through the real Hono router.
 *
 * Criteria under test: **21** (a view whose handler is down names the plugin
 * and offers Restart — never an empty table, never an unresolved spinner) and
 * **3** (a handler that throws, rejects or overruns is contained and charged).
 *
 * ## Every absence claim here carries two controls
 *
 * Plan 109 §9 Q15's rule, applied to the three absences this step makes:
 *
 * | absence claim | control 1 — the thing is real | control 2 — it would be seen |
 * |---|---|---|
 * | a stopped service never answers 404 | the same id DOES 404 while the service is running | the 404 branch is reachable and reads differently |
 * | a handler never sees a credential | the harness really sends `cookie` and `authorization` | an ALLOWLISTED header sent the same way does arrive |
 * | a query read is never audited | an HTTP call in the same harness DOES write a row | the audit table is really being read |
 */

const FIXTURE_SERVICE: VerifyReport['service'] = {
  permissions: ['device.list'],
  isolation: 'in-process',
  listeners: [{ id: 'probe', proto: 'tcp', deviceReachable: false, description: 'the fixture listener' }],
  events: ['device.status', 'job.status'],
  webhooks: [
    { id: 'hook', description: 'the fixture webhook', maxBodyBytes: 65_536, rateLimitPerMin: 60, toleranceSec: 300 },
    {
      id: 'strict',
      body: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      maxBodyBytes: 256,
      rateLimitPerMin: 5,
      toleranceSec: 300,
    },
  ],
  resetData: null,
}

function control(): RuntimeHostFixtureControl {
  const existing = (globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture
  if (!existing) throw new Error('the fixture has not been loaded yet')
  return existing
}

function quietLog(): Logger {
  const self: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u1@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

interface Harness {
  app: Hono<AuthEnv>
  host: RuntimeHost
  plugins: PluginRuntime
  db: Db
  install(name: string): Promise<void>
  auditActions(): Array<{ action: string; userId: string | null; target: string | null }>
}

const cleanup: Array<() => void> = []

function setUp(opts?: { role?: 'admin' | 'operator' | null; defaultTimeoutMs?: number }): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-service-routes-'))
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
  const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1000, maxTotalBytesPerScope: 10_000_000 }))
  const audit = createAuditLogger(db)

  let report: VerifyReport = { ok: true, pluginId: 'fixture', version: '1.0.0', scripts: [], service: FIXTURE_SERVICE, resetPackages: [] }
  const plugins = createPluginRuntime({ db, dataDir, registry, kv, verify: async () => report })
  const host = createRuntimeHost({
    plugins,
    dataDir,
    store: kv,
    resolveStableId: () => null,
    log: quietLog(),
    unattributedRejection: 'report',
    ...(opts?.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {}),
  })
  const app = withUser(opts?.role === undefined ? 'admin' : opts.role, createPluginRoutes({ runtime: plugins, audit, workspace, service: { host } }))

  cleanup.push(() => {
    host.dispose()
    opened.sqlite.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  return {
    app,
    host,
    plugins,
    db,
    async install(name) {
      report = { ok: true, pluginId: name, version: '1.0.0', scripts: [], service: FIXTURE_SERVICE, resetPackages: [] }
      const staged = await plugins.stage({ name, version: '1.0.0', bundle: FIXTURE_BUNDLE })
      await plugins.verify(staged.id)
      plugins.activate(staged.id)
    },
    auditActions: () => db.select({ action: auditLog.action, userId: auditLog.userId, target: auditLog.target }).from(auditLog).all(),
  }
}

beforeEach(() => {
  ;(globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture = freshFixtureControl()
})

afterEach(() => {
  control().leakedServer?.stop(true)
  for (const fn of cleanup.splice(0)) fn()
})

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

function errorOf(payload: Record<string, unknown>): { code: string; message: string } {
  return payload.error as { code: string; message: string }
}

// ---------------------------------------------------------------------------
// The query family — what plan 108's `{ kind: 'handler' }` source calls
// ---------------------------------------------------------------------------

describe('GET /:name/query/:queryId — ctx.onQuery (§4.6)', () => {
  test('a running service answers rows in the SAME shape a kv.scan does', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')

    const res = await h.app.request('/fixture/query/rows')
    expect(res.status).toBe(200)
    const payload = PluginQueryResponseSchema.parse(await res.json())
    expect(payload.plugin).toBe('fixture')
    expect(payload.queryId).toBe('rows')
    expect(payload.items).toHaveLength(2)
    expect(payload.items[0]).toMatchObject({ id: 'a', value: { label: 'alpha' }, device: { stableId: 's1', number: 7 } })
    // A row that supplied no id gets its index — documented as right for a
    // read-only table and the handler's job when selection matters.
    expect(payload.items[1]!.id).toBe('1')
    expect(payload.nextCursor).toBeNull()
  })

  test('the cursor round-trips, so a handler can page', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().queryMode = 'paged'

    const first = PluginQueryResponseSchema.parse(await (await h.app.request('/fixture/query/rows')).json())
    expect(first.nextCursor).toBe('page-2')
    const second = PluginQueryResponseSchema.parse(await (await h.app.request('/fixture/query/rows?cursor=page-2')).json())
    expect(second.items[0]!.value).toEqual({ n: 'page-2' })
    expect(second.nextCursor).toBeNull()
  })

  test('a handler that answers a shape this farm cannot render is refused NAMING THE PLUGIN, not passed to the browser', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().queryMode = 'bad-shape'

    const res = await h.app.request('/fixture/query/rows')
    // 502 and not 500: the core is fine, and the fault is upstream of it.
    expect(res.status).toBe(502)
    const err = errorOf(await body(res))
    expect(err.code).toBe('E_PLUGIN_QUERY_RESULT_INVALID')
    expect(err.message).toContain('fixture')
    expect(err.message).toContain('rows')
  })

  test('a query handler that throws is contained, charged, and answers 502', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().queryMode = 'throw'

    const res = await h.app.request('/fixture/query/rows')
    expect(res.status).toBe(502)
    expect(errorOf(await body(res)).code).toBe('E_PLUGIN_HANDLER_FAILED')
    // Criterion 3: charged, and the service is still running for the next call.
    const view = h.host.get('fixture')!
    expect(view.counters.failures).toBe(1)
    expect(view.status).toBe('running')

    control().queryMode = 'ok'
    expect((await h.app.request('/fixture/query/rows')).status).toBe(200)
  })

  test('a query handler that hangs answers 504 and the deadline frees the caller', async () => {
    const h = setUp({ defaultTimeoutMs: 25 })
    await h.install('fixture')
    await h.host.load('fixture')
    control().queryMode = 'hang'

    const res = await h.app.request('/fixture/query/rows')
    expect(res.status).toBe(504)
    expect(errorOf(await body(res)).code).toBe('E_PLUGIN_HANDLER_TIMEOUT')
    expect(h.host.get('fixture')!.counters.timeouts).toBe(1)
  })

  test('`plugin.data` gates it, and it is NOT the plugin`s to choose', async () => {
    const h = setUp({ role: null })
    await h.install('fixture')
    await h.host.load('fixture')
    expect((await h.app.request('/fixture/query/rows')).status).toBe(403)
    // Control: the same request with an operator (who holds `plugin.data`) is
    // admitted — so the 403 above is the permission and not a broken route.
    const ok = setUp({ role: 'operator' })
    await ok.install('fixture')
    await ok.host.load('fixture')
    expect((await ok.app.request('/fixture/query/rows')).status).toBe(200)
    expect(ok.host.get('fixture')!.handlers.find((x) => x.kind === 'query')!.permission).toBe('plugin.data')
  })
})

// ---------------------------------------------------------------------------
// Criterion 21 — the failure path, which is the part operators actually meet
// ---------------------------------------------------------------------------

describe('criterion 21 — a view whose handler is down (§4.6, docs/design.md)', () => {
  /**
   * **The load-bearing ordering.** A handler is registered by `setup`, not
   * declared in the manifest, so a stopped service has none — and looking the
   * handler up first would answer 404 "no such query", which is a claim about
   * the plugin's manifest and is false. Studio would then render that as "this
   * screen no longer exists" instead of "the service is down, press Restart".
   */
  test('a STOPPED service refuses with E_PLUGIN_RUNTIME_NOT_RUNNING (503), never a 404', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    // Control 1: the handler is real and reachable while the service runs.
    expect((await h.app.request('/fixture/query/rows')).status).toBe(200)

    await h.host.unload('fixture', 'the test stopped it')
    // Control 2: it really is gone from the registry — so "not found" is a
    // conclusion the route COULD have reached, and did not.
    expect(h.host.lookupHandler('fixture', 'query', 'rows')).toBeNull()

    const res = await h.app.request('/fixture/query/rows')
    expect(res.status).toBe(503)
    const err = errorOf(await body(res))
    expect(err.code).toBe('E_PLUGIN_RUNTIME_NOT_RUNNING')
    expect(err.code).not.toBe('E_PLUGIN_HANDLER_NOT_FOUND')
    expect(err.message).toContain('fixture')
  })

  test('control: while the service IS running, an unknown id really does 404 — so the assertion above is not vacuous', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const res = await h.app.request('/fixture/query/nosuchquery')
    expect(res.status).toBe(404)
    const err = errorOf(await body(res))
    expect(err.code).toBe('E_PLUGIN_HANDLER_NOT_FOUND')
    // …and it names what IS registered, so an author is told what to write.
    expect(err.message).toContain('rows')
  })

  test('`starting` gets its OWN code — "not yet" and "broken" are different answers', async () => {
    const h = setUp()
    await h.install('fixture')
    let release = () => {}
    control().setupMode = 'gate'
    control().gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const loading = h.host.load('fixture')
    // `load` is serialised behind the per-plugin lock and has a real `import()`
    // to do, so `starting` is not observable in the same tick — waited for
    // rather than slept past, so the assertion below is about the STATE and not
    // about a timing guess.
    for (let i = 0; i < 400 && h.host.get('fixture')?.status !== 'starting'; i++) await Bun.sleep(5)
    expect(h.host.get('fixture')!.status).toBe('starting')

    const res = await h.app.request('/fixture/query/rows')
    expect(res.status).toBe(503)
    const err = errorOf(await body(res))
    expect(err.code).toBe('E_PLUGIN_RUNTIME_STARTING')
    expect(err.code).not.toBe('E_PLUGIN_RUNTIME_NOT_RUNNING')

    release()
    await loading
    // Control: the SAME request succeeds once `setup` resolves, so the refusal
    // above really was "not yet" and not a permanent state.
    expect((await h.app.request('/fixture/query/rows')).status).toBe(200)
  })

  test('the error budget tripping refuses with its own code, and says nothing will retry', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().queryMode = 'throw'
    for (let i = 0; i < 20; i++) await h.app.request('/fixture/query/rows')
    expect(h.host.get('fixture')!.disabledByBudget).toBe(true)

    control().queryMode = 'ok'
    const res = await h.app.request('/fixture/query/rows')
    expect(res.status).toBe(503)
    expect(errorOf(await body(res)).code).toBe('E_PLUGIN_RUNTIME_DISABLED')
  })

  test('a plugin with a service that was never loaded says so, rather than 404', async () => {
    const h = setUp()
    await h.install('fixture')
    // Deliberately not loaded — the state a core has for every active plugin
    // between boot and `loadActive()`.
    const res = await h.app.request('/fixture/query/rows')
    expect(res.status).toBe(503)
    expect(errorOf(await body(res)).code).toBe('E_PLUGIN_RUNTIME_NOT_LOADED')
  })

  test('POST /:name/runtime/restart brings it back, and reports the STATUS it landed in', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    await h.host.unload('fixture', 'the test stopped it')
    expect((await h.app.request('/fixture/query/rows')).status).toBe(503)

    const res = await h.app.request('/fixture/runtime/restart', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ plugin: 'fixture', status: 'running' })
    // The whole point of the affordance: the view works afterwards.
    expect((await h.app.request('/fixture/query/rows')).status).toBe(200)
    expect(h.auditActions().filter((r) => r.action === 'plugin.runtime')).toHaveLength(1)
  })

  test('restart clears a budget trip — the finite, explicit retry §4.2 leaves room for', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().queryMode = 'throw'
    for (let i = 0; i < 20; i++) await h.app.request('/fixture/query/rows')
    expect(h.host.get('fixture')!.disabledByBudget).toBe(true)

    control().queryMode = 'ok'
    await h.app.request('/fixture/runtime/restart', { method: 'POST' })
    expect(h.host.get('fixture')!.disabledByBudget).toBe(false)
    expect((await h.app.request('/fixture/query/rows')).status).toBe(200)
  })

  test('a restart whose setup fails answers the failure, and the service is `failed` rather than pretended-running', async () => {
    const h = setUp()
    await h.install('fixture')
    control().setupMode = 'throw'
    const res = await h.app.request('/fixture/runtime/restart', { method: 'POST' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(h.host.get('fixture')!.status).toBe('failed')
    expect(h.host.get('fixture')!.lastError?.message).toContain('setup exploded')
  })

  test('restart needs `plugin.runtime`, which an operator holds and an anonymous caller does not', async () => {
    const anon = setUp({ role: null })
    await anon.install('fixture')
    expect((await anon.app.request('/fixture/runtime/restart', { method: 'POST' })).status).toBe(403)

    const op = setUp({ role: 'operator' })
    await op.install('fixture')
    expect((await op.app.request('/fixture/runtime/restart', { method: 'POST' })).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Dev slots — the gap 109.3 left open, refused BY NAME
// ---------------------------------------------------------------------------

describe('a dev slot has no service, and says so (plan 109 §9, the note after Q15)', () => {
  test('every family refuses E_PLUGIN_DEV_SLOT_NO_SERVICE, not a 404 that reads like a typo', async () => {
    const h = setUp()
    // A dev slot with no active row of the same name — `enkaku dev`'s state.
    await h.plugins.putDevSlot({ name: 'draft', owner: { kind: 'cli', label: 'test' }, source: { kind: 'bundle', bundle: FIXTURE_BUNDLE } })
    expect(h.plugins.devSlots().map((s) => s.pluginName)).toContain('draft')

    for (const path of ['/draft/query/rows', '/draft/http/echo']) {
      const res = await h.app.request(path)
      expect({ path, status: res.status }).toEqual({ path, status: 409 })
      const err = errorOf(await body(res))
      expect(err.code).toBe('E_PLUGIN_DEV_SLOT_NO_SERVICE')
      // The refusal has to be actionable, not merely named.
      expect(err.message).toContain('Publish and activate')
    }

    const restart = await h.app.request('/draft/runtime/restart', { method: 'POST' })
    expect(restart.status).toBe(409)
    expect(errorOf(await body(restart)).code).toBe('E_PLUGIN_DEV_SLOT_NO_SERVICE')
  })

  test('control: the same paths on a plugin that is not live at all answer plugin_not_found — so the code above is about dev slots, not about absence', async () => {
    const h = setUp()
    const res = await h.app.request('/ghost/query/rows')
    expect(res.status).toBe(404)
    expect(errorOf(await body(res)).code).toBe('plugin_not_found')
  })
})

// ---------------------------------------------------------------------------
// The HTTP family — and what a handler can and cannot see of its caller
// ---------------------------------------------------------------------------

describe('/:name/http/* — ctx.onRequest (§3.7 row 1, §4.6)', () => {
  test('a handler is told the caller`s IDENTITY and never their CREDENTIAL', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')

    const res = await h.app.request('/fixture/http/echo/sub/path?q=1', {
      headers: {
        // Control 1: the harness really sends both credentials, so their
        // absence below is the filter's doing and not the test's.
        cookie: 'enkaku_session=super-secret',
        authorization: 'Bearer super-secret',
        'x-forwarded-for': '10.0.0.1',
        // Control 2: an ALLOWLISTED header sent exactly the same way DOES
        // arrive — so "the handler saw no cookie" is not "the handler saw no
        // headers at all".
        accept: 'application/json',
      },
    })
    expect(res.status).toBe(200)

    const seen = (await body(res)).seen as { caller: unknown; headers: Record<string, string>; path: string; query: Record<string, string>; method: string }
    expect(seen.caller).toEqual({ id: 'u1', role: 'admin' })
    expect(seen.method).toBe('GET')
    expect(seen.path).toBe('/sub/path')
    expect(seen.query).toEqual({ q: '1' })

    expect(seen.headers.accept).toBe('application/json')
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers.authorization).toBeUndefined()
    expect(seen.headers['x-forwarded-for']).toBeUndefined()
    // And nothing outside the allowlist got through by another name.
    expect(Object.keys(seen.headers).every((k) => PLUGIN_REQUEST_HEADER_ALLOWLIST.includes(k))).toBe(true)
    // The serialised request carries the secret nowhere at all.
    expect(JSON.stringify(seen)).not.toContain('super-secret')
  })

  test('a handler with no sub-path is told `/`, and a POST body arrives parsed', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const res = await h.app.request('/fixture/http/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    const seen = (await body(res)).seen as { path: string; body: unknown; method: string }
    expect(seen).toMatchObject({ path: '/', method: 'POST', body: { hello: 'world' } })
  })

  test('the response header allowlist drops `set-cookie` and the CORS headers', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().httpMode = 'headers'
    const res = await h.app.request('/fixture/http/echo')
    expect(res.status).toBe(200)
    // Control: an allowlisted header the SAME handler set does survive.
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('a handler that returns nothing is 204, not an empty 200 body a caller has to guess at', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().httpMode = 'void'
    expect((await h.app.request('/fixture/http/echo')).status).toBe(204)
  })

  test('a handler that throws is 502 and charged; one that hangs is 504', async () => {
    const h = setUp({ defaultTimeoutMs: 25 })
    await h.install('fixture')
    await h.host.load('fixture')

    control().httpMode = 'throw'
    expect((await h.app.request('/fixture/http/echo')).status).toBe(502)
    control().httpMode = 'hang'
    expect((await h.app.request('/fixture/http/echo')).status).toBe(504)
    expect(h.host.get('fixture')!.counters.failures).toBe(2)
    expect(h.host.get('fixture')!.counters.timeouts).toBe(1)
  })

  test('the handler`s OWN permission gates it — a wider one narrows who may call', async () => {
    // `kv.manage` is admin-only. A plugin declaring it NARROWS its handler,
    // which is a perfectly reasonable thing to want.
    const op = setUp({ role: 'operator' })
    await op.install('fixture')
    control().httpPermission = 'kv.manage'
    await op.host.load('fixture')
    const res = await op.app.request('/fixture/http/echo')
    expect(res.status).toBe(403)
    expect(errorOf(await body(res)).code).toBe('auth.forbidden')

    // Control: the same handler, same permission, an ADMIN caller — admitted.
    const admin = setUp({ role: 'admin' })
    await admin.install('fixture')
    await admin.host.load('fixture')
    expect((await admin.app.request('/fixture/http/echo')).status).toBe(200)
  })

  test('a permission this farm does not have is refused AT REGISTRATION, naming it', async () => {
    const h = setUp()
    await h.install('fixture')
    control().registerBadPermission = 'script.veiw'
    await h.host.load('fixture')
    expect(control().registerError).toContain('E_PLUGIN_PERMISSION_UNKNOWN')
    expect(control().registerError).toContain('script.veiw')
    // The rest of `setup` still ran: one bad registration is not a broken plugin.
    expect(h.host.get('fixture')!.status).toBe('running')
    expect(h.host.lookupHandler('fixture', 'http', 'nope')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Audit — tying `plugin:<name>` back to the human who set it going
// ---------------------------------------------------------------------------

describe('the audit trail (§4.3, step 109.3`s principal)', () => {
  test('an HTTP invocation writes ONE row under the REAL caller, never under plugin:<name>', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    await h.app.request('/fixture/http/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

    const rows = h.auditActions().filter((r) => r.action === 'plugin.http')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: 'u1', target: 'fixture/echo' })
    // The plugin principal belongs on the rows the BROKER writes, not this one:
    // invoking a handler does not lend the plugin the caller's authority, and
    // the join between the two is what "who set this off" is answered with.
    expect(rows[0]!.userId).not.toBe('plugin:fixture')
  })

  test('a query READ writes no row — the same silence GET /:name/data keeps', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    await h.app.request('/fixture/query/rows')
    expect(h.auditActions().filter((r) => r.action.startsWith('plugin.'))).toEqual([])

    // Control: the audit table IS being read correctly — an HTTP call in the
    // same harness puts a row in it. Without this, "no rows" could mean the
    // query never ran, or the table was never written to at all.
    await h.app.request('/fixture/http/echo')
    expect(h.auditActions().filter((r) => r.action === 'plugin.http')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The WS family — a plugin socket is NOT the farm's broadcast
// ---------------------------------------------------------------------------

interface FakeWs {
  sent: Array<string | Uint8Array>
  closed: [number, string] | null
}

function fakeWs(): { ws: ServerWebSocket<unknown>; state: FakeWs } {
  const state: FakeWs = { sent: [], closed: null }
  const ws = {
    send: (data: string | Uint8Array) => {
      state.sent.push(data)
      return 1
    },
    close: (code?: number, reason?: string) => {
      state.closed = [code ?? 1000, reason ?? '']
    },
  } as unknown as ServerWebSocket<unknown>
  return { ws, state }
}

describe('ctx.onSocket — a plugin`s own WebSocket (§4.6)', () => {
  test('the path comes from the protocol package and round-trips', () => {
    expect(parsePluginSocketPath(pluginSocketPath('a-plugin', 'feed'))).toEqual({ plugin: 'a-plugin', socketId: 'feed' })
    // Not a plugin socket: the farm's own broadcast, and a plugin's HTTP route.
    expect(parsePluginSocketPath('/ws')).toBeNull()
    expect(parsePluginSocketPath('/api/plugins/a/http/echo')).toBeNull()
  })

  test('authorize runs BEFORE the upgrade, and refuses a stopped service by state rather than by 404', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const router = createPluginSocketRouter({ plugins: h.plugins, host: h.host, log: quietLog() })
    const caller = { id: 'u1', role: 'admin' as const }

    expect(router.authorize({ plugin: 'fixture', socketId: 'feed', caller })).toMatchObject({ plugin: 'fixture', socketId: 'feed' })

    await h.host.unload('fixture', 'the test stopped it')
    expect(() => router.authorize({ plugin: 'fixture', socketId: 'feed', caller })).toThrow(/is "stopped"/)
  })

  test('an anonymous caller is refused at the handshake, never given a socket that closes a moment later', async () => {
    const h = setUp()
    await h.install('fixture')
    control().httpPermission = 'kv.manage'
    await h.host.load('fixture')
    const router = createPluginSocketRouter({ plugins: h.plugins, host: h.host, log: quietLog() })
    expect(() => router.authorize({ plugin: 'fixture', socketId: 'feed', caller: undefined })).toThrow(/permission/)
  })

  test('open, message, close reach the plugin`s own callbacks', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const router = createPluginSocketRouter({ plugins: h.plugins, host: h.host, log: quietLog() })
    const data = router.authorize({ plugin: 'fixture', socketId: 'feed', caller: { id: 'u1', role: 'admin' } })
    const { ws } = fakeWs()

    router.open(ws, data, { room: 'lobby' })
    // The open goes through `invoke`, which is async, so the handlers are
    // installed on a later tick — which is exactly why frames are queued.
    router.message(ws, data, 'before-ready')
    await Bun.sleep(5)
    router.message(ws, data, 'after-ready')
    await Bun.sleep(5)

    expect(control().socketFrames).toEqual(['before-ready', 'after-ready'])
    expect(control().lastSocket?.caller).toEqual({ id: 'u1', role: 'admin' })
    expect(h.host.get('fixture')!.counters.openSockets).toBe(1)

    router.close(ws, data, 1000, 'bye')
    await Bun.sleep(5)
    expect(control().socketClosed).toEqual([1000, 'bye'])
    expect(h.host.get('fixture')!.counters.openSockets).toBe(0)
  })

  test('a plugin can push, and a handler that throws closes only that socket', async () => {
    const h = setUp()
    await h.install('fixture')
    control().socketMode = 'push'
    await h.host.load('fixture')
    const router = createPluginSocketRouter({ plugins: h.plugins, host: h.host, log: quietLog() })
    const data = router.authorize({ plugin: 'fixture', socketId: 'feed', caller: { id: 'u1', role: 'admin' } })

    const a = fakeWs()
    router.open(a.ws, data, {})
    await Bun.sleep(5)
    expect(a.state.sent).toEqual(['hello'])

    control().socketMode = 'throw'
    const b = fakeWs()
    router.open(b.ws, data, {})
    await Bun.sleep(5)
    expect(b.state.closed?.[0]).toBe(1011)
    // Control: the FIRST socket is untouched, and the service is still running.
    expect(a.state.closed).toBeNull()
    expect(h.host.get('fixture')!.status).toBe('running')
  })

  test('a plugin socket never touches the farm`s broadcast — it is not a WsHub client', async () => {
    const h = setUp()
    await h.install('fixture')
    control().socketMode = 'push'
    await h.host.load('fixture')
    const router = createPluginSocketRouter({ plugins: h.plugins, host: h.host, log: quietLog() })
    const data = router.authorize({ plugin: 'fixture', socketId: 'feed', caller: { id: 'u1', role: 'admin' } })
    const { ws, state } = fakeWs()
    router.open(ws, data, {})
    await Bun.sleep(5)

    // Control 1: the plugin really did write to this socket.
    expect(state.sent).toEqual(['hello'])
    // Control 2 (the absence): what it wrote is NOT a `ServerMessage` — no
    // envelope, no `type` — so nothing about a plugin socket can be mistaken
    // for, or routed into, the farm's own typed broadcast (criterion 12).
    expect(() => JSON.parse(String(state.sent[0]))).toThrow()
  })
})
