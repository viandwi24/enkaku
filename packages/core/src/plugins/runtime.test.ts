import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { PluginManifestSchema } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { jobs, plugins, scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
import { createPluginAssetStore } from './asset-store'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import type { VerifyReport } from './verify-child'

function healthyReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    ok: true,
    pluginId: 'tiktok',
    version: '1.0.0',
    scripts: [
      { id: 'login', paramsSchema: { type: 'object' }, runtime: null },
      { id: 'warmup', paramsSchema: { type: 'object' }, runtime: null },
    ],
    resetPackages: ['com.zhiliaoapp.musically'],
    ...overrides,
  }
}

function setUp(opts?: { verify?: (bundlePath: string, o?: { expectedVersion?: string }) => Promise<VerifyReport> }) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const dataDir = `/tmp/enkaku-plugin-runtime-test-${crypto.randomUUID()}`
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
  const runtime = createPluginRuntime({
    db,
    dataDir,
    registry,
    kv,
    verify: opts?.verify ?? (async () => healthyReport()),
  })
  return { db, runtime, registry, kv, dataDir }
}

async function stageAndVerify(runtime: PluginRuntime, opts: { name?: string; version?: string; bundle?: string } = {}) {
  const p = await runtime.stage({ name: opts.name ?? 'tiktok', version: opts.version ?? '1.0.0', bundle: opts.bundle ?? 'export {}' })
  await runtime.verify(p.id)
  return runtime.get(p.name, p.version)!
}

describe('PluginRuntime — stage/verify/activate (criteria 1, 6, 7)', () => {
  test('a healthy plugin publishes as one plugins row, one bundle, N scripts rows named <plugin>/<script> (criterion 1)', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    const activated = runtime.activate(staged.id)
    expect(activated.status).toBe('active')
    const rows = db.select().from(scripts).all()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.name).sort()).toEqual(['tiktok/login', 'tiktok/warmup'])
    for (const r of rows) {
      expect(r.pluginId).toBe(staged.id)
      expect(r.bundle).toBe('export {}') // one bundle, shared verbatim
      expect(r.version).toBe('1.0.0')
    }
  })

  test('@latest resolves to nothing while only staged versions exist, and to the active version once activated (criterion 7)', async () => {
    const { runtime, registry } = setUp()
    const staged = await stageAndVerify(runtime)
    expect(() => registry.resolve('tiktok/login@latest')).toThrow(EnkakuError)
    runtime.activate(staged.id)
    const entry = registry.resolve('tiktok/login@latest')
    expect(entry.version).toBe('1.0.0')
  })

  test('publishing and activating 1.1.0 does not change what an already-resolved 1.0.0 job runs (criterion 6)', async () => {
    const { runtime, registry } = setUp()
    const v1 = await stageAndVerify(runtime)
    runtime.activate(v1.id)
    // A "job" pins the CONCRETE entry at enqueue time, exactly like plan 62's own precedent.
    const pinned = registry.resolve('tiktok/login@1.0.0')

    const v2 = await stageAndVerify(runtime, { version: '1.1.0', bundle: 'export {} // v1.1.0' })
    runtime.activate(v2.id)

    // The already-pinned entry is untouched — same id, same bundle reference.
    const stillPinned = registry.resolve('tiktok/login@1.0.0')
    expect(stillPinned.id).toBe(pinned.id)
    expect(stillPinned.bundle).toEqual(pinned.bundle)
    // @latest now resolves to the NEW version — future enqueues only.
    expect(registry.resolve('tiktok/login@latest').version).toBe('1.1.0')
  })
})

describe('PluginRuntime — the runtime envelope persists through activation (plan 98 §3.1, §5 step 98.4)', () => {
  test('a member\'s declared runtime lands on its scripts row, readable through the registry by scriptId alone', async () => {
    const declared = { timeoutMs: 45_000, maxRssBytes: 128 * 1024 * 1024 }
    const { runtime, registry } = setUp({
      verify: async () => healthyReport({ scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: declared }] }),
    })
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    const entry = registry.get(`${staged.id}:login`)
    expect(entry?.runtime).toEqual(declared)
  })

  test('a member declaring no runtime persists null, not undefined or a parse failure', async () => {
    const { runtime, registry } = setUp() // the default healthyReport() already declares runtime: null for every member.
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    const entry = registry.get(`${staged.id}:login`)
    expect(entry?.runtime).toBeNull()
  })

  test('a dev slot carries its own member runtime the same way (plan 82\'s in-memory path, plan 98 §3.1)', async () => {
    const declared = { maxConcurrent: 2 }
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db: Db = opened.db
    const dataDir = `/tmp/enkaku-plugin-runtime-test-${crypto.randomUUID()}`
    const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
    // A dev slot lives ONLY in the DevSlotStore, so — matching the "dev
    // slots" describe block below — the SAME instance must be threaded into
    // both `registry` (the reader) and `runtime` (the writer), or the two
    // never see each other's state, exactly like a real daemon.ts boot wires
    // one shared store into both.
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const runtime = createPluginRuntime({
      db,
      dataDir,
      registry,
      kv,
      devSlots,
      verify: async () => healthyReport({ scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: declared }] }),
    })
    const report = await runtime.putDevSlot({
      name: 'tiktok',
      owner: { kind: 'cli', label: 'me@host' },
      source: { kind: 'bundle', bundle: 'export {}' },
    })
    expect(report.ok).toBe(true)
    const entry = registry.get('dev:tiktok/login')
    expect(entry?.runtime).toEqual(declared)
  })
})

