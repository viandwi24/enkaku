import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PluginResetResponseSchema, type PluginResetItem, type PluginServiceDeclaration } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import { auditLog } from '../db/schema'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createKvStore, type KvStore } from '../kv/store'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createPluginRuntime, type PluginRuntime } from '../plugins/runtime'
import type { PluginResetOutcome, RuntimeHost } from '../plugins/runtime-host'
import type { VerifyReport } from '../plugins/verify-child'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
import { createPluginRoutes } from './plugins'

/**
 * `POST /api/plugins/:name/reset` — **Reset data.**
 *
 * Against a REAL `Db`, a REAL `KvStore` and the REAL `PluginRuntime`, in the
 * setup style of `plugins-data.test.ts` and for the same reason: the two claims
 * this route makes are claims about what actually reaches SQLite, not about
 * what a mock was told.
 *
 * The runtime HOST is the one stub, because what has to be varied here is
 * exactly what a plugin's cleanup handler reported — and the point of the whole
 * feature is that the report decides whether a single row is deleted.
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

const DECLARED_RESET: PluginServiceDeclaration = {
  permissions: ['device.list'],
  isolation: 'in-process',
  listeners: [],
  events: [],
  webhooks: [],
  resetData: { permissions: ['device.network.clear'], description: 'Turns every route this plugin applied back off.' },
}

function report(service?: PluginServiceDeclaration): VerifyReport {
  return {
    ok: true,
    version: '1.0.0',
    scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: null }],
    resetPackages: [],
    ...(service ? { service } : {}),
  }
}

/**
 * Every `RuntimeHost` method, so the route gets a real object rather than a
 * cast — and so this list is a standing statement of what the reset route is
 * allowed to touch. Anything but `resetData` throws if the route ever reaches
 * for it.
 */
function stubHost(resetData: (name: string) => Promise<PluginResetOutcome>): RuntimeHost {
  const nope = (what: string) => () => {
    throw new Error(`the reset route must not call RuntimeHost.${what}`)
  }
  return {
    resetData,
    list: nope('list'),
    get: nope('get'),
    load: nope('load'),
    unload: nope('unload'),
    reload: nope('reload'),
    loadActive: nope('loadActive'),
    unloadAll: nope('unloadAll'),
    invoke: nope('invoke'),
    lookupHandler: nope('lookupHandler'),
    noteSocket: nope('noteSocket'),
    handleLifecycle: nope('handleLifecycle'),
    observeEvent: nope('observeEvent'),
    processRssBytes: nope('processRssBytes'),
    dispose: nope('dispose'),
  }
}

function clean(items: PluginResetItem[] = []): PluginResetOutcome {
  return { declared: true, ran: true, skipped: null, error: null, report: { items } }
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-reset-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

interface Harness {
  db: Db
  kv: KvStore
  runtime: PluginRuntime
  app: Hono<AuthEnv>
}

function setUp(opts: { resetData?: (name: string) => Promise<PluginResetOutcome>; role?: 'admin' | 'operator' | null; service?: PluginServiceDeclaration } = {}): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify: async () => report(opts.service) })
  const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 10_000_000 }))
  const audit = createAuditLogger(db)
  const host = stubHost(opts.resetData ?? (async () => clean()))
  const app = withRole(opts.role ?? 'admin', createPluginRoutes({ runtime, audit, workspace, data: { db, kv }, service: { host } }))
  return { db, kv, runtime, app }
}

async function activate(runtime: PluginRuntime, name: string): Promise<void> {
  const staged = await runtime.stage({ name, version: '1.0.0', bundle: 'export {}' })
  await runtime.verify(staged.id)
  runtime.activate(staged.id)
}

function seedDevice(db: Db, n: number): { id: string; stableId: string } {
  const id = `d${n}`
  const stableId = `s${n}`
  db.insert(devices).values({ id, stableId, serial: `ser-${n}`, label: `Pixel ${n}`, status: 'idle' }).run()
  return { id, stableId }
}

/** Two global rows and one per device, so the response's scope split has something to be wrong about. */
function seedData(kv: KvStore, name: string, stableIds: string[]): void {
  kv.set({ kind: 'global' }, name, 'catalogue', { a: 1 })
  kv.set({ kind: 'global' }, name, 'other', { b: 2 })
  for (const stableId of stableIds) kv.set({ kind: 'device', stableId }, name, 'assigned', { proxy: 'proxy:x' })
}

