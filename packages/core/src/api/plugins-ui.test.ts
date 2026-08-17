import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore } from '../kv/store'
import { createDevSlotStore } from '../plugins/dev-slots'
import { writePluginPackage } from '../plugins/package'
import { createPluginRuntime, type PluginRuntime } from '../plugins/runtime'
import type { VerifyReport } from '../plugins/verify-child'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
import { createPluginRoutes } from './plugins'

/**
 * Step 108.10 — `GET /api/plugins/:name/ui/*`, the tier-B asset route.
 *
 * Everything here runs against a real `Db`, a real `PluginRuntime` and a real
 * temporary `dataDir`, because the two claims this route makes are claims
 * about the filesystem: that a package's `ui/` payload survives a publish, and
 * that no request shape reaches a byte the package did not declare.
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

const enc = new TextEncoder()

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-ui-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

interface Harness {
  db: Db
  runtime: PluginRuntime
  app: Hono<AuthEnv>
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
  const app = withRole(role, createPluginRoutes({ runtime, audit, workspace }))
  return { db, runtime, app }
}

const UI = [
  { path: 'index.html', data: enc.encode('<!doctype html><script src="app.js"></script>') },
  { path: 'app.js', data: enc.encode('console.error("hi")') },
  { path: 'assets/logo.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  { path: 'LICENSE', data: enc.encode('MIT') },
]

/** Publishes a `.enkaku` package through the real `POST /` package branch, then activates it. */
async function publishPackage(app: Hono<AuthEnv>, runtime: PluginRuntime, opts: { name?: string; version?: string; ui?: typeof UI; activate?: boolean } = {}) {
  const name = opts.name ?? 'tiktok'
  const version = opts.version ?? '1.0.0'
  const bytes = writePluginPackage({ manifest: { name, version }, scripts: 'export {}', ui: opts.ui ?? UI, mtimeSec: 1_700_000_000 })
  const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes })
  expect(res.status).toBe(201)
  const row = runtime.get(name, version)
  if (!row) throw new Error('the package did not stage')
  if (opts.activate !== false) runtime.activate(row.id)
  return row
}