// Plan 108 §5 step 108.3 — a minimal but complete surface, in the PARSED
// shape a `VerifyReport` carries (every default already applied by
// `validatePluginSurface` in `verify-child.ts`), because that is what
// `runtime.verify` is handed.
const SURFACE: NonNullable<VerifyReport['surface']> = {
  nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
  views: {
    accounts: {
      title: 'TikTok accounts',
      data: { kind: 'kv.list', scope: 'global', prefix: '' },
      table: { rowKey: 'username', columns: [{ field: 'username', header: 'Account', width: 'auto' }], selectable: false },
      toolbar: ['sync'],
      rowActions: [],
    },
  },
  actions: { sync: { kind: 'batch', label: 'Sync accounts', script: 'tiktok/login@latest', target: 'picker' } },
}

describe('PluginRuntime — the surface persists through activation (plan 108 §5 step 108.3)', () => {
  test('a verified surface survives verify → activate and reads back through surface(name)', async () => {
    const { runtime } = setUp({ verify: async () => healthyReport({ surface: SURFACE }) })
    const staged = await stageAndVerify(runtime)
    // Stored in the manifest at VERIFY time, alongside the script list.
    expect(runtime.get('tiktok', '1.0.0')?.manifest).toMatchObject({ surface: { nav: SURFACE.nav } })
    runtime.activate(staged.id)
    const surface = runtime.surface('tiktok')
    expect(surface).toEqual(SURFACE)
  })

  test('surface(name) answers null for a plugin that is not active, and for one that never declared a surface', async () => {
    const { runtime } = setUp({ verify: async () => healthyReport({ surface: SURFACE }) })
    const staged = await stageAndVerify(runtime)
    expect(runtime.surface('tiktok')).toBeNull() // verified but not yet activated
    runtime.activate(staged.id)
    expect(runtime.surface('tiktok')).not.toBeNull()
    runtime.disable('tiktok')
    expect(runtime.surface('tiktok')).toBeNull()
    expect(runtime.surface('no-such-plugin')).toBeNull()
  })

  test('a plugin declaring NO surface writes the manifest it wrote before this plan, key for key (acceptance criterion 1)', async () => {
    const { runtime } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    const manifest = runtime.get('tiktok', '1.0.0')?.manifest
    expect(Object.keys(manifest as Record<string, unknown>)).toEqual(['scripts'])
    expect(runtime.surface('tiktok')).toBeNull()
  })

  test('a manifest written BEFORE this step reads back null rather than throwing', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    // Exactly what plan 82 wrote: a `scripts` array and nothing else.
    db.update(plugins).set({ manifest: { scripts: [{ id: 'login', paramsSchema: { type: 'object' } }] } }).where(eq(plugins.id, staged.id)).run()
    expect(runtime.surface('tiktok')).toBeNull()
  })

  test('a manifest whose stored surface no longer parses degrades to null, never a throw (the parseScriptRuntime discipline)', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    db.update(plugins)
      .set({ manifest: { scripts: [], surface: { nav: [{ id: 'x', label: 'X', icon: 'not-a-lucide-icon', view: 'gone' }], views: {}, actions: {} } } })
      .where(eq(plugins.id, staged.id))
      .run()
    expect(runtime.surface('tiktok')).toBeNull()
  })

  test('a member\'s title and description reach the manifest and are readable (plan 108 §0.2 P8)', async () => {
    const { runtime } = setUp({
      verify: async () =>
        healthyReport({
          scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: null, title: 'Log in', description: 'Signs the device in.' }],
        }),
    })
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    const manifest = PluginManifestSchema.parse(runtime.get('tiktok', '1.0.0')?.manifest)
    expect(manifest?.scripts[0]).toMatchObject({ id: 'login', title: 'Log in', description: 'Signs the device in.' })
  })
})

describe('PluginRuntime — rollback (criterion 8)', () => {
  test('rollback works without re-publishing and without a bundle upload', async () => {
    const { runtime, registry } = setUp()
    const v1 = await stageAndVerify(runtime)
    runtime.activate(v1.id)
    const v2 = await stageAndVerify(runtime, { version: '2.0.0', bundle: 'v2-bundle' })
    runtime.activate(v2.id)
    expect(runtime.get('tiktok', '2.0.0')?.status).toBe('active')
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('superseded')

    const rolled = runtime.rollback('tiktok', '1.0.0')
    expect(rolled.status).toBe('active')
    expect(runtime.get('tiktok', '2.0.0')?.status).toBe('superseded')
    expect(registry.resolve('tiktok/login@latest').version).toBe('1.0.0')
  })

  test('rolling back to a non-existent version is refused', async () => {
    const { runtime } = setUp()
    const v1 = await stageAndVerify(runtime)
    runtime.activate(v1.id)
    expect(() => runtime.rollback('tiktok', '9.9.9')).toThrow(EnkakuError)
  })
})

describe('PluginRuntime — activation CAS (criterion 9)', () => {
  test('activate called twice concurrently results in exactly one active version', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    let succeeded = 0
    let conflicted = 0
    // Real overlapping calls against the same underlying bun:sqlite connection —
    // both read `status: 'staged'` is impossible here (synchronous single-writer),
    // so this proves the CAS's WHERE clause, not merely "only one call happened".
    for (const _ of [0, 1]) {
      try {
        runtime.activate(staged.id)
        succeeded++
      } catch (err) {
        expect(err).toBeInstanceOf(EnkakuError)
        expect((err as EnkakuError).code).toBe('plugin_activate_conflict')
        conflicted++
      }
    }
    expect(succeeded).toBe(1)
    expect(conflicted).toBe(1)
    const rows = db.select().from(scripts).all()
    expect(rows).toHaveLength(2) // not duplicated by the failed second attempt
  })

  test('activate refuses a plugin that has not passed verification', async () => {
    const { runtime } = setUp()
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    expect(() => runtime.activate(staged.id)).toThrow(EnkakuError)
  })
})

