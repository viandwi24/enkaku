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
 * Open an existing `enkaku.db` for READING, from a process that does not own
 * it — `enkaku doctor`'s registry checks and `createBackup`'s `VACUUM INTO`.
 *
 * Read-only is what these callers want and what they try first: it is a
 * structural guarantee that a diagnostic or a backup can never perturb a
 * database the core may be actively writing to.
 *
 * It is not always available. A WAL database whose write-ahead log has not
 * been checkpointed needs recovery before it can be read, and recovery is a
 * WRITE — SQLite answers `SQLITE_READONLY_RECOVERY`/`unable to open database
 * file` rather than doing it from a read-only connection, and it needs a
 * writable `-shm` for the same reason. The core holds an uncheckpointed WAL
 * for as long as it is running, which is most of the time, and the platform
 * decides whether that read still squeaks through: it does on macOS and
 * Linux, and `check-windows`'s first ever run (2026-09-05) failed fifteen
 * tests across backup and doctor in exactly the pattern a refused read-only
 * open produces — every case expecting real rows failed, and the one case
 * expecting "no database" passed.
 *
 * So a refusal falls back to a read-write open rather than giving up. That is
 * strictly better than what each caller did without it — throw, or report a
 * populated farm as having no database at all — and it is not a licence to
 * write: neither caller issues anything but reads. What it costs is the
 * guarantee, in the narrow case where the alternative was not working, so the
 * fallback is second and never first.
 *
 * `create: false` on both: a caller reading a database must never conjure an
 * empty one, and "no such file" has to stay distinguishable from "would not
 * open".
 */
export function openForReading(path: string): Database {
  try {
    return new Database(path, { readonly: true, create: false })
  } catch (readonlyErr) {
    try {
      return new Database(path, { readonly: false, create: false })
    } catch {
      // The read-only error is the one worth reporting: it is the open we
      // wanted, and the fallback's own failure is almost always the same
      // cause wearing different words.
      throw readonlyErr
    }
  }
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
 * Realign `__drizzle_migrations.created_at` with the journal's own `when`
 * values, in application order.
 *
 * Drizzle decides what is still pending by comparing each journal entry's
 * `when` against the HIGHEST `created_at` already recorded — see
 * `runMigrationsUpTo`'s note. So a single recorded row carrying a timestamp
 * larger than every later entry's `when` permanently hides all of them: the
 * migrator concludes they are already applied and never runs them, with no
 * error and no log line.
 *
 * That is not hypothetical. Plans 61 and 62 hand-wrote their migrations
 * (drizzle-kit's rename prompt needs a TTY) and stamped `0023`/`0024` with
 * round synthetic values — `1786000000000` and `1786100000000` — larger than
 * every real generation time that followed. Any database migrated while
 * those were in the journal recorded the poisoned value, and then silently
 * skipped `0025`–`0036`: `agent_blobs` was never created and
 * `agent_threads.device_scope` never added, so `GET /api/v1/threads` failed
 * with a bare 500. Correcting the journal alone does NOT help — the bad
 * number is already in the database.
 *
 * The repair is self-healing rather than a one-shot marker, because it is
 * cheap, idempotent, and the failure it prevents is invisible: the journal
 * is the authority on when each migration was generated, so any row that
 * disagrees is wrong by definition.
 *
 * Rows are matched to journal entries by `rowid`, which is the order they
 * were applied in — NOT by `created_at`, which is the value under repair,
 * and NOT by `id`: drizzle creates the table as `id SERIAL PRIMARY KEY`,
 * SQLite has no `SERIAL`, so that column is NULL on every row and matching
 * on it silently updates nothing. Only rows that actually differ are
 * written.
 */
function realignMigrationTimestamps(sqlite: Database, journalPath: string): number {
  const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal
  const table = sqlite
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get()
  if (!table) return 0 // a fresh database: nothing has been recorded yet
  const rows = sqlite.query<{ rowid: number; created_at: number }, []>('SELECT rowid, created_at FROM __drizzle_migrations ORDER BY rowid ASC').all()
  const update = sqlite.query<unknown, [number, number]>('UPDATE __drizzle_migrations SET created_at = ? WHERE rowid = ?')
  let fixed = 0
  for (const [i, row] of rows.entries()) {
    const entry = parsed.entries[i]
    if (!entry || row.created_at === entry.when) continue
    update.run(entry.when, row.rowid)
    fixed++
  }
  return fixed
}

/**
 * Run every migration in drizzle/ (idempotent, via the drizzle journal).
 */
export function runMigrations(db: Db, sqlite?: Database): void {
  const { dir, cleanup } = materialiseMigrationsFolder()
  try {
    // Before the migrator reads its watermark, not after — see the note above.
    if (sqlite) realignMigrationTimestamps(sqlite, join(dir, 'meta', '_journal.json'))
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
 * `db/migrations/materialise-0014.ts` — that must run after the schema
 * change it depends on (the pre-rename membership column existing) but before a later
 * migration destroys the data it reads (the pre-`0014` selector columns
 * being dropped). Drizzle's own migration bookkeeping tracks progress by
 * timestamp, not by which folder was passed to `migrate()`, so a plain
 * `runMigrations(db)` call afterward applies exactly the remainder: nothing
 * is re-applied, nothing is skipped (verified by
 * `materialise-0014.test.ts`).
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
