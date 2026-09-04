import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from './index'
import { batches, devices, groups, schedules } from './schema'

/**
 * Plan 207 §4.6 — `clusters` → `groups`, `devices.cluster_id` /
 * `batches.cluster_id` / `schedules.cluster_id` → `group_id`, and the three
 * command-console tables dropped, in one hand-written migration
 * (`drizzle/0067_groups_rename.sql`, generated without a TTY per §4.6's own
 * fallback — no interactive rename answer was available in this environment).
 * Modelled on `migrations/rename-agents-to-nodes.test.ts`.
 */
const RENAME_TAG = '0067_groups_rename'

test('a pre-existing group, its member device, a batch and a schedule read back through the renamed Drizzle tables', () => {
  const opened = openDb(':memory:')
  // Stop strictly BEFORE the rename, so every table is still in its
  // pre-207 shape (`clusters`, `*.cluster_id`, the three console tables)
  // when seeded.
  runMigrationsUpTo(opened.db, RENAME_TAG)
  const db = opened.db

  db.run(sql`INSERT INTO clusters (id, name, description, created_at) VALUES ('c1', 'Rack 01', NULL, 1700000000)`)
  db.run(
    sql`INSERT INTO devices (id, stable_id, serial, label, status, cluster_id) VALUES ('d1', 'stable-1', 'SERIAL1', 'Pixel', 'online', 'c1')`,
  )
  db.run(
    sql`INSERT INTO batches (id, cluster_id, script_id, created_at) VALUES ('b1', 'c1', 'smoke-test', 1700000000)`,
  )
  db.run(
    sql`INSERT INTO schedules (id, name, cron, timezone, script_ref, cluster_id, created_at) VALUES ('s1', 'Nightly', '0 0 * * *', 'UTC', 'smoke-test@1.0.0', 'c1', 1700000000)`,
  )
  db.run(
    sql`INSERT INTO command_runs (id, cmd, target, started_at) VALUES ('r1', 'echo hi', '{"deviceIds":["d1"]}', 1700000000)`,
  )

  // Now apply the rest, including the rename and the console-table drop.
  runMigrations(db)

  // The group survives under the new table name, every field intact.
  const groupRows = db.select().from(groups).all()
  expect(groupRows).toHaveLength(1)
  expect(groupRows[0]).toMatchObject({ id: 'c1', name: 'Rack 01', description: null })

  // The device, the batch and the schedule all read their group through the renamed column.
  const deviceRow = db.select().from(devices).where(eq(devices.id, 'd1')).get()
  expect(deviceRow?.groupId).toBe('c1')
  const batchRow = db.select().from(batches).where(eq(batches.id, 'b1')).get()
  expect(batchRow?.groupId).toBe('c1')
  const scheduleRow = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
  expect(scheduleRow?.groupId).toBe('c1')

  // The old table name and the old column name are both gone.
  expect(() => db.run(sql`SELECT * FROM clusters`)).toThrow()
  expect(() => db.run(sql`SELECT cluster_id FROM devices`)).toThrow()

  const deviceColumns = db.all<{ name: string }>(sql`PRAGMA table_info(devices)`).map((c) => c.name)
  expect(deviceColumns).toContain('group_id')
  expect(deviceColumns).not.toContain('cluster_id')

  const indexNames = db
    .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .map((r) => r.name)
  expect(indexNames).toContain('idx_groups_created')
  expect(indexNames).toContain('idx_devices_group')
  expect(indexNames).not.toContain('idx_clusters_created')
  expect(indexNames).not.toContain('idx_devices_cluster')

  // The command console's three tables no longer exist (MVP 15 §0.1 item 4).
  const tableNames = db
    .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .map((r) => r.name)
  expect(tableNames).not.toContain('command_runs')
  expect(tableNames).not.toContain('command_run_members')
  expect(tableNames).not.toContain('saved_commands')
})

describe('command_runs, command_run_members and saved_commands no longer exist', () => {
  test('a fresh database (every migration applied) has none of the three tables', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const tableNames = opened.db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((r) => r.name)
    expect(tableNames).not.toContain('command_runs')
    expect(tableNames).not.toContain('command_run_members')
    expect(tableNames).not.toContain('saved_commands')
    expect(tableNames).toContain('groups')
    expect(tableNames).not.toContain('clusters')
  })
})

describe('the resulting schema (plan 207 §4.6)', () => {
  test('a fresh group insert works under the new name and column', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(groups).values({ id: 'g2', name: 'Rack 02', createdAt: new Date() }).run()
    db.insert(devices).values({ id: 'd2', stableId: 'stable-2', serial: 'SERIAL2', label: 'Pixel 2', groupId: 'g2' }).run()

    const row = db.select().from(devices).where(eq(devices.id, 'd2')).get()
    expect(row?.groupId).toBe('g2')
  })
})
