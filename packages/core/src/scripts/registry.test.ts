import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { plugins, scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { createDevSlotStore, type DevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from './registry'

function setUp(): { db: Db; dataDir: string } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, dataDir: join(tmpdir(), `enkaku-registry-test-${crypto.randomUUID()}`) }
}

/**
 * A published plugin member. `pluginId`/`exportId` default to something
 * derived from the name rather than to null, because null is no longer a
 * shape a published script can have (plan 110 §3.2) — `publishUnowned` below
 * is the only way to write one, and it exists solely to prove the registry
 * ignores it.
 */
function publish(
  db: Db,
  name: string,
  version: string,
  opts: { enabled?: boolean; pluginId?: string; exportId?: string; runtime?: unknown } = {},
): string {
  const id = `${name.replace('/', '-')}-${version}-${crypto.randomUUID().slice(0, 8)}`
  const [derivedPlugin, derivedExport] = name.split('/')
  db.insert(scripts)
    .values({
      id,
      name,
      version,
      bundle: 'export {}',
      enabled: opts.enabled ?? true,
      createdAt: new Date(1_700_000_000 * 1000),
      pluginId: opts.pluginId ?? `plugin-${derivedPlugin}`,
      exportId: opts.exportId ?? derivedExport ?? 'main',
      // Plan 98 §3.1, §4.4, §5 step 98.4 — `unknown` here (never typed as
      // `RuntimeEnvelope`) on purpose: some tests below deliberately write a
      // shape `RuntimeEnvelopeSchema` will not accept, to pin the
      // parse-failure-degrades-to-null behaviour `rowToEntry` promises.
      runtime: opts.runtime ?? null,
    })
    .run()
  return id
}

/** A plugin-scoped `@latest` resolves against the ACTIVE `plugins` row (`registry.ts`'s `activePluginVersion`), not merely the highest enabled semver among its `scripts` rows — so a test exercising it needs a matching `plugins` row, exactly like `plugins/runtime.ts`'s `activate()` would write. */
function markActive(db: Db, name: string, version: string): void {
  db.insert(plugins)
    .values({
      id: `${name}-${version}`,
      name,
      version,
      title: null,
      description: null,
      bundle: 'export {}',
      source: null,
      bundleHash: 'deadbeef',
      status: 'active',
      verifiedAt: new Date(),
      verifyError: null,
      verifyErrorCode: null,
      manifest: { scripts: [] },
      resetPackages: null,
      createdBy: null,
      createdAt: new Date(),
    })
    .run()
}

function putDev(devSlots: DevSlotStore, pluginName: string, declaredVersion: string, exportIds: string[]) {
  return devSlots.put({
    pluginName,
    declaredVersion,
    bundlePath: `/tmp/${pluginName}.mjs`,
    scripts: exportIds.map((exportId) => ({ exportId, paramsSchema: {}, runtime: null })),
    owner: { kind: 'workspace', label: `/scripts/${pluginName}` },
  })
}

describe('ScriptRegistry — resolve (unmodified behaviour)', () => {
  test('resolves a concrete version, matching resolveScriptRef exactly', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const id = publish(db, 'demo/checkout', '1.0.1')
    const entry = registry.resolve('demo/checkout@1.0.1')
    expect(entry.id).toBe(id)
    expect(entry.origin).toBe('plugin')
    expect(entry.pluginName).toBe('demo')
  })

  test('the four resolveScriptRef error codes still surface unchanged', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    try {
      registry.resolve('nope@1.0.0')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_not_found')
    }
  })
})

describe('ScriptRegistry — resolve (plugin scripts, ordinary rows)', () => {
  test('a plugin member resolves through the SAME resolveScriptRef path, unmodified (criterion 3 precondition)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const id = publish(db, 'tiktok/login', '1.0.0', { pluginId: 'plugin-1', exportId: 'login' })
    const entry = registry.resolve('tiktok/login@1.0.0')
    expect(entry.id).toBe(id)
    expect(entry.origin).toBe('plugin')
    expect(entry.pluginName).toBe('tiktok')
    expect(entry.exportId).toBe('login')
  })

  test('@latest resolves a plugin member to its ACTIVE plugin version, not merely the highest enabled semver', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const idV1 = publish(db, 'tiktok/login', '1.0.0', { pluginId: 'p1', exportId: 'login' })
    publish(db, 'tiktok/login', '2.0.0', { pluginId: 'p2', exportId: 'login' }) // e.g. staged, never activated
    markActive(db, 'tiktok', '1.0.0')
    const entry = registry.resolve('tiktok/login@latest')
    expect(entry.id).toBe(idV1)
  })

  test('a plugin-scoped @latest with no active plugin row is unresolved', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    publish(db, 'tiktok/login', '1.0.0', { pluginId: 'p1', exportId: 'login' })
    try {
      registry.resolve('tiktok/login@latest')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_ref_unresolved')
    }
  })

  test('an exact pinned plugin ref resolves regardless of active/superseded — only @latest cares', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const idV1 = publish(db, 'tiktok/login', '1.0.0', { pluginId: 'p1', exportId: 'login' })
    publish(db, 'tiktok/login', '2.0.0', { pluginId: 'p2', exportId: 'login' })
    markActive(db, 'tiktok', '2.0.0')
    // 1.0.0 is not active, but a pinned reference still resolves it (plan 62/82's pinning guarantee).
    expect(registry.resolve('tiktok/login@1.0.0').id).toBe(idV1)
  })
})

