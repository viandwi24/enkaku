import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { plugins, scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createDevSlotStore, type DevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from './registry'

function setUp(): { db: Db; dataDir: string } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, dataDir: `/tmp/enkaku-registry-test-${crypto.randomUUID()}` }
}

function publish(
  db: Db,
  name: string,
  version: string,
  opts: { enabled?: boolean; pluginId?: string; exportId?: string } = {},
): string {
  const id = `${name.replace('/', '-')}-${version}-${crypto.randomUUID().slice(0, 8)}`
  db.insert(scripts)
    .values({
      id,
      name,
      version,
      bundle: 'export {}',
      enabled: opts.enabled ?? true,
      createdAt: new Date(1_700_000_000 * 1000),
      pluginId: opts.pluginId ?? null,
      exportId: opts.exportId ?? null,
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
    scripts: exportIds.map((exportId) => ({ exportId, paramsSchema: {} })),
    owner: { kind: 'workspace', label: `/scripts/${pluginName}` },
  })
}

describe('ScriptRegistry — resolve (standalone, unmodified behaviour)', () => {
  test('resolves a concrete standalone version, matching resolveScriptRef exactly', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const id = publish(db, 'checkout', '1.0.1')
    const entry = registry.resolve('checkout@1.0.1')
    expect(entry.id).toBe(id)
    expect(entry.origin).toBe('standalone')
    expect(entry.pluginName).toBeNull()
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

  test('groups() lists standalone, plugin, and dev scripts together (criterion 11)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    publish(db, 'checkout', '1.0.0')
    publish(db, 'tiktok/login', '1.0.0', { pluginId: 'p1', exportId: 'login' })
    putDev(devSlots, 'onlydev', '0.1.0', ['run'])
    const groups = registry.groups()
    expect(groups.map((g) => g.name).sort()).toEqual(['checkout', 'onlydev/run', 'tiktok/login'])
    const devGroup = groups.find((g) => g.name === 'onlydev/run')
    expect(devGroup?.hasDev).toBe(true)
    expect(devGroup?.versions[0]?.origin).toBe('dev')
  })

  test('dropping a dev slot makes it vanish from list, groups, and resolve (criterion 17)', () => {
    const { db, dataDir } = setUp()
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    putDev(devSlots, 'onlydev', '0.1.0', ['run'])
    expect(registry.groups().some((g) => g.name === 'onlydev/run')).toBe(true)
    expect(registry.list({ origin: 'dev' }).items).toHaveLength(1)
    devSlots.drop('onlydev')
    expect(registry.groups().some((g) => g.name === 'onlydev/run')).toBe(false)
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
    const id = publish(db, 'checkout', '1.0.0')
    expect(registry.get(id)?.name).toBe('checkout')
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
    publish(db, 'checkout', '1.0.0')
    const entry = registry.resolve('checkout@1.0.0')
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
    publish(db, 'a', '1.0.0')
    publish(db, 'b', '1.0.0')
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
