import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createPluginRuntime, type PluginRuntime } from '../plugins/runtime'
import type { VerifyReport } from '../plugins/verify-child'
import { listNodeTypes } from './registry'

/**
 * Plan 303 §4.3, §5 step 303.6 — the flow editor's palette, built against a
 * REAL `Db` and a real `PluginRuntime` (same reasoning `surface-registry.test.ts`
 * gives: this is a claim about row STATUS and about what survives a
 * stage/verify/activate round trip through the `plugins.manifest` JSON
 * column, neither of which a stubbed runtime can prove).
 */

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-node-registry-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

interface Harness {
  runtime: PluginRuntime
  /** The `VerifyReport.scripts` the next `verify` will report; mutable so one harness can stage several plugins/versions. */
  setScripts(scripts: VerifyReport['scripts']): void
}

function setUp(): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  let scripts: VerifyReport['scripts'] = []
  const verify = async (_bundlePath: string, opts?: { expectedVersion?: string }): Promise<VerifyReport> => ({
    ok: true,
    version: opts?.expectedVersion ?? '1.0.0',
    scripts,
    resetPackages: [],
  })
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify })
  return {
    runtime,
    setScripts(next) {
      scripts = next
    },
  }
}

async function publish(runtime: PluginRuntime, name: string, version = '1.0.0'): Promise<string> {
  const staged = await runtime.stage({ name, version, bundle: 'export {}' })
  await runtime.verify(staged.id)
  return staged.id
}

async function activate(runtime: PluginRuntime, name: string, version = '1.0.0'): Promise<void> {
  runtime.activate(await publish(runtime, name, version))
}

const NODE_SCRIPT = {
  id: 'scroll',
  title: 'Scroll FYP',
  description: 'Scroll the feed a bounded number of times.',
  paramsSchema: { type: 'object', properties: { count: { type: 'number' } } },
  resultSchema: { type: 'object', properties: { videos: { type: 'number' } } },
  runtime: null,
  node: { category: 'device' as const, icon: 'wrench' as const, summary: ['count'], keywords: ['scroll', 'feed'] },
}

const PLAIN_SCRIPT = { id: 'noop', paramsSchema: { type: 'object' }, runtime: null }

describe('listNodeTypes — registry lists both (plan 303 G4)', () => {
  test('the six core kinds are always present, one `core:<kind>` id each', () => {
    const h = setUp()
    const types = listNodeTypes({ plugins: h.runtime })
    const coreIds = types.filter((t) => t.source === 'core').map((t) => t.id)
    expect(coreIds.sort()).toEqual(['core:delay', 'core:finish', 'core:gate', 'core:script', 'core:start', 'core:switch'])
  })

  test('an activated plugin member declaring `node` appears, with title/description/schemas/descriptor', async () => {
    const h = setUp()
    h.setScripts([NODE_SCRIPT, PLAIN_SCRIPT])
    await activate(h.runtime, 'tiktok')

    const types = listNodeTypes({ plugins: h.runtime })
    const entry = types.find((t) => t.id === 'tiktok/scroll')
    expect(entry).toBeDefined()
    expect(entry?.source).toBe('plugin')
    expect(entry?.kind).toBe('script')
    expect(entry?.title).toBe('Scroll FYP')
    expect(entry?.description).toBe('Scroll the feed a bounded number of times.')
    expect(entry?.category).toBe('device')
    expect(entry?.icon).toBe('wrench')
    expect(entry?.summary).toEqual(['count'])
    expect(entry?.keywords).toEqual(['scroll', 'feed'])
    expect(entry?.paramsSchema).toEqual(NODE_SCRIPT.paramsSchema)
    expect(entry?.resultSchema).toEqual(NODE_SCRIPT.resultSchema)
  })

  test('a member declaring NO `node` never appears in the palette', async () => {
    const h = setUp()
    h.setScripts([NODE_SCRIPT, PLAIN_SCRIPT])
    await activate(h.runtime, 'tiktok')

    const types = listNodeTypes({ plugins: h.runtime })
    expect(types.some((t) => t.id === 'tiktok/noop')).toBe(false)
  })

  test('a merely STAGED (verified, not activated) plugin contributes nothing', async () => {
    const h = setUp()
    h.setScripts([NODE_SCRIPT])
    await publish(h.runtime, 'tiktok')

    const types = listNodeTypes({ plugins: h.runtime })
    expect(types.some((t) => t.source === 'plugin')).toBe(false)
  })

  test('a DISABLED plugin contributes nothing', async () => {
    const h = setUp()
    h.setScripts([NODE_SCRIPT])
    await activate(h.runtime, 'tiktok')
    expect(listNodeTypes({ plugins: h.runtime }).some((t) => t.id === 'tiktok/scroll')).toBe(true)

    h.runtime.disable('tiktok')
    expect(listNodeTypes({ plugins: h.runtime }).some((t) => t.id === 'tiktok/scroll')).toBe(false)
  })
})

describe('listNodeTypes — pins version (plan 303 G6)', () => {
  test('a plugin node resolves to the ACTIVE version, pinned, never @latest', async () => {
    const h = setUp()
    h.setScripts([NODE_SCRIPT])
    await activate(h.runtime, 'tiktok', '1.4.0')

    const entry = listNodeTypes({ plugins: h.runtime }).find((t) => t.id === 'tiktok/scroll')
    expect(entry?.script).toBe('tiktok/scroll@1.4.0')
  })

  test('activating a newer version updates the pin the palette offers next', async () => {
    const h = setUp()
    h.setScripts([NODE_SCRIPT])
    await activate(h.runtime, 'tiktok', '1.0.0')
    await activate(h.runtime, 'tiktok', '2.0.0')

    const entry = listNodeTypes({ plugins: h.runtime }).find((t) => t.id === 'tiktok/scroll')
    expect(entry?.script).toBe('tiktok/scroll@2.0.0')
    // Only one entry per member — the superseded version does not also appear.
    expect(listNodeTypes({ plugins: h.runtime }).filter((t) => t.id === 'tiktok/scroll')).toHaveLength(1)
  })
})

describe('listNodeTypes — an uninstalled/unresolvable plugin node does not crash the registry (plan 303 §6)', () => {
  test('a farm with no plugins at all still returns the six core types', () => {
    const h = setUp()
    expect(() => listNodeTypes({ plugins: h.runtime })).not.toThrow()
    expect(listNodeTypes({ plugins: h.runtime })).toHaveLength(6)
  })
})