describe('ScriptRegistry — dev overlay (criteria 11, 12, 16, 17, 18)', () => {
  test('resolve() refuses a dev entry by default (criterion 12)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    putDev(devSlots, 'tiktok', '1.0.0', ['login'])
    try {
      registry.resolve('tiktok/login@latest')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_is_dev')
    }
  })

  test('resolve() returns the dev entry when allowDev is true (criterion 12)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    putDev(devSlots, 'tiktok', '1.0.0', ['login'])
    const entry = registry.resolve('tiktok/login@latest', { allowDev: true })
    expect(entry.origin).toBe('dev')
    expect(entry.version).toBe('1.0.0+dev.1')
    expect(entry.devOwner).toBe('/scripts/tiktok')
  })

  test('a dev entry wins over an active published one when allowDev is true (criterion 16 precondition)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    publish(db, 'tiktok/login', '1.0.0', { pluginId: 'p1', exportId: 'login' })
    putDev(devSlots, 'tiktok', '1.0.0', ['login'])
    const entry = registry.resolve('tiktok/login@1.0.0', { allowDev: true })
    expect(entry.origin).toBe('dev')
  })

  test('without allowDev, a pinned ref with a published match ignores the dev slot entirely', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const id = publish(db, 'tiktok/login', '1.0.0', { pluginId: 'p1', exportId: 'login' })
    putDev(devSlots, 'tiktok', '1.0.0', ['login'])
    const entry = registry.resolve('tiktok/login@1.0.0')
    expect(entry.id).toBe(id)
    expect(entry.origin).toBe('plugin')
  })

  test('dropping a dev slot makes it vanish from list and resolve (criterion 17)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    putDev(devSlots, 'onlydev', '0.1.0', ['run'])
    expect(registry.list({ origin: 'dev' }).items).toHaveLength(1)
    devSlots.drop('onlydev')
    expect(registry.list({ origin: 'dev' }).items).toHaveLength(0)
    expect(() => registry.resolve('onlydev/run@latest', { allowDev: true })).toThrow(EnkakuError)
  })

  test('a schedule-style ref pointing at a dev-only (never published) script is refused with script_is_dev (criterion 18)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    putDev(devSlots, 'onlydev', '0.1.0', ['run'])
    try {
      registry.resolve('onlydev/run@latest') // no allowDev — the schedule/batch path
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_is_dev')
    }
  })
})

describe('ScriptRegistry — get/list/bundlePath', () => {
  test('get() resolves a persisted id and a dev id', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const id = publish(db, 'demo/checkout', '1.0.0')
    expect(registry.get(id)?.name).toBe('demo/checkout')
    putDev(devSlots, 'onlydev', '0.1.0', ['run'])
    const devEntry = registry.list({ origin: 'dev' }).items[0]
    expect(devEntry?.id.startsWith('dev:')).toBe(true)
    expect(registry.get(devEntry!.id)?.name).toBe('onlydev/run')
    expect(registry.get('dev:missing/nope')).toBeNull()
    expect(registry.get('no-such-id')).toBeNull()
  })

  test('bundlePath() materialises a db-origin entry and passes through a file-origin (dev) one', async () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    publish(db, 'demo/checkout', '1.0.0')
    const entry = registry.resolve('demo/checkout@1.0.0')
    const path = await registry.bundlePath(entry)
    expect(path).toContain(dataDir)
    expect(await Bun.file(path).exists()).toBe(true)

    putDev(devSlots, 'onlydev', '0.1.0', ['run'])
    const devEntry = registry.list({ origin: 'dev' }).items[0]!
    const devPath = await registry.bundlePath(devEntry)
    expect(devPath).toBe('/tmp/onlydev.mjs')
  })

  test('list() paginates and filters by pluginName/origin', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    publish(db, 'demo/a', '1.0.0')
    publish(db, 'demo/b', '1.0.0')
    publish(db, 'tiktok/login', '1.0.0', { pluginId: 'p1', exportId: 'login' })
    const page1 = registry.list({ limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.total).toBe(3)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = registry.list({ limit: 2, cursor: page1.nextCursor })
    expect(page2.items).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()

    const pluginOnly = registry.list({ pluginName: 'tiktok' })
    expect(pluginOnly.items).toHaveLength(1)
    expect(pluginOnly.items[0]?.name).toBe('tiktok/login')
  })
})