describe('PluginRuntime — versions (criterion 10)', () => {
  test('a member declaring a version different from the plugin is refused, naming it', async () => {
    const { runtime } = setUp({
      verify: async () => ({ ok: false, error: 'script "login" declares version "2.0.0", which does not match the plugin\'s own "1.0.0"', errorCode: 'E_VERSION_MISMATCH', scripts: [], resetPackages: [] }),
    })
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    const report = await runtime.verify(staged.id)
    expect(report.ok).toBe(false)
    expect(report.error).toContain('login')
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('failed')
  })

  test('a bundle whose reported version does not match the staged row is refused (E_PLUGIN_VERSION_MISMATCH)', async () => {
    const { runtime } = setUp({ verify: async () => healthyReport({ version: '9.9.9' }) })
    // verify-child.ts itself does the expectedVersion check; here we simulate it directly
    // by having the injected verify fn report a version that doesn't match what was staged.
    // runtime.verify passes `expectedVersion: p.version` through to the injected fn, so a
    // real verify-child.ts would catch this — this test proves runtime surfaces whatever it reports.
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    const report = await runtime.verify(staged.id)
    expect(report.version).toBe('9.9.9')
    // Activation still requires manifest + verifiedAt, which WERE set (the fake verify said ok:true) —
    // this documents that expectedVersion enforcement lives in verify-child.ts, not runtime.ts (unit-tested there).
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('staged')
  })
})

describe('PluginRuntime — fault isolation (§3.8, criteria 20, 22, 23)', () => {
  test('a plugin whose bundle fails verification is recorded failed with its error, and nothing else is disturbed', async () => {
    const { runtime } = setUp({ verify: async () => ({ ok: false, error: 'SyntaxError: boom', errorCode: 'E_PLUGIN_VERIFY_FAILED', scripts: [], resetPackages: [] }) })
    const staged = await runtime.stage({ name: 'broken', version: '1.0.0', bundle: 'export {}' })
    const report = await runtime.verify(staged.id)
    expect(report.ok).toBe(false)
    const row = runtime.get('broken', '1.0.0')
    expect(row?.status).toBe('failed')
    expect(row?.verifyError).toContain('boom')
  })

  test('duplicate script ids are refused at publish (verify), naming both — plugin stays failed, not partially active', async () => {
    const { runtime } = setUp({
      verify: async () => ({ ok: false, error: 'duplicate script id "a"', errorCode: 'E_PLUGIN_DUPLICATE_SCRIPT_ID', scripts: [], resetPackages: [] }),
    })
    const staged = await runtime.stage({ name: 'dup', version: '1.0.0', bundle: 'export {}' })
    const report = await runtime.verify(staged.id)
    expect(report.errorCode).toBe('E_PLUGIN_DUPLICATE_SCRIPT_ID')
    expect(() => runtime.activate(staged.id)).toThrow(EnkakuError)
  })

  test('a NEW VERSION of the same plugin re-publishing the same script names is never a conflict (regression: the check keys on plugin NAME, not plugin ROW id)', async () => {
    const { runtime, registry } = setUp()
    const v1 = await stageAndVerify(runtime)
    runtime.activate(v1.id)
    const v2 = await stageAndVerify(runtime, { version: '1.1.0', bundle: 'v1.1.0' })
    const report = await runtime.verify(v2.id) // stageAndVerify already verified; re-verify is idempotent
    expect(report.ok).toBe(true)
    runtime.activate(v2.id)
    expect(registry.resolve('tiktok/login@latest').version).toBe('1.1.0')
  })

  test('E_PLUGIN_NAME_CONFLICT — a plugin cannot claim a name an unowned row already occupies, naming both, and nothing about that row changes (criterion 23)', async () => {
    const { runtime, registry, db } = setUp()
    // A row published before a script had to belong to a plugin (plan 110 §3.2), under the
    // exact literal name a plugin's own naming scheme would also produce. The farm no longer
    // resolves it — but it still occupies that `(name, version)`, so a plugin claiming the
    // name has to be refused HERE rather than colliding on the unique index later.
    db.insert(scripts)
      .values({ id: 'unowned-1', name: 'tiktok/login', version: '1.0.0', bundle: 'a bundle', enabled: true, createdAt: new Date() })
      .run()

    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'plugin bundle' })
    const report = await runtime.verify(staged.id)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_NAME_CONFLICT')
    expect(report.error).toContain('tiktok/login')
    expect(report.error).toContain('before a script had to belong to a plugin')
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('failed')
    // The row is untouched — still on disk, and still not something the farm will resolve.
    expect(db.select().from(scripts).where(eq(scripts.id, 'unowned-1')).get()).toBeTruthy()
    expect(() => registry.resolve('tiktok/login@1.0.0')).toThrow(EnkakuError)
  })
})

