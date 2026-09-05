import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from './index'
import { paramPresets } from './schema'

/**
 * Plan 311 §4.1, G5 — `script_param_sets.script_name` → `owner_name`
 * (`ALTER TABLE … RENAME COLUMN`), plus one new `kind text NOT NULL DEFAULT
 * 'script'` column and an index swap (`0075_sweet_silver_fox.sql`,
 * `0076_pretty_nemesis.sql`) — no table rebuild, no `DROP`, so a
 * pre-existing preset row survives with its `params` intact and defaults to
 * `kind = 'script'` (every row on the farm before this plan was a script
 * preset; workflows had no presets to have written one).
 */
const RENAME_TAG = '0075_sweet_silver_fox'

test('preset migration: a pre-existing preset survives the rename and gains kind = \'script\' by default', () => {
  const opened = openDb(':memory:')
  // Stop strictly BEFORE the column rename, so the table is still in its
  // pre-311 shape (`script_name`, no `kind`) when seeded.
  runMigrationsUpTo(opened.db, RENAME_TAG)
  const db = opened.db

  db.run(
    sql`INSERT INTO script_param_sets (id, script_name, name, params, created_by, created_at, updated_at) VALUES ('p1', 'checkout', 'nightly', '{"retries":3}', 'u1', 1700000000, 1700000000)`,
  )

  // Now apply the rest, including the rename.
  runMigrations(db)

  const rows = db.select().from(paramPresets).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 'p1', kind: 'script', ownerName: 'checkout', name: 'nightly', createdBy: 'u1' })
  expect(rows[0]?.params).toEqual({ retries: 3 })

  // The old column name is gone; the new one is there.
  const columns = db.all<{ name: string }>(sql`PRAGMA table_info(script_param_sets)`).map((c) => c.name)
  expect(columns).toContain('owner_name')
  expect(columns).toContain('kind')
  expect(columns).not.toContain('script_name')

  const indexNames = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index'`).map((r) => r.name)
  expect(indexNames).toContain('idx_param_sets_owner')
  expect(indexNames).not.toContain('idx_param_sets_script_name')
})

describe('the resulting schema (plan 311 §4.1)', () => {
  test('a fresh insert works under the new columns, for both kinds', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db

    db.insert(paramPresets)
      .values({ id: 's1', kind: 'script', ownerName: 'checkout', name: 'nightly', params: { a: 1 }, createdAt: new Date(), updatedAt: new Date() })
      .run()
    db.insert(paramPresets)
      .values({ id: 'w1', kind: 'workflow', ownerName: 'scroll-fyp', name: 'slow', params: { pace: 'slow' }, createdAt: new Date(), updatedAt: new Date() })
      .run()

    const scriptRow = db.select().from(paramPresets).where(eq(paramPresets.id, 's1')).get()
    expect(scriptRow?.ownerName).toBe('checkout')
    const workflowRow = db.select().from(paramPresets).where(eq(paramPresets.id, 'w1')).get()
    expect(workflowRow?.kind).toBe('workflow')
  })

  test('the same name may exist once per kind, for the same owner (idx_param_sets_owner)', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(paramPresets)
      .values({ id: 's1', kind: 'script', ownerName: 'checkout', name: 'default', params: {}, createdAt: new Date(), updatedAt: new Date() })
      .run()
    db.insert(paramPresets)
      .values({ id: 'w1', kind: 'workflow', ownerName: 'checkout', name: 'default', params: {}, createdAt: new Date(), updatedAt: new Date() })
      .run()
    expect(() =>
      db.insert(paramPresets).values({ id: 's2', kind: 'script', ownerName: 'checkout', name: 'default', params: {}, createdAt: new Date(), updatedAt: new Date() }).run(),
    ).toThrow()
  })
})
