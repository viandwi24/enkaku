import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { EnkakuError } from '../util/errors'
import { createScriptRegistry } from './registry'
import { listScriptGroups, publishScript } from './service'
import type { ScriptRef } from '@enkaku/protocol'

/**
 * The writer's rule (plan 110 §3.2, §4.1, §5 step 110.1) — "a script cannot be
 * published outside a plugin", enforced in the ONE function every publish path
 * reaches, against a real database rather than a stub of one.
 *
 * The four callers each have their own test where they live (`scripts/
 * routes.test.ts`, `capability/script.test.ts`, `api/workflows.test.ts`,
 * `api/recordings.test.ts`); this file is the rule itself, plus what the farm
 * does with the rows a pre-upgrade farm already has.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function expectEnkakuError(fn: () => unknown): EnkakuError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(EnkakuError)
    return err as EnkakuError
  }
  throw new Error('expected a refusal, but the call succeeded')
}

describe('publishScript refuses a plugin-less script (plan 110 §3.2, criterion 1)', () => {
  test('a kind:"script" row with no owning plugin is refused with E_SCRIPT_NEEDS_PLUGIN, and nothing is written', () => {
    const db = setUp()
    const err = expectEnkakuError(() => publishScript(db, { name: 'checkout', version: '1.0.0', bundle: 'export {}' }))
    expect(err.code).toBe('E_SCRIPT_NEEDS_PLUGIN')
    expect(db.select().from(scripts).all()).toHaveLength(0)
  })

  test('the refusal names the rule, points at definePlugin, and says what to write', () => {
    const db = setUp()
    const err = expectEnkakuError(() => publishScript(db, { name: 'checkout', version: '1.0.0', bundle: 'export {}' }))
    expect(err.message).toContain('checkout@1.0.0')
    expect(err.message).toContain('A script cannot be published outside a plugin')
    expect(err.message).toContain('definePlugin({ id, version, scripts: [ … ] })')
    expect(err.message).toContain('<plugin>/<script>')
  })

  /**
   * Criterion 2's second half. A message that merely left workflows out would
   * read as an oversight; this asserts the wording explains the exemption as a
   * CONSEQUENCE of the rule (§3.3), which is the only version of it a reader
   * can trust.
   */
  test('the refusal explains why a workflow is not an exception but a consequence of the rule\'s wording', () => {
    const db = setUp()
    const err = expectEnkakuError(() => publishScript(db, { name: 'checkout', version: '1.0.0', bundle: 'export {}' }))
    expect(err.message).toContain('WorkflowDoc')
    expect(err.message).toContain('no run()')
    expect(err.message).toContain('nothing to share by import')
  })

  test('half an owner is refused too — pluginId and exportId are written together or not at all', () => {
    const db = setUp()
    const missingExport = expectEnkakuError(() => publishScript(db, { name: 'demo/a', version: '1.0.0', bundle: 'export {}', pluginId: 'p1' }))
    expect(missingExport.code).toBe('E_SCRIPT_NEEDS_PLUGIN')
    expect(missingExport.message).toContain('written together')
    const missingPlugin = expectEnkakuError(() => publishScript(db, { name: 'demo/a', version: '1.0.0', bundle: 'export {}', exportId: 'a' }))
    expect(missingPlugin.code).toBe('E_SCRIPT_NEEDS_PLUGIN')
    expect(db.select().from(scripts).all()).toHaveLength(0)
  })

  test('an owned script row publishes, carrying both columns', () => {
    const db = setUp()
    const published = publishScript(db, { name: 'demo/checkout', version: '1.0.0', bundle: 'export {}', pluginId: 'p1', exportId: 'checkout' })
    const row = db.select().from(scripts).where(eq(scripts.id, published.id)).get()
    expect(row?.kind).toBe('script')
    expect(row?.pluginId).toBe('p1')
    expect(row?.exportId).toBe('checkout')
  })
})

describe('a workflow still publishes with no plugin (plan 110 §3.3, criterion 2)', () => {
  test('kind:"workflow" needs no owner, and its two ownership columns stay null', () => {
    const db = setUp()
    const published = publishScript(db, { name: 'nightly', version: '1.0.0', bundle: '{"schema":1}', kind: 'workflow' })
    const row = db.select().from(scripts).where(eq(scripts.id, published.id)).get()
    expect(row?.kind).toBe('workflow')
    expect(row?.pluginId).toBeNull()
    expect(row?.exportId).toBeNull()
  })

  test('a workflow that DOES arrive with an owner is refused — the exemption is not a free-for-all', () => {
    const db = setUp()
    const err = expectEnkakuError(() =>
      publishScript(db, { name: 'nightly', version: '1.0.0', bundle: '{"schema":1}', kind: 'workflow', pluginId: 'p1', exportId: 'nightly' }),
    )
    expect(err.code).toBe('E_BAD_REQUEST')
    expect(err.message).toContain('never has an owning plugin')
  })
})

/**
 * Plan 110 §3.2, and what a farm that upgraded into the rule does with the
 * rows it already had: a `kind: 'script'` row with no owning plugin is IGNORED
 * — it does not list, does not group, does not resolve. Nothing deletes it
 * (that stays the operator's call, §3.5) and no job history changes, because
 * `jobs.script_name`/`script_version` are denormalised for exactly this.
 *
 * Written directly here, the way a pre-upgrade farm has them, because the
 * writer above now refuses to create one.
 */
describe('rows a pre-plan-110 farm already has are ignored, not served', () => {
  function insertUnowned(db: Db, name: string, version: string): string {
    const id = `${name}-${version}`
    db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
    return id
  }

  test('it resolves by neither an exact ref nor @latest', () => {
    const db = setUp()
    insertUnowned(db, 'chrome-open-url', '1.0.0')
    insertUnowned(db, 'chrome-open-url', '1.4.0')
    const registry = createScriptRegistry({ db, dataDir: '/tmp', devSlots: createDevSlotStore() })

    expect(expectEnkakuError(() => registry.resolve('chrome-open-url@1.0.0' as ScriptRef)).code).toBe('script_not_found')
    expect(expectEnkakuError(() => registry.resolve('chrome-open-url@latest' as ScriptRef)).code).toBe('script_not_found')
  })

  test('it is neither listed nor grouped beside the owned ones', () => {
    const db = setUp()
    insertUnowned(db, 'debug-node', '1.0.0')
    publishScript(db, { name: 'demo/checkout', version: '1.0.0', bundle: 'export {}', pluginId: 'p1', exportId: 'checkout' })
    const registry = createScriptRegistry({ db, dataDir: '/tmp', devSlots: createDevSlotStore() })
    expect(registry.list().items.map((e) => `${e.name}:${e.origin}`)).toEqual(['demo/checkout:plugin'])
    expect(registry.groups().map((g) => g.name)).toEqual(['demo/checkout'])
    // Still on disk — ignored is not deleted.
    expect(db.select().from(scripts).where(eq(scripts.name, 'debug-node')).all()).toHaveLength(1)
  })

  test('the grouped list every Studio screen reads leaves it out too, so nothing offers to run it', () => {
    const db = setUp()
    insertUnowned(db, 'debug-node', '1.0.0')
    publishScript(db, { name: 'demo/checkout', version: '1.0.0', bundle: 'export {}', pluginId: 'p1', exportId: 'checkout' })
    expect(listScriptGroups(db).map((g) => g.name)).toEqual(['demo/checkout'])
  })
})
