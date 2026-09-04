import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { changedRows } from '../db'
import type { Db } from '../db'
import { artifacts, deviceEvents, jobEvents } from '../db/schema'
import { createTraceFrameStore } from '../jobs/trace/frame-store'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { Logger } from '../util/logger'

export interface RetentionGc {
  start(): void
  stop(): void
  sweepOnce(): {
    deleted: number
    freedBytes: number
    eventsDeleted: number
    tracesDeleted: number
  }
}

/**
 * Retention artifact (spec §18): screenshot/log/video menumpuk cepat.
 * The policy: delete anything past its TTL, then — if the total is still over
 * quota — delete oldest-first (LRU by createdAt) until it fits.
 */
export function createRetentionGc(deps: {
  db: Db
  dataDir: string
  settings: FarmSettingsStore
  log: Logger
  intervalMinutes: number
  onSwept?: (result: { deleted: number; freedBytes: number }) => void
}): RetentionGc {
  let timer: ReturnType<typeof setInterval> | null = null
  // Only for `jobDir()` — the one authority on `<dataDir>/traces/<jobId>`, so
  // this sweep cannot drift from the layout the writer uses (plan 128 §3.5).
  const traceStore = createTraceFrameStore({ dataDir: deps.dataDir })

  function removeRows(ids: string[]): number {
    if (ids.length === 0) return 0
    const rows = deps.db.select().from(artifacts).where(inArray(artifacts.id, ids)).all()
    let freed = 0
    for (const row of rows) {
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        freed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact ${row.path}: ${String(err)}`)
      }
    }
    deps.db.delete(artifacts).where(inArray(artifacts.id, ids)).run()
    return freed
  }

  /**
   * Device event log GC (plan 18 §4.4): two age budgets (one per stream) then
   * a hard row ceiling per (device, stream), oldest rows first. Unlike the
   * artifact policy above, this is NOT gated by `policy.enabled` — an
   * unbounded input stream is a disk-filling bug, not an opt-in convenience
   * (plan 18 §3.3).
   */
  function sweepEvents(): number {
    const policy = deps.settings.get().retention
    let deleted = 0

    const mainCutoff = new Date(Date.now() - policy.eventMainDays * 86_400_000)
    const inputCutoff = new Date(Date.now() - policy.eventInputDays * 86_400_000)
    deleted += changedRows(
      deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'main'), lt(deviceEvents.at, mainCutoff))).run(),
    )
    deleted += changedRows(
      deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'input'), lt(deviceEvents.at, inputCutoff))).run(),
    )

    // Hard ceiling per (device, stream) — the age budget above is not always
    // enough on a very busy device.
    const counts = deps.db
      .select({
        deviceId: deviceEvents.deviceId,
        stream: deviceEvents.stream,
        cnt: sql<number>`count(*)`.as('cnt'),
      })
      .from(deviceEvents)
      .groupBy(deviceEvents.deviceId, deviceEvents.stream)
      .all()
    for (const row of counts) {
      const excess = row.cnt - policy.eventMaxRowsPerDevice
      if (excess <= 0) continue
      const oldestIds = deps.db
        .select({ id: deviceEvents.id })
        .from(deviceEvents)
        .where(and(eq(deviceEvents.deviceId, row.deviceId), eq(deviceEvents.stream, row.stream)))
        .orderBy(asc(deviceEvents.at))
        .limit(excess)
        .all()
        .map((r) => r.id)
      deleted += changedRows(deps.db.delete(deviceEvents).where(inArray(deviceEvents.id, oldestIds)).run())
    }

    if (deleted > 0) deps.log.info(`event retention: deleted ${deleted} device event row(s)`)
    return deleted
  }

  /**
   * Job trace GC (plan 128 §3.7, §5 step 128.7): a job's `job_events` rows and
   * its `traces/<jobId>` directory, both dropped once the trace is older than
   * `retention.traceDays` (default 30). Third in the row of ungated sweeps
   * above, for the same reason the two before it are ungated: `job_events` is
   * append-only and written once PER DEVICE CALL, with a screenshot beside
   * each row — the fastest-growing table in the schema. Letting an operator
   * forget to switch that on is how a disk fills, so this is a bound, not a
   * preference. The artifact policy below stays opt-in because throwing away
   * someone's screenshots is a product decision; expiring a month-old debug
   * trace is housekeeping.
   *
   * A trace's own LIFETIME rule (a trace lives exactly as long as its job's
   * history) is enforced by the delete cascade, not here — this is the second
   * lever, because nothing deletes finished jobs on its own.
   *
   * **Swept whole, per job, never per row.** The age of a trace is its LAST
   * event, so a job is either entirely gone or entirely intact. Deleting rows
   * by their own age would tear a long-running job's timeline in half at the
   * cutoff — the surviving half still pointing at frames in a directory this
   * sweep had just removed — which is strictly worse than keeping it a few
   * hours longer.
   *
   * `at_ms` is unix MILLISECONDS (plan 128 §3.3), NOT a seconds-backed Drizzle
   * timestamp like `deviceEvents.at` above it, so the cutoff here is a raw
   * `Date.now()`-based number and not a `Date`.
   */
  function sweepTraces(): number {
    const policy = deps.settings.get().retention
    // Milliseconds on both sides. Compare against `deviceEvents`' cutoff
    // above: same arithmetic, but that one is wrapped in a `Date` because its
    // column is seconds-backed, and this one must not be.
    const cutoffMs = Date.now() - policy.traceDays * 86_400_000
    const staleRunIds = deps.db
      .select({ runId: jobEvents.runId, lastAtMs: sql<number>`max(${jobEvents.atMs})`.as('last_at_ms') })
      .from(jobEvents)
      .groupBy(jobEvents.runId)
      .all()
      .filter((r) => r.lastAtMs < cutoffMs)
      .map((r) => r.runId)
    if (staleRunIds.length === 0) return 0

    for (const runId of staleRunIds) {
      try {
        rmSync(traceStore.runDir(runId), { recursive: true, force: true })
      } catch (err) {
        // Exactly `removeRows`' rule one function up: a file that will not go
        // away costs its own warning and nothing else. The rows still go, so a
        // sweep that cannot unlink degrades to leaked bytes on disk — never to
        // an aborted sweep that also leaves every LATER run's rows behind.
        deps.log.warn(`failed to delete trace directory for run ${runId}: ${String(err)}`)
      }
    }

    let rows = 0
    // `inArray` binds one parameter per id and SQLite has a ceiling on those.
    // The first sweep after an upgrade can face every run the farm has ever
    // done, so this is chunked where the deleted per-run sweep above is not.
    for (let i = 0; i < staleRunIds.length; i += 500) {
      rows += changedRows(
        deps.db.delete(jobEvents).where(inArray(jobEvents.runId, staleRunIds.slice(i, i + 500))).run(),
      )
    }

    deps.log.info(`trace retention: deleted ${staleRunIds.length} run trace(s) (${rows} event row(s))`)
    return staleRunIds.length
  }

  function sweepOnce(): {
    deleted: number
    freedBytes: number
    eventsDeleted: number
    tracesDeleted: number
  } {
    const eventsDeleted = sweepEvents()
    const tracesDeleted = sweepTraces()
    const policy = deps.settings.get().retention
    if (!policy.enabled) return { deleted: 0, freedBytes: 0, eventsDeleted, tracesDeleted }

    const rows = deps.db.select().from(artifacts).orderBy(asc(artifacts.createdAt)).all()
    const cutoff = Date.now() - policy.maxAgeDays * 86_400_000
    const expired = rows.filter((r) => (r.createdAt?.getTime() ?? 0) < cutoff).map((r) => r.id)
    let freed = removeRows(expired)
    let deleted = expired.length

    // Then: if the total is still over quota, drop the oldest first.
    const remaining = rows.filter((r) => !expired.includes(r.id))
    const quotaBytes = policy.maxTotalGb * 1024 ** 3
    let total = remaining.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)
    const overflow: string[] = []
    for (const row of remaining) {
      if (total <= quotaBytes) break
      overflow.push(row.id)
      total -= row.sizeBytes ?? 0
    }
    freed += removeRows(overflow)
    deleted += overflow.length

    if (deleted > 0) {
      deps.log.info(`retention GC: deleted ${deleted} artifact(s) (${(freed / 1024 ** 2).toFixed(1)} MB)`)
      deps.onSwept?.({ deleted, freedBytes: freed })
    }
    return { deleted, freedBytes: freed, eventsDeleted, tracesDeleted }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void sweepOnce(), deps.intervalMinutes * 60_000)
      sweepOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    sweepOnce,
  }
}
