import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { isUnownedScriptRow } from './service'

/**
 * Plan 210 (MVP 03 §2): the only writer of a `scripts` row is
 * `plugins/runtime.ts`'s `writeScriptRows` — this file no longer tests a
 * publish path (there is none to test here any more; see
 * `plugins/runtime.test.ts` for the writer, `scripts/routes.test.ts` for the
 * active-only list). What is left is the rule a farm's already-existing rows
 * still have to obey: a row with no owning plugin is unowned and ignored.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

describe('isUnownedScriptRow (plan 210 §4.5)', () => {
  test('a row with no pluginId is unowned', () => {
    expect(isUnownedScriptRow({ pluginId: null })).toBe(true)
  })

  test('a row with a pluginId is owned', () => {
    expect(isUnownedScriptRow({ pluginId: 'p1' })).toBe(false)
  })
})

describe('rows a pre-existing farm already has, with no owning plugin, are ignored', () => {
  function insertUnowned(db: Db, name: string, version: string): string {
    const id = `${name}-${version}`
    db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
    return id
  }

  test('an unowned row is still on disk — ignored, not deleted', () => {
    const db = setUp()
    insertUnowned(db, 'debug-node', '1.0.0')
    expect(db.select().from(scripts).where(eq(scripts.name, 'debug-node')).all()).toHaveLength(1)
    const row = db.select().from(scripts).where(eq(scripts.name, 'debug-node')).get()
    expect(row && isUnownedScriptRow(row)).toBe(true)
  })
})
