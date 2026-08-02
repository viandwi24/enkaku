import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { embeddedAssets } from '../embedded'
import { EnkakuError } from '../util/errors'
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

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

/**
 * Resolve the effective migrations folder: in a compiled binary the drizzle/
 * folder does not exist on disk, so the embedded copies are materialised
 * into a temp folder first; running from source uses the real folder
 * directly. Callers must invoke `cleanup()` when done.
 */
function materialiseMigrationsFolder(): { dir: string; cleanup: () => void } {
  const embedded = embeddedAssets()?.drizzle
  if (embedded && embedded['meta/_journal.json']) {
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-drizzle-'))
    for (const [rel, path] of Object.entries(embedded)) {
      const dest = join(dir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      // Not cpSync: the source is a virtual bunfs path (readable, not stat-able).
      writeFileSync(dest, readFileSync(path))
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }
  return { dir: join(import.meta.dir, '..', '..', 'drizzle'), cleanup: () => {} }
}

/**
 * Run every migration in drizzle/ (idempotent, via the drizzle journal).
 */
export function runMigrations(db: Db): void {
  const { dir, cleanup } = materialiseMigrationsFolder()
  try {
    migrate(db, { migrationsFolder: dir })
  } finally {
    cleanup()
  }
}

/**
 * Apply only the migrations strictly before `tag`, leaving that migration
 * (and everything after it) pending (plan 22.0 §4.1).
 *
 * This opens a window for a one-shot TypeScript data step — currently only
 * `db/migrations/cluster-materialise.ts` — that must run after the schema
 * change it depends on (`devices.cluster_id` existing) but before a later
 * migration destroys the data it reads (`clusters.tags`/`device_ids` being
 * dropped). Drizzle's own migration bookkeeping tracks progress by
 * timestamp, not by which folder was passed to `migrate()`, so a plain
 * `runMigrations(db)` call afterward applies exactly the remainder: nothing
 * is re-applied, nothing is skipped (verified by
 * `cluster-materialise.test.ts`).
 */
export function runMigrationsUpTo(db: Db, tag: string): void {
  const { dir, cleanup } = materialiseMigrationsFolder()
  try {
    const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as Journal
    const cut = journal.entries.findIndex((e) => e.tag === tag)
    if (cut === -1) {
      throw new EnkakuError('E_DB', `runMigrationsUpTo: no migration tagged "${tag}" in the journal`)
    }
    const entries = journal.entries.slice(0, cut)
    const subDir = mkdtempSync(join(tmpdir(), 'enkaku-drizzle-upto-'))
    try {
      mkdirSync(join(subDir, 'meta'), { recursive: true })
      writeFileSync(join(subDir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))
      for (const entry of entries) {
        copyFileSync(join(dir, `${entry.tag}.sql`), join(subDir, `${entry.tag}.sql`))
      }
      migrate(db, { migrationsFolder: subDir })
    } finally {
      rmSync(subDir, { recursive: true, force: true })
    }
  } finally {
    cleanup()
  }
}

export { schema }