describe('ScriptRegistry — runtime (plan 98 §3.1, §4.4, §5 step 98.4)', () => {
  test('get() carries a row\'s declared runtime through, readable by scriptId alone — the shape plan 99\'s workflow budget checker needs', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const declared = { timeoutMs: 90_000, retries: 1 }
    const id = publish(db, 'demo/checkout', '1.0.0', { runtime: declared })
    expect(registry.get(id)?.runtime).toEqual(declared)
    // Exactly plan 98 §5 step 98.4's own downstream claim: a caller holding
    // only a scriptId can read the declared timeout with no `ready` message,
    // no child process, no job ever having run.
    expect(registry.get(id)?.runtime?.timeoutMs).toBe(90_000)
  })

  test('a row published before this column existed (no `runtime` set at all) reads back null — identical to today\'s behaviour', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const id = publish(db, 'demo/checkout', '1.0.0')
    expect(registry.get(id)?.runtime).toBeNull()
  })

  test('a corrupt/unparseable runtime column degrades to null rather than throwing (matching the `workflow` field\'s own precedent)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    // Below RuntimeEnvelopeSchema's 1s floor — not a shape a validated writer
    // could have produced, standing in for a row from before a future tightening.
    const id = publish(db, 'demo/checkout', '1.0.0', { runtime: { timeoutMs: 1 } })
    expect(() => registry.get(id)).not.toThrow()
    expect(registry.get(id)?.runtime).toBeNull()
  })

  test('resolve() also carries runtime through (the pinned-at-enqueue path, spec §11.6)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const declared = { maxConcurrent: 3 }
    publish(db, 'demo/checkout', '1.0.0', { runtime: declared })
    expect(registry.resolve('demo/checkout@1.0.0').runtime).toEqual(declared)
  })
})

/**
 * A `kind: 'script'` row with no owning plugin — what a farm that upgraded
 * past plan 110 §3.2 still has on disk. Written directly here, the way a
 * pre-upgrade farm has them, because no writer in the workspace can produce
 * one any more.
 */
function publishUnowned(db: Db, name: string, version: string): string {
  const id = `${name}-${version}`
  db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date(1_700_000_000 * 1000) }).run()
  return id
}

function collectWarns(): { log: Logger; warns: string[] } {
  const warns: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (m) => warns.push(m),
    error: () => {},
    child: () => log,
  }
  return { log, warns }
}

describe('ScriptRegistry — a row with no owning plugin is ignored', () => {
  test('it does not resolve, by exact ref or by @latest', () => {
    const { db, dataDir } = setUp()
    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore(), log: collectWarns().log })
    publishUnowned(db, 'chrome-open-url', '1.0.0')
    publishUnowned(db, 'chrome-open-url', '1.4.0')

    for (const ref of ['chrome-open-url@1.0.0', 'chrome-open-url@latest'] as const) {
      try {
        registry.resolve(ref)
        throw new Error(`should have thrown for ${ref}`)
      } catch (err) {
        expect(err).toBeInstanceOf(EnkakuError)
        expect((err as EnkakuError).code).toBe('script_not_found')
        expect((err as EnkakuError).message).toContain('no owning plugin')
      }
    }
  })

  test('it does not list, does not group, and get() by its own id is null — while owned rows are untouched', () => {
    const { db, dataDir } = setUp()
    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore(), log: collectWarns().log })
    const orphanId = publishUnowned(db, 'debug-node', '1.0.0')
    publish(db, 'demo/checkout', '1.0.0')

    expect(registry.list().items.map((e) => e.name)).toEqual(['demo/checkout'])
    expect(registry.list().total).toBe(1)
    expect(registry.get(orphanId)).toBeNull()
    // And the owned row behaves exactly as it did before.
    expect(registry.resolve('demo/checkout@1.0.0').origin).toBe('plugin')
  })

  test('N such rows produce exactly ONE warn, naming the count and the names — never one line per row', () => {
    const { db, dataDir } = setUp()
    publishUnowned(db, 'chrome-open-url', '1.0.0')
    publishUnowned(db, 'chrome-open-url', '1.4.0')
    publishUnowned(db, 'debug-node', '1.0.0')
    publishUnowned(db, 'hello-no-device', '1.0.0')
    publishUnowned(db, 'network-test', '1.0.0')
    const { log, warns } = collectWarns()

    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore(), log })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('5 script row(s) across 4 name(s)')
    expect(warns[0]).toContain('chrome-open-url@1.0.0')
    expect(warns[0]).toContain('debug-node@1.0.0')
    expect(warns[0]).toContain('hello-no-device@1.0.0')
    expect(warns[0]).toContain('network-test@1.0.0')
    expect(warns[0]).toContain('DELETE /api/scripts/<id>')

    // Not once per request either: every read below goes through the same
    // rows and adds nothing to the log.
    registry.list()
    expect(() => registry.resolve('debug-node@latest')).toThrow(EnkakuError)
    expect(warns).toHaveLength(1)
  })

  test('a farm with none of them says nothing at all', () => {
    const { db, dataDir } = setUp()
    publish(db, 'demo/checkout', '1.0.0')
    const { log, warns } = collectWarns()
    createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore(), log })
    expect(warns).toHaveLength(0)
  })
})
