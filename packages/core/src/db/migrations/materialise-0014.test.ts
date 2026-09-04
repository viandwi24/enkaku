import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations, runMigrationsUpTo, type Db } from '../index'
import { migrationMarkers } from '../schema'
import { createLogger } from '../../util/logger'
import { DROP_CLUSTER_SELECTOR_COLUMNS_TAG, materialiseMembership, type Materialise0014Report } from './materialise-0014'

/**
 * The exact window this step must run in (plan 22.0 §4.1): everything before
 * `DROP_CLUSTER_SELECTOR_COLUMNS_TAG` applied (so `devices.cluster_id`
 * exists), that migration itself still pending (so the pre-`0014` selector
 * columns are still readable).
 */
function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrationsUpTo(opened.db, DROP_CLUSTER_SELECTOR_COLUMNS_TAG)
  return opened.db
}

/**
 * Raw SQL, not `db.insert(devices)`/`db.select(devices...)` (plan 43 §5,
 * carried forward by plan 207): the frozen table this test runs against
 * predates every migration after `DROP_CLUSTER_SELECTOR_COLUMNS_TAG` —
 * including the plan 207 `0066_groups_rename` that renames
 * `devices.cluster_id` to `devices.group_id` — while the live `devices`
 * Drizzle object (`../schema`) always reflects the FINAL, post-0066 column
 * names. Using it here would read/write a column (`group_id`) that does not
 * exist yet at this point in the migration sequence.
 */
function seedDevice(db: Db, id: string, status: 'idle' | 'offline' = 'idle'): void {
  db.run(
    sql`INSERT INTO devices (id, stable_id, serial, label, status) VALUES (${id}, ${`stable-${id}`}, ${`serial-${id}`}, ${`device ${id}`}, ${status})`,
  )
}

/** The pre-`0014` `clusters` shape (tags/device_ids), inserted with raw SQL since the current Drizzle schema no longer declares that table under that name. */
function seedLegacyCluster(
  db: Db,
  id: string,
  name: string,
  tags: string[],
  deviceIds: string[],
  createdAtSec: number,
): void {
  db.run(
    sql`INSERT INTO clusters (id, name, description, tags, device_ids, created_at) VALUES (${id}, ${name}, NULL, ${JSON.stringify(tags)}, ${JSON.stringify(deviceIds)}, ${createdAtSec})`,
  )
}

/** Raw-SQL read of the pre-0066 column name, for the same reason `seedDevice`/`seedLegacyCluster` above are raw SQL. */
function readDeviceGroup(db: Db, id: string): string | null {
  const rows = db.all<{ cluster_id: string | null }>(sql`SELECT cluster_id FROM devices WHERE id = ${id}`)
  return rows[0]?.cluster_id ?? null
}

function tempDataDir(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-materialise-0014-'))
  return { dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

describe('materialiseMembership (plan 22.0 §3.4, §7)', () => {
  test('three overlapping groups: oldest wins, every conflict is named, a second run changes nothing', () => {
    const db = setUp()
    const { dataDir, cleanup } = tempDataDir()
    try {
      seedDevice(db, 'd1')
      seedDevice(db, 'd2')
      seedDevice(db, 'd3')
      // d1 and d2 carry a tag matched by both "old" and "mid" — old wins.
      db.run(sql`INSERT INTO device_tags (device_id, tag, at) VALUES ('d1', 'pool:smoke', 0), ('d2', 'pool:smoke', 0)`)
      seedLegacyCluster(db, 'old', 'Old', ['pool:smoke'], [], 1000)
      seedLegacyCluster(db, 'mid', 'Mid', ['pool:smoke'], [], 2000)
      // d3 is explicit-only, no overlap.
      seedLegacyCluster(db, 'new', 'New', [], ['d3'], 3000)

      const log = createLogger('test')
      const report = materialiseMembership(db, { dataDir, log })
      expect(report).not.toBeNull()
      expect(report!.assigned).toBe(3)
      expect(report!.conflicts).toHaveLength(2)
      expect(new Set(report!.conflicts.map((c) => c.deviceId))).toEqual(new Set(['d1', 'd2']))
      for (const c of report!.conflicts) {
        expect(c.keptIn).toEqual({ id: 'old', name: 'Old' })
        expect(c.alsoMatched).toEqual({ id: 'mid', name: 'Mid' })
      }

      expect(readDeviceGroup(db, 'd1')).toBe('old')
      expect(readDeviceGroup(db, 'd2')).toBe('old')
      expect(readDeviceGroup(db, 'd3')).toBe('new')

      // The marker is set — a second call must be a pure no-op.
      const marker = db.select().from(migrationMarkers).all()
      expect(marker).toHaveLength(1)

      const files = readdirSync(join(dataDir, 'logs')).filter((f) => f.startsWith('cluster-migration-'))
      expect(files).toHaveLength(1)
      const written = JSON.parse(readFileSync(join(dataDir, 'logs', files[0]!), 'utf8')) as Materialise0014Report
      expect(written.assigned).toBe(3)
      expect(written.conflicts).toHaveLength(2)

      // Reassign one device by hand to prove idempotency really means "does
      // nothing", not just "returns the same numbers".
      db.run(sql`UPDATE devices SET cluster_id = NULL WHERE id = 'd3'`)
      const second = materialiseMembership(db, { dataDir, log })
      expect(second).toBeNull()
      expect(readDeviceGroup(db, 'd3')).toBeNull()
      const filesAfter = readdirSync(join(dataDir, 'logs')).filter((f) => f.startsWith('cluster-migration-'))
      expect(filesAfter).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test('an offline device is still materialised — membership, not runnability', () => {
    const db = setUp()
    const { dataDir, cleanup } = tempDataDir()
    try {
      seedDevice(db, 'd1', 'offline')
      seedLegacyCluster(db, 'c1', 'Group', [], ['d1'], 1000)

      const report = materialiseMembership(db, { dataDir, log: createLogger('test') })
      expect(report!.assigned).toBe(1)
      expect(readDeviceGroup(db, 'd1')).toBe('c1')
    } finally {
      cleanup()
    }
  })

  test('no groups at all: a clean no-op, no report file written', () => {
    const db = setUp()
    const { dataDir, cleanup } = tempDataDir()
    try {
      seedDevice(db, 'd1')
      const report = materialiseMembership(db, { dataDir, log: createLogger('test') })
      expect(report).toEqual({ ranAt: expect.any(String), assigned: 0, conflicts: [] })
      expect(readDeviceGroup(db, 'd1')).toBeNull()
    } finally {
      cleanup()
    }
  })
})

describe('runMigrationsUpTo + runMigrations (plan 22.0 §4.1)', () => {
  test('applying the rest afterward is exactly the remainder — nothing re-applied, nothing skipped', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, DROP_CLUSTER_SELECTOR_COLUMNS_TAG)
    // The pre-0014 selector column still exists at this point.
    expect(() => opened.db.run(sql`SELECT tags FROM clusters LIMIT 1`)).not.toThrow()

    runMigrations(opened.db)
    // Now dropped by the migration that was pending, and the table itself
    // renamed by plan 207's 0066_groups_rename.
    expect(() => opened.db.run(sql`SELECT tags FROM clusters LIMIT 1`)).toThrow()
    expect(() => opened.db.run(sql`SELECT * FROM groups LIMIT 1`)).not.toThrow()

    // Calling runMigrations again must not error (nothing left to re-apply).
    expect(() => runMigrations(opened.db)).not.toThrow()
  })
})
