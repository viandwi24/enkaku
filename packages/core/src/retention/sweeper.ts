import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { changedRows } from '../db'
import type { Db } from '../db'
import { AUDIT_RETENTION_DAYS, EVENT_MAX_ROWS_PER_DEVICE, INPUT_EVENT_RETENTION_DAYS } from '../config/constants'
import { artifacts, auditLog, deviceEvents, jobEvents, jobRuns, jobs } from '../db/schema'
import { createTraceFrameStore } from '../jobs/trace/frame-store'
import { latestWorkflowRunIds, type CreateRunRetentionSweeper, type RunRetentionPolicy } from '../jobs/runs/sweeper'
import type { RunStore } from '../jobs/runs/store'
import { recomputeStorageUsage } from './storage-usage'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { Logger } from '../util/logger'

/** Rows per `deleteRuns` transaction — plan 211's own `chunk` field, sized like `purge.ts`'s `BATCH_SIZE`. */
const RUN_SWEEP_CHUNK = 500

/** How often the storage-usage cache is recomputed, independent of the deletion cadence. */
const USAGE_RECOMPUTE_MS = 24 * 60 * 60 * 1000

export interface RetentionSweepResult {
  runsDeleted: number
  jobsDeleted: number
  artifactsDeleted: number
  artifactBytesFreed: number
  eventsDeleted: number
  tracesDeleted: number
  auditDeleted: number
}

export interface RetentionSweeper {
  start(): void
  stop(): void
  /** One pass: run/job sweep, trace sweep, artifact sweep, event sweep, audit sweep — in that order. */
  sweepOnce(): RetentionSweepResult
  /**
   * The same computation `sweepOnce()` would perform, without deleting or
   * writing anything — an operator (or a test) can ask "what would this
   * remove" before it happens.
   */
  dryRun(): RetentionSweepResult
}

/**
 * The retention sweeper (MVP 09 §6, MVP 14 §5, plan 211 §4.9's interface).
 * Replaces `packages/core/src/maintenance/retention.ts` in full — one module
 * owns every deletion the farm performs on a schedule, so the audit trail,
 * the sweep cadence and the storage-usage cache cannot drift apart.
 *
 * Ungated sweeps (device events, job/run history, trace frames, audit) never
 * had, and never gain, an `enabled` switch: an unbounded append-only stream
 * is a disk-filling bug, not an opt-in convenience. The artifact sweep lost
 * its own `enabled` flag in plan 212: retention is always on.
 */
