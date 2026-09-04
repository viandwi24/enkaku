import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Db } from '../db'
import { artifacts, auditLog, deviceEvents, jobEvents, jobRuns, storageUsage } from '../db/schema'
import type { Logger } from '../util/logger'

export type StorageUsageKind = 'jobsAndLogs' | 'traceFrames' | 'artifacts' | 'audit'

/** Per-row byte overhead assumed for kinds with no stored size column (jobsAndLogs, audit) — an estimate, not an exact accounting; documented on the API response too (§4.3 of plan 224). */
const ROW_OVERHEAD_BYTES = 96

function dirBytes(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      const st = statSync(full)
      total += st.isDirectory() ? dirBytes(full) : st.size
    } catch {
      // A file removed between readdir and stat (a concurrent sweep) is
      // simply not counted this pass; the next pass picks up the true state.
    }
  }
  return total
}

/**
 * Walks `<dataDir>/traces/` ONCE and recomputes every kind's usage row.
 * Called once at boot (deferred a tick) and once every 24h thereafter
 * (`createRetentionSweeper`'s own timer) — never on the `GET
 * /api/storage/usage` request path, which only ever reads the table this
 * function writes.
 */
export function recomputeStorageUsage(deps: { db: Db; log?: Logger }, traceDirRoot: string): void {
  const now = new Date()
  const artifactAgg = deps.db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${artifacts.sizeBytes}), 0)` }).from(artifacts).get()
  const jobRunsN = deps.db.select({ n: sql<number>`count(*)` }).from(jobRuns).get()
  const jobEventsAgg = deps.db.select({ n: sql<number>`count(*)`, len: sql<number>`coalesce(sum(length(${jobEvents.meta})), 0)` }).from(jobEvents).get()
  const deviceEventsAgg = deps.db.select({ n: sql<number>`count(*)`, len: sql<number>`coalesce(sum(length(${deviceEvents.meta})), 0)` }).from(deviceEvents).get()
  const auditAgg = deps.db
    .select({ n: sql<number>`count(*)`, len: sql<number>`coalesce(sum(length(${auditLog.meta}) + length(coalesce(${auditLog.target}, '')) + length(${auditLog.action})), 0)` })
    .from(auditLog)
    .get()

  const jobsAndLogsRows = (jobRunsN?.n ?? 0) + (jobEventsAgg?.n ?? 0) + (deviceEventsAgg?.n ?? 0)
  const jobsAndLogsBytes = jobsAndLogsRows * ROW_OVERHEAD_BYTES + (jobEventsAgg?.len ?? 0) + (deviceEventsAgg?.len ?? 0)
  const traceBytes = dirBytes(traceDirRoot)
  const auditBytes = (auditAgg?.n ?? 0) * ROW_OVERHEAD_BYTES + (auditAgg?.len ?? 0)

  const rows: Array<{ kind: StorageUsageKind; bytes: number; rows: number }> = [
    { kind: 'jobsAndLogs', bytes: jobsAndLogsBytes, rows: jobsAndLogsRows },
    { kind: 'traceFrames', bytes: traceBytes, rows: 0 }, // file count is not tracked; bytes is the number that matters on disk
    { kind: 'artifacts', bytes: artifactAgg?.bytes ?? 0, rows: artifactAgg?.n ?? 0 },
    { kind: 'audit', bytes: auditBytes, rows: auditAgg?.n ?? 0 },
  ]
  for (const row of rows) {
    deps.db
      .insert(storageUsage)
      .values({ kind: row.kind, bytes: row.bytes, rows: row.rows, computedAt: now })
      .onConflictDoUpdate({ target: storageUsage.kind, set: { bytes: row.bytes, rows: row.rows, computedAt: now } })
      .run()
  }
  deps.log?.info(`storage usage recomputed: ${rows.map((r) => `${r.kind}=${(r.bytes / 1024 ** 2).toFixed(1)}MB`).join(', ')}`)
}
