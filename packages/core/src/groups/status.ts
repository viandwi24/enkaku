import { eq } from 'drizzle-orm'
import type { BatchCounts, BatchStatusEvent, BatchStatusValue } from '@enkaku/protocol'
import type { Db } from '../db'
import { batches, type JobRunRow } from '../db/schema'
import type { JobStore } from '../queue/job-store'
import type { RunStore } from '../jobs/runs/store'
import type { BatchPacer } from './pacer'

/**
 * Tally a batch's jobs by their LATEST run's status (plan 20 §3.5; plan 21
 * §3.3 adds `expired`; plan 36 §4.4 splits `failed` into `failedScript` /
 * `failedInfra`; plan 211 §3.2 decision 3 re-keys the projection from jobs to
 * each job's latest run). `null` (a job with no run at all — swept, or never
 * given one) counts as `queued`, matching a job's own displayed status
 * convention.
 */
export function countJobs(latestRuns: (JobRunRow | null)[]): BatchCounts {
  const counts: BatchCounts = {
    total: latestRuns.length,
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    failedScript: 0,
    failedInfra: 0,
  }
  for (const run of latestRuns) {
    const status = (run?.status ?? 'queued') as keyof Omit<BatchCounts, 'total' | 'failedScript' | 'failedInfra'>
    if (status in counts) counts[status] += 1
    if (status === 'failed') {
      if (run?.failureClass === 'infra' || run?.failureClass === 'load') counts.failedInfra += 1
      else counts.failedScript += 1
    }
  }
  return counts
}

/**
 * Plan 20 §3.5 — derived, never stored twice:
 * - any job running → running
 * - all jobs terminal, none failed or expired → success
 * - all jobs terminal, at least one failed or expired → failed
 * - all jobs cancelled → cancelled (a special case of "all terminal")
 * - otherwise (still queued, none started yet) → queued
 */
export function computeBatchStatus(counts: BatchCounts): BatchStatusValue {
  if (counts.total === 0) return 'queued'
  if (counts.running > 0) return 'running'
  const terminal = counts.success + counts.failed + counts.cancelled + counts.expired
  if (terminal === counts.total) {
    if (counts.cancelled === counts.total) return 'cancelled'
    if (counts.failed > 0 || counts.expired > 0) return 'failed'
    return 'success'
  }
  return 'queued'
}

export const TERMINAL_BATCH_STATUSES: BatchStatusValue[] = ['success', 'failed', 'cancelled']
const TERMINAL = TERMINAL_BATCH_STATUSES

/**
 * Recompute a batch's cached status from its jobs' LATEST runs — the only
 * writer of `batches.status` (plan 20 §3.5, plan 211 §3.2 decision 3).
 * Called from the one place a run reaches a terminal state
 * (`executor-host.ts`) and from the job-cancel path (plan 20 §4.5).
 */
export function recomputeBatchStatus(
  deps: {
    db: Db
    jobStore: JobStore
    runs: RunStore
    broadcast: (msg: BatchStatusEvent) => void
    pacer?: BatchPacer
  },
  batchId: string,
  settledDeviceId?: string,
): BatchStatusEvent['payload'] | null {
  const memberJobs = deps.jobStore.listByBatch(batchId)
  const batch = deps.db.select().from(batches).where(eq(batches.id, batchId)).get()
  if (!batch) return null

  const latestRunsByJob = deps.runs.latestRuns(memberJobs.map((j) => j.id))
  const latestRuns = memberJobs.map((j) => latestRunsByJob.get(j.id) ?? null)

  if (memberJobs.length === 0) {
    if (TERMINAL.includes(batch.status as BatchStatusValue)) return null
    const finishedAt = batch.finishedAt ?? new Date()
    deps.db.update(batches).set({ status: 'cancelled', finishedAt }).where(eq(batches.id, batchId)).run()
    const payload = { batchId, status: 'cancelled' as BatchStatusValue, counts: countJobs(latestRuns) }
    deps.broadcast({ type: 'batch.status', payload })
    return payload
  }

  const counts = countJobs(latestRuns)
  const status = computeBatchStatus(counts)

  const stillStopping = batch.status === 'stopping' && !TERMINAL.includes(status)
  const patch: { status?: BatchStatusValue; finishedAt?: Date } = {}
  if (!stillStopping && batch.status !== status) patch.status = status
  if (TERMINAL.includes(status) && !batch.finishedAt) patch.finishedAt = new Date()
  if (Object.keys(patch).length > 0) {
    deps.db.update(batches).set(patch).where(eq(batches.id, batchId)).run()
  }

  if (settledDeviceId) deps.pacer?.onMemberSettled(batchId, settledDeviceId)

  const payload = { batchId, status: patch.status ?? (batch.status as BatchStatusValue), counts }
  deps.broadcast({ type: 'batch.status', payload })
  return payload
}
