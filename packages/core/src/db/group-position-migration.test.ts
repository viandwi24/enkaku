import { expect, test } from 'bun:test'
import { asc, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from './index'
import { groups } from './schema'

/**
 * `0088` adds `groups.position` and backfills it from the order the Devices
 * strip already showed — `created_at` DESC, `id` DESC — so an upgrade moves
 * no tab. Every pre-existing group must come out with a distinct position.
 */
const POSITION_TAG = '0088_greedy_jane_foster'

test('existing groups keep their newest-first order as distinct positions', () => {
  const opened = openDb(':memory:')
  runMigrationsUpTo(opened.db, POSITION_TAG)
  const db = opened.db

  db.run(sql`INSERT INTO groups (id, name, description, created_at) VALUES ('old', 'OLD', NULL, 1700000000)`)
  db.run(sql`INSERT INTO groups (id, name, description, created_at) VALUES ('mid-a', 'MID-A', NULL, 1700000500)`)
  db.run(sql`INSERT INTO groups (id, name, description, created_at) VALUES ('mid-b', 'MID-B', NULL, 1700000500)`)
  db.run(sql`INSERT INTO groups (id, name, description, created_at) VALUES ('new', 'NEW', NULL, 1700009000)`)

  runMigrations(db)

  const rows = db.select().from(groups).orderBy(asc(groups.position)).all()
  expect(rows.map((r) => [r.id, r.position])).toEqual([
    ['new', 0],
    ['mid-b', 1],
    ['mid-a', 2],
    ['old', 3],
  ])
})