describe('PluginRuntime — reload/restart (criteria 25, 26)', () => {
  test('reload(name) on a failed plugin whose bundle has since been fixed brings it to active', async () => {
    let healthy = false
    const { runtime } = setUp({ verify: async () => (healthy ? healthyReport() : { ok: false, error: 'still broken', errorCode: 'E_X', scripts: [], resetPackages: [] }) })
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'b' })
    await runtime.verify(staged.id)
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('failed')

    healthy = true
    const report = await runtime.reload('tiktok')
    expect(report.ok).toBe(true)
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('active')
  })

  /**
   * The regression this file was missing, and the shape of the bug is why:
   * `reload` on a HEALTHY, ACTIVE plugin left it `staged` — off — while
   * returning 200 and `ok: true`. Every existing test reloaded a `failed` row,
   * which reaches `active` through the same branch, so the whole suite stayed
   * green while the common case was broken.
   *
   * The cause was a stale read: `reloadImpl` captured the row (status `active`),
   * `verifyImpl` then set it to `staged` as it does for every row it verifies,
   * and the re-activate branch was guarded on the pre-verify value. Observed on
   * a live farm — one reload took a plugin's screen and its service down.
   *
   * Asserted on the OUTCOME an operator cares about (still active, still
   * resolving) rather than on the internals, so a future refactor of the
   * transition cannot satisfy it vacuously.
   */
  test('reload(name) on a healthy ACTIVE plugin leaves it active — it must not be demoted to staged', async () => {
    const { runtime } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('active')

    const report = await runtime.reload('tiktok')

    expect(report.ok).toBe(true)
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('active')
    // The point of the fix, stated separately: the plugin is still the one the
    // farm resolves. A row parked at `staged` answers neither.
    expect(runtime.active('tiktok')?.id).toBe(staged.id)
  })

  test('restart() re-derives every active plugin and reports ok/failed counts without touching status on a re-verify failure', async () => {
    let fail = false
    const { runtime } = setUp({ verify: async () => (fail ? { ok: false, error: 'now broken', errorCode: 'E_X', scripts: [], resetPackages: [] } : healthyReport()) })
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)

    const firstRestart = await runtime.restart()
    expect(firstRestart.ok).toBe(1)
    expect(firstRestart.failed).toBe(0)

    fail = true
    const secondRestart = await runtime.restart()
    expect(secondRestart.failed).toBe(1)
    // §3.9 — restart never demotes an already-active plugin.
    expect(runtime.active('tiktok')?.status).toBe('active')
  })
})

describe('PluginRuntime — disable/remove (criteria 24-ish, 28)', () => {
  test('disable stops a plugin\'s scripts from resolving; queued-job claim would fail with a named error via the existing script_disabled path', async () => {
    const { runtime, registry, db } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    runtime.disable('tiktok')
    expect(() => registry.resolve('tiktok/login@1.0.0')).toThrow(EnkakuError)
    try {
      registry.resolve('tiktok/login@1.0.0')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('script_disabled')
    }
    const rows = db.select().from(scripts).all()
    expect(rows.every((r) => r.enabled === false)).toBe(true)
  })

  test('enable is the way back: disable → enable restores the row AND every member scripts row', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    runtime.disable('tiktok')
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('disabled')
    expect(db.select().from(scripts).all().every((r) => r.enabled === false)).toBe(true)

    const enabled = runtime.enable('tiktok')
    expect(enabled.status).toBe('active')
    expect(runtime.active('tiktok')?.id).toBe(staged.id)
    // The half that is easy to forget — `writeScriptRows` skips existing rows,
    // so nothing else would ever switch these back on.
    const rows = db.select().from(scripts).all()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.enabled === true)).toBe(true)
  })

  test('a script that stopped resolving while disabled resolves again after enable (through the registry, not the table)', async () => {
    const { runtime, registry } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    runtime.disable('tiktok')
    expect(() => registry.resolve('tiktok/login@1.0.0')).toThrow(EnkakuError)

    runtime.enable('tiktok')
    expect(registry.resolve('tiktok/login@1.0.0').version).toBe('1.0.0')
    expect(registry.resolve('tiktok/login@latest').version).toBe('1.0.0')
    // The surface comes back with it, since `surface()` reads the active row.
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('active')
  })

  test('enable on a plugin with no disabled row is plugin_not_found, naming what it looked for', async () => {
    const { runtime } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)

    for (const name of ['tiktok', 'no-such-plugin']) {
      try {
        runtime.enable(name)
        throw new Error(`expected enable("${name}") to throw`)
      } catch (err) {
        expect(err).toBeInstanceOf(EnkakuError)
        expect((err as EnkakuError).code).toBe('plugin_not_found')
        expect((err as EnkakuError).message).toContain(name)
        expect((err as EnkakuError).message).toContain('disabled')
      }
    }
  })

  test('enable is refused when ANOTHER version is active, naming that version and pointing at rollback', async () => {
    const { runtime } = setUp()
    const v1 = await stageAndVerify(runtime)
    runtime.activate(v1.id)
    runtime.disable('tiktok')
    const v2 = await stageAndVerify(runtime, { version: '2.0.0', bundle: 'v2-bundle' })
    runtime.activate(v2.id)

    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('disabled')
    expect(runtime.active('tiktok')?.version).toBe('2.0.0')

    try {
      runtime.enable('tiktok')
      throw new Error('expected enable to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('plugin_enable_conflict')
      expect((err as EnkakuError).message).toContain('2.0.0') // the version that is now active
      expect((err as EnkakuError).message).toContain('roll back')
    }
    // Nothing moved: still exactly one active version, and the disabled row is untouched.
    expect(runtime.active('tiktok')?.version).toBe('2.0.0')
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('disabled')
  })

  test('two concurrent enables: exactly one wins, and no plugin ends up active twice', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    runtime.disable('tiktok')

    let succeeded = 0
    let refused = 0
    for (const _ of [0, 1]) {
      try {
        runtime.enable('tiktok')
        succeeded++
      } catch (err) {
        expect(err).toBeInstanceOf(EnkakuError)
        // The loser is refused because the row it needed is no longer
        // `disabled` — inside one process the lookup catches it before the CAS
        // does (bun:sqlite is a single synchronous connection), which is why
        // the code is `plugin_not_found` rather than the CAS's own conflict.
        expect((err as EnkakuError).code).toBe('plugin_not_found')
        expect((err as EnkakuError).message).toContain('already active')
        refused++
      }
    }
    expect(succeeded).toBe(1)
    expect(refused).toBe(1)
    expect(db.select().from(plugins).all().filter((r) => r.status === 'active')).toHaveLength(1)
    expect(db.select().from(scripts).all()).toHaveLength(2)
  })

  test('removing a plugin with deleteKv: false leaves its KV values; with true, deletes them and reports the count (criterion 28)', async () => {
    const { runtime, db, kv } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)

    // A login script's own state, under the plugin's KV namespace (plan 79 §3.2, plan 82 §3.10).
    kv.set({ kind: 'global' }, 'tiktok', 'session', { token: 'abc' })

    const notFound = runtime.remove('tiktok', '9.9.9', { deleteKv: false }) // no such version
    expect(notFound.removed).toBe(false)

    const kept = runtime.remove('tiktok', '1.0.0', { deleteKv: false })
    expect(kept.removed).toBe(true)
    expect(kept.kvDeleted).toBe(0)
    expect(kv.get({ kind: 'global' }, 'tiktok', 'session')).not.toBeNull() // left alone

    const deleted = kv.deleteNamespace({ kind: 'global' }, 'tiktok')
    expect(deleted).toBe(1) // sanity: the value really was there

    // Re-stage to test the deleteKv: true path with a fresh value.
    const again = await stageAndVerify(runtime, { version: '1.0.1', bundle: 'again' })
    runtime.activate(again.id)
    kv.set({ kind: 'global' }, 'tiktok', 'session', { token: 'def' })
    const result = runtime.remove('tiktok', '1.0.1', { deleteKv: true })
    expect(result.removed).toBe(true)
    expect(result.kvDeleted).toBe(1)
    expect(kv.get({ kind: 'global' }, 'tiktok', 'session')).toBeNull()
    expect(db.select().from(scripts).all()).toHaveLength(0)
  })
})

