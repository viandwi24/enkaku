import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { join } from 'node:path'
import * as schema from './schema'

export type Db = BunSQLiteDatabase<typeof schema>

export interface OpenedDb {
  db: Db
  sqlite: Database
}

/** Buka SQLite (WAL) + Drizzle. `path` = ':memory:' untuk test. */
export function openDb(path: string): OpenedDb {
  const sqlite = new Database(path, { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/** Jalankan migrasi dari folder drizzle/ (idempotent — drizzle journal). */
export function runMigrations(db: Db): void {
  const migrationsFolder = join(import.meta.dir, '..', '..', 'drizzle')
  migrate(db, { migrationsFolder })
}

export { schema }
