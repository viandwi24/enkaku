import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from '../index'
import { devices, nodes } from '../schema'

/**
 * Plan 61 §3.4, §4.2, step 61.1: `agents` → `nodes`, `devices.agent_id` →
 * `devices.node_id`. Hand-written `ALTER TABLE ... RENAME` /
 * `RENAME COLUMN` statements (not drizzle-kit's proposed drop+create), so a
 * control plane upgraded in place keeps its enrolled node's id, name,
 * status, and lastSeen — and the device it owns keeps pointing at it under
 * the renamed column. No row is duplicated or dropped (acceptance #3).
 *
 * Note: the plan's §3.4 also names `deviceEvents.agentId` as part of this
 * migration; the actual schema has no such column — `agentId` (now
 * `nodeId`) lives only on `devices`. This test covers the column that
 * actually exists.
 */
const RENAME_TAG = '0023_rename_agents_to_nodes'

test('a pre-existing agent row and the device it owns survive the rename unchanged', () => {
  const opened = openDb(':memory:')
  // Stop strictly BEFORE the rename, so both tables are still in their
  // pre-plan-61 shape (`agents`, `devices.agent_id`) when seeded.
  runMigrationsUpTo(opened.db, RENAME_TAG)
  const db = opened.db

  db.run(
    sql`INSERT INTO agents (id, name, status, platform, last_seen, created_at) VALUES ('agent-1', 'lab-jakarta', 'online', 'linux-x64', 1700000000, 1699999000)`,
  )
  db.run(
    sql`INSERT INTO devices (id, stable_id, serial, label, agent_id) VALUES ('dev-1', 'stable-1', 'SERIAL1', 'Pixel', 'agent-1')`,
  )

  // Now apply the rest, including the rename.
  runMigrations(db)

  // The row moved to `nodes` with every field intact — same id, same status,
  // same lastSeen. No duplicate row anywhere.
  const nodeRows = db.select().from(nodes).all()
  expect(nodeRows).toHaveLength(1)
  expect(nodeRows[0]).toMatchObject({ id: 'agent-1', name: 'lab-jakarta', status: 'online', platform: 'linux-x64' })
  expect(nodeRows[0]?.lastSeen?.getTime()).toBe(1700000000 * 1000)

  // The owning device now points at it through the renamed column.
  const deviceRow = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
  expect(deviceRow?.nodeId).toBe('agent-1')

  // The old table name is gone — a plain `SELECT * FROM agents` must fail,
  // not silently return zero rows from an accidental second table.
  expect(() => db.run(sql`SELECT * FROM agents`)).toThrow()
})

describe('the resulting schema (plan 61 §4.2)', () => {
  test('a fresh node insert works under the new name and column', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(nodes).values({ id: 'node-2', name: 'lab-bandung', status: 'pending', createdAt: new Date() }).run()
    db.insert(devices).values({ id: 'dev-2', stableId: 'stable-2', serial: 'SERIAL2', label: 'Pixel 2', nodeId: 'node-2' }).run()

    const row = db.select().from(devices).where(eq(devices.id, 'dev-2')).get()
    expect(row?.nodeId).toBe('node-2')
  })
})