describe('GET /:name/ui/* — serving a published package’s assets', () => {
  test('the entry document is served with its own content type', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    const res = await app.request('/tiktok/ui/index.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('<!doctype html>')
  })

  test('a nested asset is reachable by its exact declared path', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    const res = await app.request('/tiktok/ui/assets/logo.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  test('an extension the allowlist does not know is application/octet-stream, never guessed', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    // `LICENSE` has no extension at all; `.enkaku` below has one nobody maps.
    const noExtension = await app.request('/tiktok/ui/LICENSE')
    expect(noExtension.status).toBe(200)
    expect(noExtension.headers.get('content-type')).toBe('application/octet-stream')

    const { app: app2, runtime: runtime2 } = setUp()
    await publishPackage(app2, runtime2, { ui: [{ path: 'blob.weirdext', data: enc.encode('x') }] })
    const unknown = await app2.request('/tiktok/ui/blob.weirdext')
    expect(unknown.status).toBe(200)
    expect(unknown.headers.get('content-type')).toBe('application/octet-stream')
  })

  /**
   * Plan 111 §5 step 111.4 replaced plan 108's assertion here. The strict CSP
   * this used to check is GONE, and its absence is asserted rather than merely
   * left untested, because re-adding it would silently break tier C: under
   * plan 111 a `ui/` asset is loaded as a `<script type="module">` subresource
   * of Studio's own page, and had that header ever been enforced,
   * `sandbox allow-scripts` (an opaque origin) and `connect-src 'none'` (no
   * `fetch` at all) would have contradicted §3.4 outright.
   *
   * It was not enforced — a CSP response header binds to the global object
   * created from that response, and a subresource creates none — which is why
   * the header was protection in appearance only, and why it is now deleted
   * rather than relaxed. `plugins/asset-store.ts` keeps the full reasoning
   * where the constant used to be.
   *
   * The three that STAY are the three a subresource load actually honours.
   */
  test('every response carries nosniff, no-referrer and no-store — and no CSP at all', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    for (const path of ['index.html', 'app.js', 'assets/logo.png']) {
      const res = await app.request(`/tiktok/ui/${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBeNull()
      // `nosniff` is enforced on a subresource, and is what makes the browser
      // refuse a module whose content type is not a JavaScript MIME rather
      // than sniff its way into running it.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      // `no-store` does double duty: the route is permission-gated, so a
      // cached asset is one an operator who has since lost `script.view` could
      // still be served by their own browser — and it is what makes an
      // `enkaku dev` rebuild serve the NEW component (plan 111 criterion 8).
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
  })
})

describe('GET /:name/ui/* — every miss is one 404', () => {
  test('a plugin that was published but never activated serves nothing', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime, { activate: false })

    const res = await app.request('/tiktok/ui/index.html')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ui_asset_not_found')
  })

  test('a plugin disabled after activation stops serving its assets', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)
    expect((await app.request('/tiktok/ui/index.html')).status).toBe(200)

    runtime.disable('tiktok')
    expect((await app.request('/tiktok/ui/index.html')).status).toBe(404)
  })

  test('an active plugin that shipped no ui/ at all serves nothing', async () => {
    const { app, runtime } = setUp()
    const staged = await runtime.stage({ name: 'plain', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)

    expect((await app.request('/plain/ui/index.html')).status).toBe(404)
  })

  test('a plugin name nobody published is a 404, not a 500', async () => {
    const { app } = setUp()
    expect((await app.request('/ghost/ui/index.html')).status).toBe(404)
  })

  test('a path the package never declared is a 404', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)
    expect((await app.request('/tiktok/ui/nope.html')).status).toBe(404)
  })

  test('removing the plugin version takes its assets with it', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)
    expect((await app.request('/tiktok/ui/index.html')).status).toBe(200)

    runtime.remove('tiktok', '1.0.0', { deleteKv: false })
    expect((await app.request('/tiktok/ui/index.html')).status).toBe(404)
  })
})

describe('GET /:name/ui/* — traversal (criterion 12’s shape, applied to the filesystem)', () => {
  /**
   * Every one of these is refused for the SAME boring reason: the request path
   * is looked up in the package's own entry list and is not in it. Nothing is
   * normalised on the way, so there is no normaliser to get wrong.
   */
  const attempts: Array<[label: string, path: string]> = [
    ['a relative escape', '../plugin.json'],
    ['a deep relative escape', '../../../../etc/passwd'],
    ['a relative escape inside a real directory', 'assets/../../plugin.json'],
    ['a percent-encoded escape Hono decodes before we see it', '..%2fplugin.json'],
    ['a doubly-encoded escape', '%2e%2e%2fplugin.json'],
    ['an encoded dot-dot segment', '%2e%2e/plugin.json'],
    ['a backslash escape', '..\\plugin.json'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\win.ini'],
    ['a NUL-truncation attempt', 'index.html%00.png'],
    ['a trailing-dot variant', 'index.html.'],
    ['a case variant', 'INDEX.HTML'],
  ]

  for (const [label, path] of attempts) {
    test(`${label} (${path}) is refused`, async () => {
      const { app, runtime } = setUp()
      await publishPackage(app, runtime)

      const res = await app.request(`/tiktok/ui/${path}`)
      expect(res.status).toBe(404)
      // And nothing of the package's non-`ui/` half ever appears in a body.
      expect(await res.text()).not.toContain('scripts.mjs')
    })
  }

  test('a backslash SEPARATOR is folded to "/" by the URL parser long before this route, and lands on the declared asset', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    // Recorded rather than asserted as a refusal, because it is not one and
    // pretending otherwise would hide where the handling actually happens:
    // WHATWG URL treats "\" as a path separator, so `assets\logo.png` IS
    // `assets/logo.png` by the time any Hono handler exists. The escaping
    // variant (`..\plugin.json`) is in the table above and is refused, for the
    // same reason `../plugin.json` is.
    const res = await app.request('/tiktok/ui/assets\\logo.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('the scripts bundle and the manifest are not reachable through this route', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    for (const path of ['plugin.json', 'scripts.mjs', 'ui', 'ui/']) {
      const res = await app.request(`/tiktok/ui/${path}`)
      expect(res.status).toBe(404)
    }
  })
})

describe('GET /:name/ui/* — permission', () => {
  test('an unauthenticated caller is refused before any asset is read', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    const anonymous = withRole(null, createPluginRoutes({ runtime, audit: createAuditLogger(openDb(':memory:').db), workspace: createWorkspaceStore(openDb(':memory:').db, () => ({ maxFileBytes: 1, maxFilesPerScope: 1, maxTotalBytesPerScope: 1 })) }))
    const res = await anonymous.request('/tiktok/ui/index.html')
    // `requirePermission` answers 403 for "no user" as well as for "wrong
    // role" — the same answer every other guarded route in this file gives.
    expect(res.status).toBe(403)
  })

  test('an operator — not just an admin — may read a plugin’s screen', async () => {
    const { app, runtime } = setUp('operator')
    await publishPackage(app, runtime)
    expect((await app.request('/tiktok/ui/index.html')).status).toBe(200)
  })
})

describe('GET /:name/ui/* — route ordering', () => {
  test('/:name/:version still answers, and /ui is not swallowed by it', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    const version = await app.request('/tiktok/1.0.0')
    expect(version.status).toBe(200)
    expect((await app.request('/tiktok/ui/index.html')).status).toBe(200)
  })

  test('two versions of one plugin keep separate assets — a rollback serves the right screen', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime, { version: '1.0.0', ui: [{ path: 'index.html', data: enc.encode('v1') }] })
    await publishPackage(app, runtime, { version: '2.0.0', ui: [{ path: 'index.html', data: enc.encode('v2') }] })

    expect(await (await app.request('/tiktok/ui/index.html')).text()).toBe('v2')
    runtime.rollback('tiktok', '1.0.0')
    expect(await (await app.request('/tiktok/ui/index.html')).text()).toBe('v1')
  })
})

/**
 * Plan 111 §4.4, §5 step 111.6 — a DEV SLOT carries `ui/` too.
 *
 * Plan 108 §9 Q3 recorded the opposite as a known gap: `enkaku dev` posted a
 * bare bundle, so a slot structurally had no assets and `runtime.uiAsset`
 * resolved only the ACTIVE row. A React view was therefore impossible to
 * iterate — every asset it asked for answered 404 until it was published.
 * These tests are that gap closed, from the route inwards.
 */
describe('POST /dev — a dev slot carries and serves its own ui/ assets', () => {
  /** Pushes a `.enkaku` package through the real `POST /dev` package branch. */
  async function pushDevPackage(app: Hono<AuthEnv>, opts: { name?: string; ui?: Array<{ path: string; data: Uint8Array<ArrayBuffer> }> } = {}) {
    const bytes = writePluginPackage({
      manifest: { name: opts.name ?? 'tiktok', version: '1.0.0' },
      scripts: 'export {}',
      ui: opts.ui ?? [{ path: 'index.js', data: enc.encode('dev-one') }],
      mtimeSec: 1_700_000_000,
    })
    const res = await app.request('/dev', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes })
    expect(res.status).toBe(200)
    return (await res.json()) as { ok: boolean }
  }

  test('a slot with no published version at all still serves its screen', async () => {
    const { app } = setUp('admin')
    const report = await pushDevPackage(app)
    expect(report.ok).toBe(true)

    const res = await app.request('/tiktok/ui/index.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await res.text()).toBe('dev-one')
  })

  test('a rebuild REPLACES the slot’s assets — criterion 8, never a cached old one', async () => {
    const { app } = setUp('admin')
    await pushDevPackage(app)
    expect(await (await app.request('/tiktok/ui/index.js')).text()).toBe('dev-one')

    await pushDevPackage(app, { ui: [{ path: 'index.js', data: enc.encode('dev-two') }] })
    expect(await (await app.request('/tiktok/ui/index.js')).text()).toBe('dev-two')
  })

  test('a rebuild that DROPS a file stops serving it, rather than leaving it behind', async () => {
    const { app } = setUp('admin')
    await pushDevPackage(app, {
      ui: [
        { path: 'index.js', data: enc.encode('dev-one') },
        { path: 'extra.css', data: enc.encode('.a{}') },
      ],
    })
    expect((await app.request('/tiktok/ui/extra.css')).status).toBe(200)

    await pushDevPackage(app, { ui: [{ path: 'index.js', data: enc.encode('dev-two') }] })
    expect((await app.request('/tiktok/ui/extra.css')).status).toBe(404)
    expect(await (await app.request('/tiktok/ui/index.js')).text()).toBe('dev-two')
  })

  test('a rebuild with NO ui/ at all clears what the previous build stored', async () => {
    const { app } = setUp('admin')
    await pushDevPackage(app)
    expect((await app.request('/tiktok/ui/index.js')).status).toBe(200)

    // The JSON transport carries no assets — the same shape a script-only
    // `enkaku dev` posts.
    const res = await app.request('/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'tiktok', bundle: 'export {}' }) })
    expect(res.status).toBe(200)
    expect((await app.request('/tiktok/ui/index.js')).status).toBe(404)
  })

  test('a dev slot SHADOWS the active published version’s assets, the way it already shadows its scripts', async () => {
    const { app, runtime } = setUp('admin')
    await publishPackage(app, runtime, { ui: [{ path: 'index.js', data: enc.encode('published') }] })
    expect(await (await app.request('/tiktok/ui/index.js')).text()).toBe('published')

    await pushDevPackage(app)
    expect(await (await app.request('/tiktok/ui/index.js')).text()).toBe('dev-one')

    // ...and the published screen comes back the moment the slot is dropped.
    expect((await app.request('/dev/tiktok', { method: 'DELETE' })).status).toBe(200)
    expect(await (await app.request('/tiktok/ui/index.js')).text()).toBe('published')
  })

  test('dropping a slot deletes its bytes — a dev slot’s assets never outlive it', async () => {
    const { app } = setUp('admin')
    await pushDevPackage(app)
    expect((await app.request('/tiktok/ui/index.js')).status).toBe(200)
    // One index file (the slot's) and one blob.
    expect(readdirSync(join(dataDir, 'plugins/index'))).toHaveLength(1)
    expect(readdirSync(join(dataDir, 'plugins/assets'))).toHaveLength(1)

    expect((await app.request('/dev/tiktok', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/tiktok/ui/index.js')).status).toBe(404)
    expect(readdirSync(join(dataDir, 'plugins/index'))).toHaveLength(0)
    // The blob is swept too — the surviving indexes ARE the reference count.
    expect(readdirSync(join(dataDir, 'plugins/assets'))).toHaveLength(0)
  })

  test('dropping a slot leaves a published version’s assets alone — the sweep is by reachability, not by name', async () => {
    const { app, runtime } = setUp('admin')
    await publishPackage(app, runtime, { ui: [{ path: 'index.js', data: enc.encode('published') }] })
    await pushDevPackage(app, { name: 'scratch' })

    expect((await app.request('/dev/scratch', { method: 'DELETE' })).status).toBe(200)
    expect(await (await app.request('/tiktok/ui/index.js')).text()).toBe('published')
  })
})
