import { mkdtempSync, rmSync } from 'node:fs'
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

  test('every response carries the strict CSP, nosniff, and no-store', async () => {
    const { app, runtime } = setUp()
    await publishPackage(app, runtime)

    for (const path of ['index.html', 'app.js', 'assets/logo.png']) {
      const res = await app.request(`/tiktok/ui/${path}`)
      expect(res.status).toBe(200)
      const csp = res.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("default-src 'none'")
      // The sandbox is re-applied by the SERVER, and never with `allow-same-origin`.
      expect(csp).toContain('sandbox allow-scripts')
      expect(csp).not.toContain('allow-same-origin')
      // No fetch/XHR/WebSocket at all — criterion 16's structural half.
      expect(csp).toContain("connect-src 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("base-uri 'none'")
      // No external host anywhere in the policy except the loopback dev-server
      // grant on `frame-ancestors`, which admits a framer, never a source.
      expect(csp).not.toMatch(/(script|style|img|font|media|connect)-src[^;]*https?:\/\/(?!localhost|127)/)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
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