describe('PluginRuntime — dev slots (criteria 15-19, via the slot store directly; workspace build path covered in scripts/build.test.ts)', () => {
  test('devSlots() reflects the underlying DevSlotStore, carrying its own KV namespace', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db: Db = opened.db
    const dataDir = `/tmp/enkaku-plugin-runtime-test-${crypto.randomUUID()}`
    const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
    const devSlots = createDevSlotStore()
    const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots })
    devSlots.put({ pluginName: 'tiktok', declaredVersion: '1.0.0', bundlePath: '/tmp/x.mjs', scripts: [{ exportId: 'login', paramsSchema: {}, runtime: null }], owner: { kind: 'cli', label: 'me@host' } })
    const views = runtime.devSlots()
    expect(views).toHaveLength(1)
    expect(views[0]?.kvNamespace).toBe('tiktok')
    runtime.dropDevSlot('tiktok')
    expect(runtime.devSlots()).toHaveLength(0)
  })

  test('putDevSlot from a REAL workspace builds and verifies for real (no injected fake) — a plugin is runnable without publishing (criterion 15)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db: Db = opened.db
    const dataDir = `/tmp/enkaku-plugin-runtime-test-${crypto.randomUUID()}`
    const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    // NO `verify` override — this exercises the real bounded child (`verify-child.ts`), the
    // real `scripts/build.ts` bundler (plan 64), and the real `WorkspaceStore` (plan 64) all
    // wired together, exactly as `POST /api/plugins/dev` (front-end A) does.
    const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots })
    const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1000, maxTotalBytesPerScope: 10_000_000 }))

    workspace.write('/scripts/tiktok/lib/greeting.ts', { content: new TextEncoder().encode(`export const GREETING = 'v1'`), actor: 'user:u1' })
    workspace.write(
      '/scripts/tiktok/index.ts',
      {
        content: new TextEncoder().encode(`
import { z } from 'zod'
import { definePlugin } from '@enkaku/sdk'
import { GREETING } from './lib/greeting.ts'
export default definePlugin({
  id: 'tiktok',
  version: '1.0.0',
  scripts: [
    { id: 'login', params: z.object({ greeting: z.string().default(GREETING) }), run: async () => GREETING },
  ],
})
`),
        actor: 'user:u1',
      },
    )

    const first = await runtime.putDevSlot({
      name: 'tiktok',
      owner: { kind: 'workspace', label: '/scripts/tiktok/index.ts' },
      source: { kind: 'workspace', entryPath: '/scripts/tiktok/index.ts', workspace },
    })
    expect(first.ok).toBe(true)
    expect(first.slot?.buildN).toBe(1)
    const firstBundlePath = first.slot?.bundlePath

    // The registry sees it immediately — no publish (criterion 15).
    const entry = registry.resolve('tiktok/login@latest', { allowDev: true })
    expect(entry.origin).toBe('dev')

    // Edit the SHARED helper the plugin imports — the whole point of a plugin (§1 goal 1) —
    // and rebuild. No publish, no core restart; the same slot is overwritten (§3.5, criterion 15).
    const existing = workspace.read('/scripts/tiktok/lib/greeting.ts')
    workspace.write('/scripts/tiktok/lib/greeting.ts', {
      content: new TextEncoder().encode(`export const GREETING = 'v2-edited'`),
      actor: 'user:u1',
      ifMatch: existing.hash,
    })

    const second = await runtime.putDevSlot({
      name: 'tiktok',
      owner: { kind: 'workspace', label: '/scripts/tiktok/index.ts' },
      source: { kind: 'workspace', entryPath: '/scripts/tiktok/index.ts', workspace },
    })
    expect(second.ok).toBe(true)
    expect(second.slot?.buildN).toBe(2) // hot reload is slot replacement, not a new slot
    expect(second.slot?.bundlePath).not.toBe(firstBundlePath) // the bundle bytes genuinely changed

    // The bundle on disk actually contains the NEW helper's value, not the old one — proof the
    // rebuild used the edited source, not a cached copy.
    const bundleText = await Bun.file(second.slot!.bundlePath).text()
    expect(bundleText).toContain('v2-edited')
    expect(bundleText).not.toContain("'v1'")
  }, 20_000)
})