function countAll(kv: KvStore, name: string, stableIds: string[]): number {
  let n = kv.list({ kind: 'global' }, name, { limit: 200 }).items.length
  for (const stableId of stableIds) n += kv.list({ kind: 'device', stableId }, name, { limit: 200 }).items.length
  return n
}

describe('POST /api/plugins/:name/reset', () => {
  test('the handler runs BEFORE the data is deleted, and the data is gone afterwards', async () => {
    let sawWhileRunning = -1
    let deviceRowWhileRunning = -1
    const h = setUp({
      service: DECLARED_RESET,
      resetData: async (name) => {
        // The whole feature, asserted from inside the handler's own moment: its
        // data has to still be there, because its data is what tells it which
        // phones it touched.
        sawWhileRunning = h.kv.list({ kind: 'global' }, name, { limit: 200 }).items.length
        deviceRowWhileRunning = h.kv.list({ kind: 'device', stableId: 's1' }, name, { limit: 200 }).items.length
        return clean([{ kind: 'device', id: 's1', outcome: 'cleared', message: 'route off' }])
      },
    })
    const d = seedDevice(h.db, 1)
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [d.stableId])

    const res = await h.app.request('/pm/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = PluginResetResponseSchema.parse(await res.json())

    expect(sawWhileRunning).toBe(2)
    expect(deviceRowWhileRunning).toBe(1)
    expect(body.status).toBe('reset')
    expect(body.data).toMatchObject({ deleted: true, entries: 3, global: 2, device: 1, devices: 1 })
    expect(countAll(h.kv, 'pm', [d.stableId])).toBe(0)
  })

  test('a failed cleanup item deletes NOTHING — not even the rows for the parts that succeeded', async () => {
    const h = setUp({
      service: DECLARED_RESET,
      resetData: async () =>
        clean([
          { kind: 'device', id: 's1', outcome: 'cleared', message: 'route off' },
          { kind: 'device', id: 's2', outcome: 'failed', message: 'somebody is driving this phone' },
        ]),
    })
    const a = seedDevice(h.db, 1)
    const b = seedDevice(h.db, 2)
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [a.stableId, b.stableId])
    const before = countAll(h.kv, 'pm', [a.stableId, b.stableId])

    const res = await h.app.request('/pm/reset', { method: 'POST' })
    const body = PluginResetResponseSchema.parse(await res.json())

    expect(res.status).toBe(200)
    expect(body.status).toBe('blocked')
    expect(body.data.deleted).toBe(false)
    expect(body.data.entries).toBe(0)
    expect(body.data.keptBecause).toContain('Nothing was deleted')
    expect(body.message).toContain('was NOT reset')
    expect(countAll(h.kv, 'pm', [a.stableId, b.stableId])).toBe(before)
  })

  test('a debt is not a failure: the data goes, and the wording never calls it a plain success', async () => {
    const h = setUp({
      service: DECLARED_RESET,
      resetData: async () => clean([{ kind: 'device', id: 's1', outcome: 'pending', message: 'offline — the farm owes this phone a teardown' }]),
    })
    const d = seedDevice(h.db, 1)
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [d.stableId])

    const body = PluginResetResponseSchema.parse(await (await h.app.request('/pm/reset', { method: 'POST' })).json())
    expect(body.status).toBe('reset-with-debts')
    expect(body.data.deleted).toBe(true)
    expect(body.handler.counts.pending).toBe(1)
    expect(body.message).toContain('still owed')
    expect(countAll(h.kv, 'pm', [d.stableId])).toBe(0)
  })

  test('failures come first, then debts', async () => {
    const h = setUp({
      service: DECLARED_RESET,
      resetData: async () =>
        clean([
          { kind: 'device', id: 'ok', outcome: 'cleared', message: 'a' },
          { kind: 'device', id: 'left', outcome: 'unchanged', message: 'b' },
          { kind: 'device', id: 'owed', outcome: 'pending', message: 'c' },
          { kind: 'device', id: 'bad', outcome: 'failed', message: 'd' },
        ]),
    })
    await activate(h.runtime, 'pm')
    const body = PluginResetResponseSchema.parse(await (await h.app.request('/pm/reset', { method: 'POST' })).json())
    expect(body.handler.items.map((i) => i.id)).toEqual(['bad', 'owed', 'ok', 'left'])
  })

  test('a handler that could not run blocks the delete and says why', async () => {
    const h = setUp({
      service: DECLARED_RESET,
      resetData: async () => ({
        declared: true,
        ran: false,
        skipped: { code: 'E_PLUGIN_RUNTIME_NOT_RUNNING', message: 'its service is "stopped"' },
        error: null,
        report: { items: [] },
      }),
    })
    const d = seedDevice(h.db, 1)
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [d.stableId])

    const body = PluginResetResponseSchema.parse(await (await h.app.request('/pm/reset', { method: 'POST' })).json())
    expect(body.status).toBe('blocked')
    expect(body.data.deleted).toBe(false)
    expect(body.handler.skipped?.code).toBe('E_PLUGIN_RUNTIME_NOT_RUNNING')
    expect(countAll(h.kv, 'pm', [d.stableId])).toBeGreaterThan(0)
  })

  test('a handler that threw blocks the delete', async () => {
    const h = setUp({
      service: DECLARED_RESET,
      resetData: async () => ({ declared: true, ran: true, skipped: null, error: { code: 'E_PLUGIN_HANDLER_FAILED', message: 'boom' }, report: { items: [] } }),
    })
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [])
    const body = PluginResetResponseSchema.parse(await (await h.app.request('/pm/reset', { method: 'POST' })).json())
    expect(body.status).toBe('blocked')
    expect(body.data.deleted).toBe(false)
    expect(body.handler.error?.code).toBe('E_PLUGIN_HANDLER_FAILED')
  })

  test('a plugin with no cleanup handler still resets, and says there was nothing to undo', async () => {
    const h = setUp({ resetData: async () => ({ declared: false, ran: false, skipped: null, error: null, report: { items: [] } }) })
    const d = seedDevice(h.db, 1)
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [d.stableId])

    const body = PluginResetResponseSchema.parse(await (await h.app.request('/pm/reset', { method: 'POST' })).json())
    expect(body.status).toBe('reset')
    expect(body.handler.declared).toBe(false)
    expect(body.message).toContain('nothing to undo')
    expect(countAll(h.kv, 'pm', [d.stableId])).toBe(0)
  })

  test("it never touches another plugin's namespace", async () => {
    const h = setUp()
    const d = seedDevice(h.db, 1)
    await activate(h.runtime, 'pm')
    await activate(h.runtime, 'other')
    seedData(h.kv, 'pm', [d.stableId])
    seedData(h.kv, 'other', [d.stableId])

    await h.app.request('/pm/reset', { method: 'POST' })
    expect(countAll(h.kv, 'pm', [d.stableId])).toBe(0)
    expect(countAll(h.kv, 'other', [d.stableId])).toBe(3)
  })

  test('a plugin with no ACTIVE version is refused rather than having its data deleted', async () => {
    const h = setUp()
    const d = seedDevice(h.db, 1)
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [d.stableId])
    h.runtime.disable('pm')

    const res = await h.app.request('/pm/reset', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(countAll(h.kv, 'pm', [d.stableId])).toBe(3)
  })

  test('an operator cannot reset — `script.delete` is admin-only, the same gate the removal routes carry', async () => {
    const h = setUp({ role: 'operator' })
    await activate(h.runtime, 'pm')
    seedData(h.kv, 'pm', [])
    const res = await h.app.request('/pm/reset', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(countAll(h.kv, 'pm', [])).toBe(2)
  })

  test('a blocked pass is audited as loudly as a successful one, and names the devices still carrying something', async () => {
    const h = setUp({
      service: DECLARED_RESET,
      resetData: async () =>
        clean([
          { kind: 'device', id: 's-owed', outcome: 'pending', message: 'the phone was away, so the farm owes it a teardown' },
          { kind: 'device', id: 's-bad', outcome: 'failed', message: 'PROSE-THAT-MUST-NOT-BE-AUDITED' },
        ]),
    })
    await activate(h.runtime, 'pm')
    await h.app.request('/pm/reset', { method: 'POST' })

    const rows = h.db.select().from(auditLog).all().filter((r) => r.action === 'plugin.reset')
    expect(rows).toHaveLength(1)
    const meta = rows[0]?.meta as Record<string, unknown>
    expect(meta.status).toBe('blocked')
    expect(meta.deleted).toBe(false)
    expect(meta.failedIds).toEqual(['s-bad'])
    expect(meta.pendingIds).toEqual(['s-owed'])
    // Never the plugin's own prose — an item's message is author-written text
    // up to six hundred characters, and the audit log is not where it belongs.
    expect(JSON.stringify(meta)).not.toContain('PROSE-THAT-MUST-NOT-BE-AUDITED')
  })
})
