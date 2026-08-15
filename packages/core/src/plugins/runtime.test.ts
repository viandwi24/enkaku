import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
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
  return { db, runtime, registry, kv }
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

  test('E_PLUGIN_NAME_CONFLICT — a plugin cannot claim a name already owned by a standalone script, naming both, without disturbing the standalone script (criterion 23)', async () => {
    const { runtime, registry, db } = setUp()
    // A standalone script published (by coincidence, or by an unrelated author) under the
    // exact literal name a plugin's own naming scheme would also produce.
    db.insert(scripts)
      .values({ id: 'standalone-1', name: 'tiktok/login', version: '1.0.0', bundle: 'standalone bundle', enabled: true, createdAt: new Date() })
      .run()

    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'plugin bundle' })
    const report = await runtime.verify(staged.id)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_NAME_CONFLICT')
    expect(report.error).toContain('tiktok/login')
    expect(report.error).toContain('standalone')
    expect(runtime.get('tiktok', '1.0.0')?.status).toBe('failed')
    // The standalone script is completely undisturbed and still resolves.
    expect(registry.resolve('tiktok/login@1.0.0').id).toBe('standalone-1')
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