export function createRetentionSweeper(deps: {
  db: Db
  dataDir: string
  settings: FarmSettingsStore
  runs: RunStore
  createRunRetentionSweeper: CreateRunRetentionSweeper
  log: Logger
  intervalMinutes: number
  onSwept?: (result: RetentionSweepResult) => void
}): RetentionSweeper {
  let timer: ReturnType<typeof setInterval> | null = null
  let usageTimer: ReturnType<typeof setInterval> | null = null
  const traceStore = createTraceFrameStore({ dataDir: deps.dataDir })
  const traceDirRoot = join(deps.dataDir, 'traces')

  function runPolicy(): RunRetentionPolicy {
    return { runDays: deps.settings.get().storage.historyDays, keepLatest: true, chunk: RUN_SWEEP_CHUNK }
  }

  /** Candidate run ids: terminal, older than the cutoff, not their job's latest run, and — for a workflow job — not the single most recent run of that WORKFLOW across every job it ever had (plan 304 §4.4, G8). Same predicate `jobs/runs/sweeper.ts` applies internally — read-only here, used for the cascade (traces/events/artifacts) and for the dry run. */
  function candidateRunIds(policy: RunRetentionPolicy): string[] {
    const cutoffSec = Math.floor((Date.now() - policy.runDays * 86_400_000) / 1000)
    const exemptWorkflowRuns = latestWorkflowRunIds(deps.db)
    return deps.db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
      .where(
        and(
          inArray(jobRuns.status, ['success', 'failed', 'cancelled', 'expired']),
          or(isNull(jobs.latestRunId), ne(jobs.latestRunId, jobRuns.id)),
          sql`coalesce(${jobRuns.finishedAt}, ${jobRuns.createdAt}) < ${cutoffSec}`,
        ),
      )
      .all()
      .map((r) => r.id)
      .filter((id) => !exemptWorkflowRuns.has(id))
  }

  /** Every job with zero runs that no schedule or parent workflow job owns — whether it never ran at all, or was reduced to zero by this sweep. */
  function orphanJobIds(): string[] {
    return deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.runCount, 0), isNull(jobs.scheduleId), isNull(jobs.parentWorkflowJobId)))
      .all()
      .map((r) => r.id)
  }

  function cascadeDeleteRuns(runIds: string[]): { events: number; traceDirs: number; artifactsDeleted: number; bytesFreed: number } {
    if (runIds.length === 0) return { events: 0, traceDirs: 0, artifactsDeleted: 0, bytesFreed: 0 }
    let traceDirs = 0
    for (const runId of runIds) {
      const dir = traceStore.runDir(runId)
      if (!existsSync(dir)) continue
      try {
        rmSync(dir, { recursive: true, force: true })
        traceDirs += 1
      } catch (err) {
        deps.log.warn(`failed to remove trace directory for run ${runId}: ${String(err)}`)
      }
    }
    const events = changedRows(deps.db.delete(jobEvents).where(inArray(jobEvents.runId, runIds)).run())
    const artifactRows = deps.db.select().from(artifacts).where(inArray(artifacts.runId, runIds)).all()
    let bytesFreed = 0
    for (const row of artifactRows) {
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        bytesFreed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact file ${row.path}: ${String(err)}`)
      }
    }
    const artifactsDeleted = changedRows(deps.db.delete(artifacts).where(inArray(artifacts.runId, runIds)).run())
    return { events, traceDirs, artifactsDeleted, bytesFreed }
  }

  /** The run/job sweep — plan 211's interface, chunked so a first sweep after upgrade cannot hold the write lock. */
  function sweepRunsAndJobs(): { runs: number; jobs: number; events: number; traceDirs: number; artifactsDeleted: number; bytesFreed: number } {
    const policy = runPolicy()
    const ids = candidateRunIds(policy)
    let runsTotal = 0
    let jobsTotal = 0
    let events = 0
    let traceDirs = 0
    let artifactsDeleted = 0
    let bytesFreed = 0
    for (let i = 0; i < ids.length; i += policy.chunk) {
      const batch = ids.slice(i, i + policy.chunk)
      const cascade = cascadeDeleteRuns(batch)
      events += cascade.events
      traceDirs += cascade.traceDirs
      artifactsDeleted += cascade.artifactsDeleted
      bytesFreed += cascade.bytesFreed
      const sweeper = deps.createRunRetentionSweeper({ db: deps.db, runs: deps.runs, policy })
      // `sweepOnce()` here re-derives its own candidate set from `policy` and
      // deletes exactly `batch` plus recomputes latest_run_id/run_count —
      // constructed fresh per chunk because the interface takes a plain
      // policy object, not a live getter; cheap, stateless, no behaviour
      // differs from calling it once outside the loop.
      const outcome = sweeper.sweepOnce()
      runsTotal += outcome.runs
      jobsTotal += outcome.jobs
    }
    // A job with zero runs from the moment it was created (never run at all)
    // never appears in `deleteRuns`' own `jobsTouched` list, so it needs its
    // own pass: any orphan job with run_count = 0, no schedule, no parent
    // workflow job — the same predicate `RunRetentionSweeper.sweepOnce`'s own
    // doc comment names, applied once more so a never-run job is caught too.
    const orphans = orphanJobIds()
    if (orphans.length > 0) {
      deps.db.delete(jobs).where(inArray(jobs.id, orphans)).run()
      jobsTotal += orphans.length
    }
    if (runsTotal > 0 || jobsTotal > 0) {
      deps.log.info(`run/job retention: deleted ${runsTotal} run(s), ${jobsTotal} orphan job(s)`)
    }
    return { runs: runsTotal, jobs: jobsTotal, events, traceDirs, artifactsDeleted, bytesFreed }
  }

  /** Device event log GC (plan 18 §3.3/§4.4), reading the renamed field. */
  function sweepDeviceEvents(): number {
    const mainDays = deps.settings.get().storage.historyDays
    let deleted = 0
    const mainCutoff = new Date(Date.now() - mainDays * 86_400_000)
    const inputCutoff = new Date(Date.now() - INPUT_EVENT_RETENTION_DAYS * 86_400_000)
    deleted += changedRows(deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'main'), lt(deviceEvents.at, mainCutoff))).run())
    deleted += changedRows(deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'input'), lt(deviceEvents.at, inputCutoff))).run())
    const counts = deps.db
      .select({ deviceId: deviceEvents.deviceId, stream: deviceEvents.stream, cnt: sql<number>`count(*)`.as('cnt') })
      .from(deviceEvents)
      .groupBy(deviceEvents.deviceId, deviceEvents.stream)
      .all()
    for (const row of counts) {
      const excess = row.cnt - EVENT_MAX_ROWS_PER_DEVICE
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
    return deleted
  }

  /** Age- then quota-based artifact sweep — no longer gated by `enabled` (plan 212). */
  function sweepArtifactQuota(): { deleted: number; bytesFreed: number } {
    const policy = deps.settings.get().storage.artifacts
    const rows = deps.db.select().from(artifacts).orderBy(asc(artifacts.createdAt)).all()
    const cutoff = Date.now() - policy.maxAgeDays * 86_400_000
    const expired = rows.filter((r) => (r.createdAt?.getTime() ?? 0) < cutoff)
    let bytesFreed = 0
    for (const row of expired) {
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        bytesFreed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact ${row.path}: ${String(err)}`)
      }
    }
    let deleted = expired.length
    if (expired.length > 0) deps.db.delete(artifacts).where(inArray(artifacts.id, expired.map((r) => r.id))).run()

    const remaining = rows.filter((r) => !expired.includes(r))
    const quotaBytes = policy.maxTotalGb * 1024 ** 3
    let total = remaining.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)
    const overflow: string[] = []
    for (const row of remaining) {
      if (total <= quotaBytes) break
      overflow.push(row.id)
      total -= row.sizeBytes ?? 0
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        bytesFreed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact ${row.path}: ${String(err)}`)
      }
    }
    if (overflow.length > 0) deps.db.delete(artifacts).where(inArray(artifacts.id, overflow)).run()
    deleted += overflow.length
    return { deleted, bytesFreed }
  }

  /** Audit log GC (MVP 09 §6: 90 days) — new; nothing swept this table before this plan. */
  function sweepAudit(): number {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000)
    return changedRows(deps.db.delete(auditLog).where(lt(auditLog.at, cutoff)).run())
  }

  function sweepOnce(): RetentionSweepResult {
    const ranj = sweepRunsAndJobs()
    const eventsDeleted = sweepDeviceEvents() // device-event age/ceiling sweep; independent of the run sweep's own job_events deletion above
    const artifactQuota = sweepArtifactQuota()
    const auditDeleted = sweepAudit()
    const result: RetentionSweepResult = {
      runsDeleted: ranj.runs,
      jobsDeleted: ranj.jobs,
      artifactsDeleted: ranj.artifactsDeleted + artifactQuota.deleted,
      artifactBytesFreed: ranj.bytesFreed + artifactQuota.bytesFreed,
      eventsDeleted: ranj.events + eventsDeleted,
      tracesDeleted: ranj.traceDirs,
      auditDeleted,
    }
    const any = Object.values(result).some((n) => n > 0)
    if (any) deps.log.info(`retention sweep: ${JSON.stringify(result)}`)
    deps.onSwept?.(result)
    return result
  }

  /** How many of `jobIds`' runs are in `runIds` — used by `dryRun` to simulate the post-delete run_count without touching anything. */
  function countRunIdsPerJob(runIds: string[]): Map<string, number> {
    if (runIds.length === 0) return new Map()
    const rows = deps.db.select({ jobId: jobRuns.jobId }).from(jobRuns).where(inArray(jobRuns.id, runIds)).all()
    const out = new Map<string, number>()
    for (const r of rows) out.set(r.jobId, (out.get(r.jobId) ?? 0) + 1)
    return out
  }

  function dryRun(): RetentionSweepResult {
    // Read-only mirror of sweepOnce's SELECTs, computing counts without a
    // single DELETE or rmSync call.
    const policy = runPolicy()
    const runIds = candidateRunIds(policy)
    const perJobDeleted = countRunIdsPerJob(runIds)
    const wouldBeOrphaned = [...perJobDeleted.entries()].filter(([jobId, deletedCount]) => {
      const row = deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get()
      return row && row.runCount - deletedCount <= 0 && row.scheduleId === null && row.parentWorkflowJobId === null
    }).map(([jobId]) => jobId)
    const alreadyOrphaned = orphanJobIds()
    const jobsDeleted = new Set([...alreadyOrphaned, ...wouldBeOrphaned]).size

    const traceDirsN = runIds.filter((id) => existsSync(traceStore.runDir(id))).length
    const eventsN = runIds.length === 0 ? 0 : (deps.db.select({ n: sql<number>`count(*)` }).from(jobEvents).where(inArray(jobEvents.runId, runIds)).get()?.n ?? 0)
    const cascadeArtifacts =
      runIds.length === 0
        ? { count: 0, bytes: 0 }
        : (() => {
            const rows = deps.db.select().from(artifacts).where(inArray(artifacts.runId, runIds)).all()
            return { count: rows.length, bytes: rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0) }
          })()

    const artifactQuota = (() => {
      const p = deps.settings.get().storage.artifacts
      const rows = deps.db.select().from(artifacts).orderBy(asc(artifacts.createdAt)).all()
      const cutoff = Date.now() - p.maxAgeDays * 86_400_000
      const expired = rows.filter((r) => (r.createdAt?.getTime() ?? 0) < cutoff)
      const remaining = rows.filter((r) => !expired.includes(r))
      const quotaBytes = p.maxTotalGb * 1024 ** 3
      let total = remaining.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)
      let overflowCount = 0
      let overflowBytes = 0
      for (const row of remaining) {
        if (total <= quotaBytes) break
        overflowCount += 1
        overflowBytes += row.sizeBytes ?? 0
        total -= row.sizeBytes ?? 0
      }
      return { count: expired.length + overflowCount, bytes: expired.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0) + overflowBytes }
    })()

    const mainDays = deps.settings.get().storage.historyDays
    const mainCutoff = new Date(Date.now() - mainDays * 86_400_000)
    const inputCutoff = new Date(Date.now() - INPUT_EVENT_RETENTION_DAYS * 86_400_000)
    const mainN = deps.db.select({ n: sql<number>`count(*)` }).from(deviceEvents).where(and(eq(deviceEvents.stream, 'main'), lt(deviceEvents.at, mainCutoff))).get()?.n ?? 0
    const inputN = deps.db.select({ n: sql<number>`count(*)` }).from(deviceEvents).where(and(eq(deviceEvents.stream, 'input'), lt(deviceEvents.at, inputCutoff))).get()?.n ?? 0

    const auditCutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000)
    const auditN = deps.db.select({ n: sql<number>`count(*)` }).from(auditLog).where(lt(auditLog.at, auditCutoff)).get()?.n ?? 0

    return {
      runsDeleted: runIds.length,
      jobsDeleted,
      artifactsDeleted: cascadeArtifacts.count + artifactQuota.count,
      artifactBytesFreed: cascadeArtifacts.bytes + artifactQuota.bytes,
      eventsDeleted: eventsN + mainN + inputN,
      tracesDeleted: traceDirsN,
      auditDeleted: auditN,
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void sweepOnce(), deps.intervalMinutes * 60_000)
      sweepOnce()
      // Usage computation is decoupled from the deletion cadence: a full
      // trace-tree walk on every hourly sweep would cost real boot-path
      // latency on a mature farm, for a number nothing reads more than once
      // a day. Deferred one tick so it never blocks the synchronous boot
      // sequence the line above is part of.
      queueMicrotask(() => recomputeStorageUsage({ db: deps.db, log: deps.log }, traceDirRoot))
      usageTimer = setInterval(() => recomputeStorageUsage({ db: deps.db, log: deps.log }, traceDirRoot), USAGE_RECOMPUTE_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
      if (usageTimer) clearInterval(usageTimer)
      timer = null
      usageTimer = null
    },
    sweepOnce,
    dryRun,
  }
}