/**
 * Plan 108 §4.4, §5 step 108.10 — the `.enkaku` package's `ui/` payload was
 * validated and then discarded until this step, because nothing had a place
 * for it. These pin the three things the serving half depends on: it survives
 * `stage`, it is readable off the ACTIVE version only, and it goes when the
 * version does.
 */
const UI_ENC = new TextEncoder()

function uiAssets(over: Record<string, string> = {}) {
  const files = { 'index.html': '<!doctype html>', 'app.js': 'export {}', 'assets/logo.png': 'PNG', ...over }
  return Object.entries(files).map(([path, text]) => ({ path, data: UI_ENC.encode(text) }))
}

describe('PluginRuntime — a package’s `ui/` payload (step 108.10)', () => {
  test('assets staged with a plugin are readable once it is active', async () => {
    const { runtime } = setUp()
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}', ui: uiAssets() })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)

    const entry = await runtime.uiAsset('tiktok', 'index.html')
    expect(entry).not.toBeNull()
    expect(new TextDecoder().decode(entry?.data)).toBe('<!doctype html>')
    expect(entry?.contentType).toBe('text/html; charset=utf-8')
    expect(entry?.bytes).toBe(15)

    expect(new TextDecoder().decode((await runtime.uiAsset('tiktok', 'assets/logo.png'))?.data)).toBe('PNG')
  })

  test('the assets exist on disk BEFORE activation — staging is what materialises them', async () => {
    const { runtime, dataDir } = setUp()
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}', ui: uiAssets() })

    const index = createPluginAssetStore(dataDir).index(staged.id)
    expect(index).not.toBeNull()
    expect(Object.keys(index ?? {}).sort()).toEqual(['app.js', 'assets/logo.png', 'index.html'])

    // …but they are not SERVED until the version is active: `uiAsset` reads the
    // active row, and a staged version is not one.
    expect(await runtime.uiAsset('tiktok', 'index.html')).toBeNull()
  })

  test('a plugin that shipped no `ui/` answers null rather than throwing', async () => {
    const { runtime } = setUp()
    const staged = await runtime.stage({ name: 'plain', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)
    expect(await runtime.uiAsset('plain', 'index.html')).toBeNull()
  })

  test('a path the package never declared is null — nothing is joined onto a filesystem path', async () => {
    const { runtime } = setUp()
    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}', ui: uiAssets() })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)

    for (const path of ['../plugin.json', '../../etc/passwd', '/etc/passwd', 'assets/../../x', 'nope.html', '', 'assets']) {
      expect(await runtime.uiAsset('tiktok', path)).toBeNull()
    }
  })

  test('two versions keep separate assets, and rollback serves the older screen', async () => {
    const { runtime } = setUp()
    const v1 = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}', ui: uiAssets({ 'index.html': 'v1' }) })
    await runtime.verify(v1.id)
    runtime.activate(v1.id)
    const v2 = await runtime.stage({ name: 'tiktok', version: '2.0.0', bundle: 'export {} // 2', ui: uiAssets({ 'index.html': 'v2' }) })
    await runtime.verify(v2.id)
    runtime.activate(v2.id)

    expect(new TextDecoder().decode((await runtime.uiAsset('tiktok', 'index.html'))?.data)).toBe('v2')
    runtime.rollback('tiktok', '1.0.0')
    expect(new TextDecoder().decode((await runtime.uiAsset('tiktok', 'index.html'))?.data)).toBe('v1')
  })

  test('removing a version deletes its index, and sweeps the bytes nothing else references', async () => {
    const { runtime, dataDir } = setUp()
    const v1 = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}', ui: uiAssets({ 'index.html': 'v1' }) })
    await runtime.verify(v1.id)
    runtime.activate(v1.id)
    const v2 = await runtime.stage({ name: 'tiktok', version: '2.0.0', bundle: 'export {} // 2', ui: uiAssets({ 'index.html': 'v2' }) })
    await runtime.verify(v2.id)
    runtime.activate(v2.id)

    const store = createPluginAssetStore(dataDir)
    const blobs = () => (existsSync(join(dataDir, 'plugins', 'assets')) ? readdirSync(join(dataDir, 'plugins', 'assets')) : [])
    // `app.js` and `assets/logo.png` are byte-identical across the two
    // versions, so they are stored ONCE: 4 blobs, not 6.
    expect(blobs().length).toBe(4)

    runtime.remove('tiktok', '1.0.0', { deleteKv: false })
    expect(store.index(v1.id)).toBeNull()
    // v1's own `index.html` is gone; the two shared blobs survive because v2
    // still references them.
    expect(blobs().length).toBe(3)
    expect(store.index(v2.id)).not.toBeNull()

    runtime.remove('tiktok', '2.0.0', { deleteKv: false })
    expect(blobs().length).toBe(0)
  })

  test('removing a version with no assets at all is a no-op, not a throw', async () => {
    const { runtime } = setUp()
    const staged = await runtime.stage({ name: 'plain', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)
    expect(runtime.remove('plain', '1.0.0', { deleteKv: false }).removed).toBe(true)
  })
})

/**
 * The synthetic `recordings` owner (plan 110 §3.4, §4.3, §5 step 110.2,
 * criteria 4 and 5) — reserved against a real plugin, and immune to every
 * lifecycle verb. Enforced HERE, in the runtime, not by omitting a button:
 * `api/plugins.ts`, the dev-slot path and `restart` all come through these
 * same functions.
 */
