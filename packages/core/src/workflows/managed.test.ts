import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { WorkflowDoc } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { workflows } from '../db/schema'
import { createKvStore } from '../kv/store'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createPluginRuntime } from '../plugins/runtime'
import type { VerifyReport } from '../plugins/verify-child'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkflowStore } from './store'
import { syncAllPluginWorkflows, syncPluginWorkflows } from './managed'

/**
 * Plan 315 — the one rule: the rows a plugin owns are exactly what its ACTIVE
 * version declares. Driven through the real runtime verbs (stage, verify,
 * activate, rollback, disable, enable, remove) with only the verify child
 * faked, because the rule is about what those verbs leave behind together, not
 * about the sync function in isolation.
 */

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-managed-workflows-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** A minimal valid v2 document, already prefixed the way `finalizeReport` leaves it. */
function doc(name: string, title = 'Warm-up'): WorkflowDoc {
  return {
    schema: 2,
    name,
    title,
    description: '',
    params: [],
    entry: 'start',
    maxSteps: 50,
    nodes: [
      { id: 'start', kind: 'start', title: 'Start', enabled: true, ui: { x: 0, y: 0 }, next: 'done' },
      { id: 'done', kind: 'finish', title: 'Done', enabled: true, ui: { x: 0, y: 100 }, status: 'succeed', message: '' },
    ],
  } as WorkflowDoc
}

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  /** What the fake verify child reports, per version — the only thing a test varies. */
  const declared = new Map<string, WorkflowDoc[]>()
  const verify = async (_bundlePath: string, opts?: { expectedVersion?: string }): Promise<VerifyReport> => {
    const version = opts?.expectedVersion ?? '1.0.0'
    const wf = declared.get(version) ?? []
    return {
      ok: true,
      version,
      scripts: [{ id: 'scroll', paramsSchema: { type: 'object', properties: {} }, runtime: null }],
      ...(wf.length > 0 ? { workflows: wf } : {}),
      resetPackages: [],
    }
  }
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify })
  const store = createWorkflowStore(db)

  async function install(version: string, wf: WorkflowDoc[]): Promise<string> {
    declared.set(version, wf)
    const staged = await runtime.stage({ name: 'smm', version, bundle: 'export {}' })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)
    return staged.id
  }

  const owned = (): { name: string; title: string }[] =>
    store
      .list()
      .filter((w) => w.pluginName === 'smm')
      .map((w) => ({ name: w.name, title: w.doc.title }))

  return { db, runtime, store, install, owned }
}

describe('a plugin version’s workflows follow it through every lifecycle verb', () => {
  test('activating registers each declared workflow, prefixed and owned by the plugin', async () => {
    const h = setUp()
    await h.install('1.0.0', [doc('smm/warmup-rotation'), doc('smm/upload-day')])
    expect(h.owned().map((w) => w.name)).toEqual(['smm/upload-day', 'smm/warmup-rotation'])
    expect(h.store.get('smm/warmup-rotation')?.pluginName).toBe('smm')
  })

  test('a new version rewrites what changed and removes what it no longer declares', async () => {
    const h = setUp()
    await h.install('1.0.0', [doc('smm/warmup-rotation'), doc('smm/upload-day')])
    await h.install('1.1.0', [doc('smm/warmup-rotation', 'Warm-up v2')])
    expect(h.owned()).toEqual([{ name: 'smm/warmup-rotation', title: 'Warm-up v2' }])
  })

  test('rollback brings back the older version’s set — workflow rows are not kept per version the way script rows are', async () => {
    const h = setUp()
    await h.install('1.0.0', [doc('smm/warmup-rotation'), doc('smm/upload-day')])
    await h.install('1.1.0', [doc('smm/warmup-rotation', 'Warm-up v2')])
    h.runtime.rollback('smm', '1.0.0')
    expect(h.owned()).toEqual([
      { name: 'smm/upload-day', title: 'Warm-up' },
      { name: 'smm/warmup-rotation', title: 'Warm-up' },
    ])
  })

  test('disable removes them (their scripts no longer resolve); enable brings them back', async () => {
    const h = setUp()
    await h.install('1.0.0', [doc('smm/warmup-rotation')])
    h.runtime.disable('smm')
    expect(h.owned()).toEqual([])
    h.runtime.enable('smm')
    expect(h.owned().map((w) => w.name)).toEqual(['smm/warmup-rotation'])
  })

  test('removing the active version removes its workflows', async () => {
    const h = setUp()
    await h.install('1.0.0', [doc('smm/warmup-rotation')])
    await h.runtime.remove('smm', '1.0.0', { deleteKv: false })
    expect(h.owned()).toEqual([])
  })

  test('removing a SUPERSEDED version leaves the active version’s workflows alone', async () => {
    const h = setUp()
    await h.install('1.0.0', [doc('smm/old-one')])
    await h.install('1.1.0', [doc('smm/warmup-rotation')])
    await h.runtime.remove('smm', '1.0.0', { deleteKv: false })
    expect(h.owned().map((w) => w.name)).toEqual(['smm/warmup-rotation'])
  })
})

describe('what the sync never does', () => {
  test('it never replaces an operator’s workflow that happens to hold the declared name', async () => {
    const h = setUp()
    // A row written before plan 315 reserved "/" for plugins — the only way this collision can exist.
    const now = new Date()
    h.db.insert(workflows).values({ id: 'op-1', name: 'smm/warmup-rotation', doc: doc('smm/warmup-rotation', 'Mine'), createdBy: 'u1', createdAt: now, updatedAt: now, pluginName: null }).run()

    await h.install('1.0.0', [doc('smm/warmup-rotation', 'The plugin’s')])
    const row = h.db.select().from(workflows).where(eq(workflows.name, 'smm/warmup-rotation')).get()
    expect(row?.pluginName).toBeNull()
    expect((row?.doc as WorkflowDoc).title).toBe('Mine')

    // …and says so, rather than leaving the plugin's workflow silently absent.
    const result = syncPluginWorkflows(h.db, 'smm')
    expect(result.skipped.map((s) => s.name)).toEqual(['smm/warmup-rotation'])
    expect(result.skipped[0]?.reason).toContain('operator')
  })

  test('a resync with nothing changed rewrites nothing', async () => {
    const h = setUp()
    await h.install('1.0.0', [doc('smm/warmup-rotation')])
    const result = syncPluginWorkflows(h.db, 'smm')
    expect(result).toEqual({ registered: [], removed: [], skipped: [] })
  })

  test('the boot pass cleans rows owned by a plugin that no longer exists at all', () => {
    const h = setUp()
    const now = new Date()
    h.db.insert(workflows).values({ id: 'orphan', name: 'gone/warmup', doc: doc('gone/warmup'), createdBy: null, createdAt: now, updatedAt: now, pluginName: 'gone' }).run()
    const results = syncAllPluginWorkflows(h.db)
    expect(results.get('gone')?.removed).toEqual(['gone/warmup'])
    expect(h.store.get('gone/warmup')).toBeNull()
  })
})
