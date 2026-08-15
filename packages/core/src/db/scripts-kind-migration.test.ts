import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from './index'
import { scripts } from './schema'

/**
 * Plan 99 §3.1, §4.5, step 99.5 — `scripts.kind` ships as
 * `NOT NULL DEFAULT 'script'` (migration `0044_huge_sandman.sql`, generated
 * by `bun run --cwd packages/core db:generate`, never hand-written — see
 * `migration-watermark.test.ts`'s header for why that rule exists). The
 * whole claim of "no backfill" is that a row written before this column
 * existed reads back `'script'` with no application code ever touching it.
 *
 * This is checked against a row built the way a real pre-plan-99 install
 * actually has one: inserted through raw SQL BEFORE the migration that adds
 * the column ever runs, not through Drizzle's schema-aware insert (which
 * would happily target a column that does not exist yet at that point in
 * the test and prove nothing about the ALTER TABLE's own default).
 */
describe('scripts.kind — migration default, no backfill (plan 99 §4.5)', () => {
  test('a pre-existing row (no kind column at insert time) reads kind "script" once fully migrated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-scripts-kind-'))
    try {
      const { db, sqlite } = openDb(join(dir, 'test.db'))
      // Leave 0044 (this step's migration) and everything after it pending.
      runMigrationsUpTo(db, '0044_huge_sandman')

      // Confirm the pre-migration shape actually has no `kind` column —
      // otherwise this test would prove nothing about the ALTER TABLE.
      const columnsBefore = (sqlite.query("PRAGMA table_info('scripts')").all() as { name: string }[]).map((c) => c.name)
      expect(columnsBefore).not.toContain('kind')

      sqlite.exec(
        `INSERT INTO scripts (id, name, version, bundle, enabled, created_at) VALUES ('pre-existing-1', 'checkout', '1.0.0', 'export {}', 1, 1700000000)`,
      )

      // Bring the database fully up to date, including 0044.
      runMigrations(db, sqlite)

      const columnsAfter = (sqlite.query("PRAGMA table_info('scripts')").all() as { name: string }[]).map((c) => c.name)
      expect(columnsAfter).toContain('kind')

      const row = db.select().from(scripts).where(eq(scripts.id, 'pre-existing-1')).get()
      expect(row?.kind).toBe('script')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a freshly-migrated database creates job_nodes and artifacts.node_id (plan 99 §4.6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-scripts-kind-'))
    try {
      const { db, sqlite } = openDb(join(dir, 'test.db'))
      runMigrations(db, sqlite)

      const tables = (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
      expect(tables).toContain('job_nodes')

      const artifactColumns = (sqlite.query("PRAGMA table_info('artifacts')").all() as { name: string }[]).map((c) => c.name)
      expect(artifactColumns).toContain('node_id')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
