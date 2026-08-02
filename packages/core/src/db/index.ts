import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { embeddedAssets } from '../embedded'
import * as schema from './schema'

export type Db = BunSQLiteDatabase<typeof schema>

export interface OpenedDb {
  db: Db
  sqlite: Database
}

/** Open SQLite (WAL) with Drizzle. Pass ':memory:' for tests. */
export function openDb(path: string): OpenedDb {
  const sqlite = new Database(path, { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/**
 * How many rows a Drizzle `.run()` statement changed.
 * bun:sqlite returns { changes, lastInsertRowid } at runtime, but Drizzle's
 * bun-sqlite types declare `.run()` as void — this helper
 * keeps that adjustment in one place.
 */
export function changedRows(runResult: unknown): number {
  return (runResult as { changes?: number } | undefined)?.changes ?? 0
}

/**
 * Run the migrations in drizzle/ (idempotent, via the drizzle journal).
 *
 * In a compiled binary the drizzle/ folder does not exist on disk; the
 * embedded copies are materialised into a temp folder so the stock drizzle
 * migrator (and its journal semantics) stays authoritative.
 */
export function runMigrations(db: Db): void {
  const embedded = embeddedAssets()?.drizzle
  if (embedded && embedded['meta/_journal.json']) {
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-drizzle-'))
    try {
      for (const [rel, path] of Object.entries(embedded)) {
        const dest = join(dir, rel)
        mkdirSync(dirname(dest), { recursive: true })
        // Not cpSync: the source is a virtual bunfs path (readable, not stat-able).
        writeFileSync(dest, readFileSync(path))
      }
      migrate(db, { migrationsFolder: dir })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    return
  }
  const migrationsFolder = join(import.meta.dir, '..', '..', 'drizzle')
  migrate(db, { migrationsFolder })
}

export { schema }
