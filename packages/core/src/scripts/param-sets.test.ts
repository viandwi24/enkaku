import { describe, expect, test } from 'bun:test'
import { reconcileParams } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createParamPreset, deleteParamPreset, listParamPresets, updateParamPreset } from './param-sets'

/**
 * Plan 311 §4.1, §7 — the generalised preset store: `kind` partitions the
 * one table (`script_param_sets`) between scripts and workflows (G3), a
 * preset is filed under a NAME and survives a version bump (G6), and
 * reconciliation (delegated to `@enkaku/protocol`'s `reconcileParams`) is
 * what a stored preset meets when its schema has moved on (G7).
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function publish(db: Db, name: string, version: string): void {
  db.insert(scripts)
    .values({ id: `${name}-${version}`, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() })
    .run()
}

describe('script presets', () => {
  test('created, listed, updated and deleted (plan 311 §4.4)', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const created = createParamPreset(db, { kind: 'script', ownerName: 'checkout', name: 'nightly', params: { retries: 3 }, createdBy: 'u1' })
    expect(created.kind).toBe('script')
    expect(created.ownerName).toBe('checkout')

    const listed = listParamPresets(db, 'script', 'checkout')
    expect(listed.map((p) => p.id)).toEqual([created.id])

    const updated = updateParamPreset(db, 'script', 'checkout', created.id, { params: { retries: 5 } })
    expect(updated.params).toEqual({ retries: 5 })

    const deleted = deleteParamPreset(db, 'script', 'checkout', created.id)
    expect(deleted.name).toBe('nightly')
    expect(listParamPresets(db, 'script', 'checkout')).toEqual([])
  })

  test('script_not_found when the script name has never been published', () => {
    const db = setUp()
    expect(() => createParamPreset(db, { kind: 'script', ownerName: 'nope', name: 'x', params: {}, createdBy: null })).toThrow(EnkakuError)
    try {
      createParamPreset(db, { kind: 'script', ownerName: 'nope', name: 'x', params: {}, createdBy: null })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('script_not_found')
    }
  })
})

describe('workflow presets (plan 311 G3)', () => {
  test('kind = \'workflow\' rows resolve, independently of any published script', () => {
    const db = setUp()
    // No `scripts` row for 'scroll-fyp' at all — a workflow preset does not
    // need one (assertOwnerExists is a no-op outside kind === 'script').
    const created = createParamPreset(db, { kind: 'workflow', ownerName: 'scroll-fyp', name: 'slow', params: { pace: 'slow' }, createdBy: null })
    expect(created.kind).toBe('workflow')

    const listed = listParamPresets(db, 'workflow', 'scroll-fyp')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe('slow')

    // A script kind under the SAME owner name is a disjoint partition.
    expect(listParamPresets(db, 'script', 'scroll-fyp')).toEqual([])
  })
})

describe('uniqueness is per kind (plan 311 §4.1)', () => {
  test('the same owner name and preset name may exist once for a script AND once for a workflow', () => {
    const db = setUp()
    publish(db, 'nightly-run', '1.0.0')
    const scriptPreset = createParamPreset(db, { kind: 'script', ownerName: 'nightly-run', name: 'default', params: { a: 1 }, createdBy: null })
    const workflowPreset = createParamPreset(db, { kind: 'workflow', ownerName: 'nightly-run', name: 'default', params: { a: 2 }, createdBy: null })
    expect(scriptPreset.id).not.toBe(workflowPreset.id)
    expect(listParamPresets(db, 'script', 'nightly-run')).toHaveLength(1)
    expect(listParamPresets(db, 'workflow', 'nightly-run')).toHaveLength(1)
  })

  test('the same kind and owner name may not reuse a preset name (param_set_name_exists)', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    createParamPreset(db, { kind: 'script', ownerName: 'checkout', name: 'nightly', params: {}, createdBy: null })
    try {
      createParamPreset(db, { kind: 'script', ownerName: 'checkout', name: 'nightly', params: {}, createdBy: null })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('param_set_name_exists')
    }
  })
})

describe('survives a publish (plan 311 G6)', () => {
  test('a preset filed under the NAME is unaffected by a later version of the same script', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const created = createParamPreset(db, { kind: 'script', ownerName: 'checkout', name: 'nightly', params: { retries: 3 }, createdBy: null })

    // The plugin upgrades — a NEW `scripts` row, same name, new version.
    publish(db, 'checkout', '2.0.0')

    const listed = listParamPresets(db, 'script', 'checkout')
    expect(listed.map((p) => p.id)).toEqual([created.id])
    expect(listed[0]?.params).toEqual({ retries: 3 })
  })
})

describe('partial apply (plan 311 §3.4, G7)', () => {
  test('a field the current schema no longer declares is dropped from the applied value and reported, not silently written back', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const created = createParamPreset(db, {
      kind: 'script',
      ownerName: 'checkout',
      name: 'nightly',
      params: { region: 'us', retries: 3 },
      createdBy: null,
    })

    // The schema moved on: `retries` is gone, `region` remains.
    const schema = { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }
    const result = reconcileParams(schema, created.params)

    expect(result.value).toEqual({ region: 'us' })
    expect(result.findings).toEqual([{ path: 'retries', kind: 'removed', detail: 'the current schema no longer declares this parameter' }])
    expect(result.blocking).toBe(false)
  })

  test('a required field the preset never set, with no default, is reported and blocks an unattended caller', () => {
    const db = setUp()
    const created = createParamPreset(db, { kind: 'workflow', ownerName: 'scroll-fyp', name: 'slow', params: { pace: 'slow' }, createdBy: null })
    const schema = {
      type: 'object',
      properties: { pace: { type: 'string' }, deviceProfile: { type: 'string' } },
      required: ['pace', 'deviceProfile'],
    }
    const result = reconcileParams(schema, created.params)
    expect(result.value).toEqual({ pace: 'slow' })
    expect(result.findings).toEqual([
      { path: 'deviceProfile', kind: 'missing', detail: 'is required by the current schema, is not set, and has no default to fall back to' },
    ])
    expect(result.blocking).toBe(true)
  })
})
