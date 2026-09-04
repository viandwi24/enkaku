import { eq, sql } from 'drizzle-orm'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../../util/logger'
import { loadDeviceTags } from '../../registry/device-tags'
import type { Db } from '../index'
import { devices, migrationMarkers } from '../schema'

/**
 * The generated migration that drops `clusters.tags` / `clusters.device_ids`
 * (plan 22.0 §4.1). `materialiseMembership` must run strictly after
 * `0013_numerous_kat_farrell` (which adds `devices.cluster_id`) and strictly
 * before this one — see `runMigrationsUpTo` in `db/index.ts`, which opens
 * that window, and `daemon.ts`, which sequences the three steps.
 *
 * Renamed from `cluster-materialise.ts` by plan 207 (MVP 15 §0.1): the table
 * this step addresses was called `clusters` before migration `0014`, and the
 * groups rename (plan 207 §4.6, migration `0066`) runs strictly AFTER this
 * step in the boot sequence — see the raw-SQL note on `materialiseMembership`
 * below for why every identifier in this file keeps its pre-`0014` spelling.
 */
export const DROP_MEMBERSHIP_SELECTOR_COLUMNS_TAG = '0014_long_human_fly'

const MARKER_ID = 'cluster-materialise-22.0'

interface RawClusterRow {
  id: string
  name: string
  tags: string | null
  device_ids: string | null
  created_at: number
}

export interface Materialise0014Conflict {
  deviceId: string
  /** The cluster the device was actually assigned to (oldest match wins, plan 22.0 §3.4). */
  keptIn: { id: string; name: string }
  /** A later cluster that also matched, but lost because the device was already taken. */
  alsoMatched: { id: string; name: string }
}

export interface Materialise0014Report {
  ranAt: string
  assigned: number
  conflicts: Materialise0014Conflict[]
}

/**
 * Plan 20's old resolution logic (tags AND semantics plus an explicit id
 * list), reimplemented here rather than reused: `resolveGroup`/
 * `resolveTarget` in `groups/resolve.ts` have already become a membership
 * lookup by the time this file exists, and this step's whole job is to
 * compute what THAT logic used to mean for a database created before this
 * migration. Every device that still exists is returned, regardless of its
 * current status — this is about membership, not runnability (an offline
 * device was still a member of its cluster before this migration ran).
 */
function resolveLegacyMembers(db: Db, tags: string[], deviceIds: string[]): string[] {
  const allDeviceIds = db.select({ id: devices.id }).from(devices).all().map((r) => r.id)
  const existing = new Set(allDeviceIds)

  let taggedIds: string[] = []
  if (tags.length > 0) {
    const tagMap = loadDeviceTags(db)
    taggedIds = allDeviceIds.filter((id) => tags.every((t) => (tagMap.get(id) ?? []).includes(t)))
  }

  const merged = [...new Set([...taggedIds, ...deviceIds])]
  return merged.filter((id) => existing.has(id))
}

/**
 * One-shot: collapse every existing cluster's resolved membership into
 * `devices.cluster_id`, oldest cluster first (plan 22.0 §3.4). A device that
 * matches more than one cluster keeps the oldest and every later match is
 * recorded as a conflict — logged at `warn` and written to
 * `<dataDir>/logs/cluster-migration-<timestamp>.json` — rather than silently
 * dropped. Guarded by a marker row so a second call (e.g. the next core
 * start) is a no-op (acceptance #8).
 *
 * Must run in the window opened by `runMigrationsUpTo(db,
 * DROP_MEMBERSHIP_SELECTOR_COLUMNS_TAG)`: `devices.cluster_id` must already
 * exist, and `clusters.tags` / `clusters.device_ids` must not have been
 * dropped yet. Both are read AND WRITTEN with raw SQL, addressing the table
 * and column exactly as they were named at this point in the migration
 * sequence — the current `clusters`/`devices` Drizzle schema objects
 * (`../schema`) reflect the FINAL shape (`groups`, `devices.group_id`, plan
 * 207's `0066_groups_rename`), which has not run yet when this step does:
 * `daemon.ts` calls `runMigrationsUpTo('0014_...')`, then this function,
 * and only afterward the full `runMigrations()` that reaches `0066`. Using
 * the live Drizzle object for the WRITE (as this file did before plan 207)
 * would emit `UPDATE devices SET group_id = ...` against a database that
 * still only has `cluster_id` — a runtime SQL error, not a silent no-op —
 * so both the read and the write are raw SQL here.
 */
export function materialiseMembership(db: Db, deps: { dataDir: string; log: Logger }): Materialise0014Report | null {
  const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
  if (marker) return null

  const rawClusters = db.all<RawClusterRow>(
    sql`SELECT id, name, tags, device_ids, created_at FROM clusters ORDER BY created_at ASC, id ASC`,
  )

  const assignedTo = new Map<string, { id: string; name: string }>()
  const conflicts: Materialise0014Conflict[] = []

  for (const row of rawClusters) {
    const tags = row.tags ? (JSON.parse(row.tags) as string[]) : []
    const deviceIds = row.device_ids ? (JSON.parse(row.device_ids) as string[]) : []
    const members = resolveLegacyMembers(db, tags, deviceIds)
    for (const deviceId of members) {
      const already = assignedTo.get(deviceId)
      if (already) {
        conflicts.push({ deviceId, keptIn: already, alsoMatched: { id: row.id, name: row.name } })
        continue
      }
      assignedTo.set(deviceId, { id: row.id, name: row.name })
    }
  }

  for (const [deviceId, cluster] of assignedTo) {
    db.run(sql`UPDATE devices SET cluster_id = ${cluster.id} WHERE id = ${deviceId}`)
  }

  const report: Materialise0014Report = {
    ranAt: new Date().toISOString(),
    assigned: assignedTo.size,
    conflicts,
  }

  for (const c of conflicts) {
    deps.log.warn(
      `cluster-materialise: device ${c.deviceId} matched both "${c.keptIn.name}" and "${c.alsoMatched.name}" — kept in "${c.keptIn.name}" (oldest wins)`,
    )
  }

  if (rawClusters.length > 0) {
    const logsDir = join(deps.dataDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const path = join(logsDir, `cluster-migration-${Date.now()}.json`)
    writeFileSync(path, JSON.stringify(report, null, 2))
    deps.log.info(
      `cluster-materialise: assigned ${report.assigned} device(s) across ${rawClusters.length} cluster(s); ${conflicts.length} conflict(s) — report at ${path}`,
    )
  }

  db.insert(migrationMarkers).values({ id: MARKER_ID, appliedAt: new Date() }).run()

  return report
}
