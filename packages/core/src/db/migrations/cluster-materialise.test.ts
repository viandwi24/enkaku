import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations, runMigrationsUpTo, type Db } from '../index'
import { devices, migrationMarkers } from '../schema'
import { createLogger } from '../../util/logger'
import { DROP_CLUSTER_SELECTOR_COLUMNS_TAG, materialiseClusters, type ClusterMaterialiseReport } from './cluster-materialise'

/**
 * The exact window this step must run in (plan 22.0 §4.1): everything before
 * `DROP_CLUSTER_SELECTOR_COLUMNS_TAG` applied (so `devices.cluster_id`
 * exists), that migration itself still pending (so `clusters.tags` /
 * `device_ids` are still readable).
 */
function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrationsUpTo(opened.db, DROP_CLUSTER_SELECTOR_COLUMNS_TAG)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'offline' = 'idle'): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status })
    .run()
}

/** The pre-22.0 clusters shape (tags/device_ids), inserted with raw SQL since the current Drizzle schema no longer declares those columns. */
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

function tempDataDir(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-cluster-materialise-'))
  return { dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

describe('materialiseClusters (plan 22.0 §3.4, §7)', () => {
  test('three overlapping clusters: oldest wins, every conflict is named, a second run changes nothing', () => {
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
      const report = materialiseClusters(db, { dataDir, log })
      expect(report).not.toBeNull()
      expect(report!.assigned).toBe(3)
      expect(report!.conflicts).toHaveLength(2)
      expect(new Set(report!.conflicts.map((c) => c.deviceId))).toEqual(new Set(['d1', 'd2']))
      for (const c of report!.conflicts) {
        expect(c.keptIn).toEqual({ id: 'old', name: 'Old' })
        expect(c.alsoMatched).toEqual({ id: 'mid', name: 'Mid' })
      }

      const d1 = db.select().from(devices).where(eq(devices.id, 'd1')).get()
      const d2 = db.select().from(devices).where(eq(devices.id, 'd2')).get()
      const d3 = db.select().from(devices).where(eq(devices.id, 'd3')).get()
      expect(d1?.clusterId).toBe('old')
      expect(d2?.clusterId).toBe('old')
      expect(d3?.clusterId).toBe('new')

      // The marker is set — a second call must be a pure no-op.
      const marker = db.select().from(migrationMarkers).all()
      expect(marker).toHaveLength(1)

      const files = readdirSync(join(dataDir, 'logs')).filter((f) => f.startsWith('cluster-migration-'))
      expect(files).toHaveLength(1)
      const written = JSON.parse(readFileSync(join(dataDir, 'logs', files[0]!), 'utf8')) as ClusterMaterialiseReport
      expect(written.assigned).toBe(3)
      expect(written.conflicts).toHaveLength(2)

      // Reassign one device by hand to prove idempotency really means "does
      // nothing", not just "returns the same numbers".
      db.update(devices).set({ clusterId: null }).where(eq(devices.id, 'd3')).run()
      const second = materialiseClusters(db, { dataDir, log })
      expect(second).toBeNull()
      const d3After = db.select().from(devices).where(eq(devices.id, 'd3')).get()
      expect(d3After?.clusterId).toBeNull()
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
      seedLegacyCluster(db, 'c1', 'Cluster', [], ['d1'], 1000)

      const report = materialiseClusters(db, { dataDir, log: createLogger('test') })
      expect(report!.assigned).toBe(1)
      const d1 = db.select().from(devices).where(eq(devices.id, 'd1')).get()
      expect(d1?.clusterId).toBe('c1')
    } finally {
      cleanup()
    }
  })

  test('no clusters at all: a clean no-op, no report file written', () => {
    const db = setUp()
    const { dataDir, cleanup } = tempDataDir()
    try {
      seedDevice(db, 'd1')
      const report = materialiseClusters(db, { dataDir, log: createLogger('test') })
      expect(report).toEqual({ ranAt: expect.any(String), assigned: 0, conflicts: [] })
      const d1 = db.select().from(devices).where(eq(devices.id, 'd1')).get()
      expect(d1?.clusterId).toBeNull()
    } finally {
      cleanup()
    }
  })
})

describe('runMigrationsUpTo + runMigrations (plan 22.0 §4.1)', () => {
  test('applying the rest afterward is exactly the remainder — nothing re-applied, nothing skipped', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, DROP_CLUSTER_SELECTOR_COLUMNS_TAG)
    // clusters.tags still exists at this point.
    expect(() => opened.db.run(sql`SELECT tags FROM clusters LIMIT 1`)).not.toThrow()

    runMigrations(opened.db)
    // Now dropped by the migration that was pending.
    expect(() => opened.db.run(sql`SELECT tags FROM clusters LIMIT 1`)).toThrow()

    // Calling runMigrations again must not error (nothing left to re-apply).
    expect(() => runMigrations(opened.db)).not.toThrow()
  })
})
