import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations, runMigrationsUpTo } from './index'

/**
 * A poisoned `__drizzle_migrations.created_at` silently hides every later
 * migration, and this is not hypothetical: plans 61 and 62 hand-wrote their
 * migrations (drizzle-kit's rename prompt needs a TTY) and stamped
 * `0023`/`0024` with round synthetic values larger than every real
 * generation time that followed. Databases migrated while those were in the
 * journal skipped `0025`–`0036` with no error and no log line — the first
 * visible symptom was `GET /api/v1/threads` answering a bare 500 because
 * `agent_threads.device_scope` had never been added.
 *
 * The repair lives in `runMigrations`. These tests pin it against a database
 * built the same way a real one was: migrate, poison the watermark, then
 * migrate again and require the remainder to actually land.
 */
/**
 * Cut the partial database here: everything before this tag applies, this one
 * and everything after stays pending. Chosen because `0035` creates
 * `agent_blobs`, so the test can assert the hidden migrations' SCHEMA landed
 * and not merely their bookkeeping.
 */
const PARTIAL_CUT_TAG = '0035_cloudy_lightspeed'

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-watermark-'))
  const opened = openDb(join(dir, 'test.db'))
  return { ...opened, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function watermark(sqlite: ReturnType<typeof freshDb>['sqlite']): number {
  return (sqlite.query('SELECT max(created_at) AS m FROM __drizzle_migrations').get() as { m: number }).m
}

function rowCount(sqlite: ReturnType<typeof freshDb>['sqlite']): number {
  return (sqlite.query('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n
}

describe('migration watermark repair (plan 61/62 fallout)', () => {
  test('a watermark poisoned above every later entry no longer hides the remainder', () => {
    const full = (() => {
      const f = freshDb()
      try {
        runMigrations(f.db, f.sqlite)
        return rowCount(f.sqlite)
      } finally {
        f.cleanup()
      }
    })()
    expect(full).toBeGreaterThan(30)

    const { db, sqlite, cleanup } = freshDb()
    try {
      // A genuinely partial database — schema AND bookkeeping stop together,
      // which is what a real half-migrated install looks like. Deleting rows
      // from a fully-migrated one would leave the schema ahead of the log and
      // test a state that cannot occur.
      runMigrationsUpTo(db, PARTIAL_CUT_TAG)
      const partial = rowCount(sqlite)
      expect(partial).toBeLessThan(full)

      // Poison it exactly as plans 61/62 did: the newest recorded row carries
      // a timestamp larger than every journal entry that follows it.
      sqlite.query(`UPDATE __drizzle_migrations SET created_at = 1786100000000 WHERE rowid = ${partial}`).run()
      expect(watermark(sqlite)).toBe(1786100000000)

      // Without the repair, drizzle concludes everything is already applied
      // and this call is a silent no-op.
      runMigrations(db, sqlite)

      expect(rowCount(sqlite)).toBe(full)
      expect(watermark(sqlite)).toBeLessThan(1786100000000)

      // The schema the hidden migrations carried actually landed.
      const tables = (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
      expect(tables).toContain('agent_blobs')
    } finally {
      cleanup()
    }
  })

  test('matching is by rowid, not by the always-NULL `id` column', () => {
    // Drizzle creates the table as `id SERIAL PRIMARY KEY`; SQLite has no
    // `SERIAL`, so `id` is NULL on every row. A repair keyed on it updates
    // nothing at all — silently. This pins the shape rather than the fix.
    const { db, sqlite, cleanup } = freshDb()
    try {
      runMigrations(db, sqlite)
      const nulls = sqlite.query('SELECT count(*) AS n FROM __drizzle_migrations WHERE id IS NULL').get() as { n: number }
      expect(nulls.n).toBe(rowCount(sqlite))
    } finally {
      cleanup()
    }
  })

  test('a database already in step is left untouched, and re-running changes nothing', () => {
    const { db, sqlite, cleanup } = freshDb()
    try {
      runMigrations(db, sqlite)
      const before = { n: rowCount(sqlite), m: watermark(sqlite) }
      runMigrations(db, sqlite)
      expect({ n: rowCount(sqlite), m: watermark(sqlite) }).toEqual(before)
    } finally {
      cleanup()
    }
  })

  test('a fresh database with no migrations table is not a failure', () => {
    const { db, sqlite, cleanup } = freshDb()
    try {
      expect(() => runMigrations(db, sqlite)).not.toThrow()
    } finally {
      cleanup()
    }
  })
})