describe('PluginRuntime — the reserved, synthetic `recordings` owner (plan 110 §3.4)', () => {
  test('a real definePlugin({ id: "recordings" }) is refused at STAGE, before any row exists', async () => {
    const { runtime, db } = setUp()
    await expect(runtime.stage({ name: 'recordings', version: '1.0.0', bundle: 'export {}' })).rejects.toThrow(/reserved plugin name/)
    expect(db.select().from(plugins).all()).toHaveLength(0)
  })

  test('and at VERIFY (criterion 5) — a row of that name that somehow exists is never verified, and never marked failed', async () => {
    const { runtime, db } = setUp()
    // The row a pre-plan-110 farm could hold, or the farm's own owner: written
    // directly, because `stage` now refuses to create one.
    db.insert(plugins)
      .values({ id: 'p-rec', name: 'recordings', version: '0.0.0', bundle: '// none', bundleHash: 'h', status: 'active', createdAt: new Date() })
      .run()
    await expect(runtime.verify('p-rec')).rejects.toThrow(/reserved plugin name/)
    // Untouched: marking it `failed` would take every published recording offline.
    expect(db.select().from(plugins).where(eq(plugins.id, 'p-rec')).get()?.status).toBe('active')
  })

  test('a dev slot cannot claim the name either — it would shadow every recording', async () => {
    const { runtime } = setUp()
    await expect(
      runtime.putDevSlot({ name: 'recordings', owner: { kind: 'cli', label: 'dev' }, source: { kind: 'bundle', bundle: 'export {}' } }),
    ).rejects.toThrow(/reserved plugin name/)
  })

  test('activate, rollback, disable, enable, remove and reload all refuse it, pointing at the recordings themselves', async () => {
    const { runtime, db } = setUp()
    db.insert(plugins)
      .values({ id: 'p-rec', name: 'recordings', version: '0.0.0', bundle: '// none', bundleHash: 'h', status: 'active', createdAt: new Date() })
      .run()
    const verbs: Array<[string, () => unknown]> = [
      ['activate', () => runtime.activate('p-rec')],
      ['rollback', () => runtime.rollback('recordings', '0.0.0')],
      ['disable', () => runtime.disable('recordings')],
      ['enable', () => runtime.enable('recordings')],
      ['remove', () => runtime.remove('recordings', '0.0.0', { deleteKv: true })],
    ]
    for (const [verb, call] of verbs) {
      let error: unknown
      try {
        call()
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(EnkakuError)
      expect((error as EnkakuError).code).toBe('E_PLUGIN_SYNTHETIC')
      expect((error as EnkakuError).message).toContain('/api/recordings')
      expect(verb).toBeTruthy()
    }
    await expect(runtime.reload('recordings')).rejects.toThrow(/not an installable plugin/)
    // Still there, still active, and its KV namespace untouched.
    expect(db.select().from(plugins).where(eq(plugins.id, 'p-rec')).get()?.status).toBe('active')
  })

  test('restart never re-verifies a row that was never verified — the synthetic owner has no bundle to run', async () => {
    let verifyCalls = 0
    const { runtime, db } = setUp({
      verify: async () => {
        verifyCalls++
        return healthyReport()
      },
    })
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    db.insert(plugins)
      .values({ id: 'p-rec', name: 'recordings', version: '0.0.0', bundle: '// none', bundleHash: 'h', status: 'active', createdAt: new Date() })
      .run()
    verifyCalls = 0
    const result = await runtime.restart()
    // The real plugin, and only the real plugin.
    expect(verifyCalls).toBe(1)
    expect(result).toEqual({ ok: 1, failed: 0 })
    expect(db.select().from(plugins).where(eq(plugins.id, 'p-rec')).get()?.verifyError).toBeNull()
  })
})

/**
 * Plan 82 §3.4, §4.6 — bulk version removal, and the guard the single-version
 * path was missing.
 *
 * The farm owner's ask (2026-08-17): *"remove di plugins itu bisa remove
 * specific versi, atau remove all version, atau remove all except latest
 * version"*. Version history accumulates per publish and nothing collects it —
 * the farm this was written for carries 20+ `tiktok` rows — so "all except the
 * latest" is the routine one, and it must not touch what is live.
 */
describe('PluginRuntime — removeVersions (bulk) and the script_in_use guard', () => {
  /**
   * Publishes N versions of one name and activates each in turn, which is how a
   * real history is built: every earlier row ends up `superseded` (the status
   * `rollback` requires), and the last one published is the live one.
   */
  async function withVersions(runtime: PluginRuntime, versions: string[]) {
    const rows = []
    for (const v of versions) {
      const staged = await stageAndVerify(runtime, { version: v, bundle: `export {} // ${v}` })
      runtime.activate(staged.id)
      rows.push(staged)
    }
    return rows
  }

  test('scope "all" removes every version, including the active one', async () => {
    const { runtime, db } = setUp()
    await withVersions(runtime, ['1.0.0', '1.1.0', '1.2.0'])

    const report = runtime.removeVersions('tiktok', { scope: 'all', deleteKv: false })
    expect(report.total).toBe(3)
    expect(report.results).toHaveLength(3)
    expect(report.results.every((r) => r.skip === null && r.error === null)).toBe(true)
    expect(db.select().from(plugins).all()).toHaveLength(0)
    // The member `scripts` rows go with them — the same cleanup a single remove does.
    expect(db.select().from(scripts).all()).toHaveLength(0)
  })

  test('scope "except-latest" keeps the newest and deletes the rest', async () => {
    const { runtime, db } = setUp()
    await withVersions(runtime, ['1.0.0', '1.1.0', '1.2.0'])

    const report = runtime.removeVersions('tiktok', { scope: 'except-latest', deleteKv: false })
    const removed = report.results.filter((r) => r.skip === null && r.error === null).map((r) => r.version)
    const kept = report.results.filter((r) => r.skip !== null).map((r) => r.version)
    expect(removed).toEqual(['1.0.0', '1.1.0'])
    expect(kept).toEqual(['1.2.0'])
    expect(db.select().from(plugins).all().map((r) => r.version)).toEqual(['1.2.0'])
  })

  /**
   * The one that matters. After a rollback the ACTIVE version is older than the
   * newest one; a prune that kept only "the latest" would delete the row this
   * farm is running, with a 200 and a cheerful count.
   */
  test('after a rollback it keeps BOTH the active version and the newest one', async () => {
    const { runtime, db } = setUp()
    await withVersions(runtime, ['1.0.0', '1.1.0', '1.2.0'])
    runtime.rollback('tiktok', '1.1.0')
    expect(runtime.active('tiktok')!.version).toBe('1.1.0')

    const report = runtime.removeVersions('tiktok', { scope: 'except-latest', deleteKv: false })
    expect(report.results.filter((r) => r.skip === null && r.error === null).map((r) => r.version)).toEqual(['1.0.0'])
    expect(db.select().from(plugins).all().map((r) => r.version).sort()).toEqual(['1.1.0', '1.2.0'])
    // Still live, still resolving — the whole point of the exercise.
    expect(runtime.active('tiktok')!.version).toBe('1.1.0')
  })

  test('a queued job holding a version refuses THAT version and no other (script_in_use)', async () => {
    const { runtime, db } = setUp()
    const rows = await withVersions(runtime, ['1.0.0', '1.1.0', '1.2.0'])
    const held = rows.find((r) => r.version === '1.1.0')!
    db.insert(jobs)
      .values({ id: 'j-1', scriptId: `${held.id}:login`, deviceId: 'dev-1', status: 'queued', createdAt: new Date() })
      .run()

    const report = runtime.removeVersions('tiktok', { scope: 'except-latest', deleteKv: false })
    const byVersion = Object.fromEntries(report.results.map((r) => [r.version, r]))
    expect(byVersion['1.0.0']!.error).toBeNull()
    expect(byVersion['1.1.0']!.error?.code).toBe('script_in_use')
    expect(byVersion['1.1.0']!.error?.message).toContain('1.1.0')
    // Partial success: the refusal did not stop the other removal, and the held
    // row survives with its scripts intact so the job can still run.
    expect(db.select().from(plugins).all().map((r) => r.version).sort()).toEqual(['1.1.0', '1.2.0'])
    expect(db.select().from(scripts).where(eq(scripts.pluginId, held.id)).all()).toHaveLength(2)
  })

  test('the same guard applies to the SINGLE-version path — one door, not two', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    db.insert(jobs)
      .values({ id: 'j-1', scriptId: `${staged.id}:login`, deviceId: 'dev-1', status: 'running', createdAt: new Date() })
      .run()

    expect(() => runtime.remove('tiktok', '1.0.0', { deleteKv: false })).toThrow(EnkakuError)
    expect(db.select().from(plugins).all()).toHaveLength(1)
  })

  test('a finished job never blocks a removal — only queued and running do', async () => {
    const { runtime, db } = setUp()
    const staged = await stageAndVerify(runtime)
    runtime.activate(staged.id)
    db.insert(jobs)
      .values({ id: 'j-1', scriptId: `${staged.id}:login`, deviceId: 'dev-1', status: 'success', createdAt: new Date() })
      .run()

    expect(runtime.remove('tiktok', '1.0.0', { deleteKv: false }).removed).toBe(true)
    // Job history survives the deletion — plan 82 §3.4's denormalised columns.
    expect(db.select().from(jobs).all()).toHaveLength(1)
  })

  test('deleteKv drops the shared namespace exactly once, however many versions go', async () => {
    const { runtime, kv, db } = setUp()
    await withVersions(runtime, ['1.0.0', '1.1.0', '1.2.0'])
    kv.set({ kind: 'global' }, 'tiktok', 'a', 1)
    kv.set({ kind: 'global' }, 'tiktok', 'b', 2)

    const report = runtime.removeVersions('tiktok', { scope: 'all', deleteKv: true })
    const totals = report.results.map((r) => r.kvDeleted)
    expect(totals.reduce((n, x) => n + x, 0)).toBe(2)
    // One result carries the whole count; the rest carry zero. Summing eleven
    // namespace sweeps would report a total many times too large.
    expect(totals.filter((n) => n > 0)).toHaveLength(1)
    expect(db.select().from(plugins).all()).toHaveLength(0)
  })

  test('an unknown plugin name is a request-level refusal, not an empty report', async () => {
    const { runtime } = setUp()
    expect(() => runtime.removeVersions('nope', { scope: 'all', deleteKv: false })).toThrow(EnkakuError)
  })

  /**
   * a one-off plan 110 migration script (since deleted) recorded the mistake
   * its own first version made: deriving a delete list from a FILTERED listing that
   * hides the rows it means to act on, then reporting "nothing to delete" on a
   * farm holding five. A bulk remove that only saw healthy rows would leave
   * behind exactly the junk an operator ran it to clear.
   */
  test('it sees failed and staged rows, not only the healthy ones', async () => {
    const { runtime, db } = setUp()
    await withVersions(runtime, ['1.0.0', '1.1.0'])
    db.insert(plugins)
      .values({ id: crypto.randomUUID(), name: 'tiktok', version: '0.9.0', bundle: 'x', bundleHash: 'h', status: 'failed', createdAt: new Date() })
      .run()

    const report = runtime.removeVersions('tiktok', { scope: 'except-latest', deleteKv: false })
    expect(report.total).toBe(3)
    expect(report.results.filter((r) => r.skip === null && r.error === null).map((r) => r.version).sort()).toEqual(['0.9.0', '1.0.0'])
  })
})
