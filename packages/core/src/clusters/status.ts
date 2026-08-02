import { eq } from 'drizzle-orm'
import type { BatchCounts, BatchStatusEvent, BatchStatusValue } from '@enkaku/protocol'
import type { Db } from '../db'
import { batches, type JobRow } from '../db/schema'
import type { JobStore } from '../queue/job-store'

/** Tally a batch's jobs by status (plan 20 §3.5; plan 21 §3.3 adds `expired`). */
export function countJobs(rows: JobRow[]): BatchCounts {
  const counts: BatchCounts = { total: rows.length, queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, expired: 0 }
  for (const r of rows) {
    const status = (r.status ?? 'queued') as keyof Omit<BatchCounts, 'total'>
    if (status in counts) counts[status] += 1
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
 *
 * Plan 21 §3.3: `expired` is a distinct job-level outcome from `failed` — the
 * Runs/report views show the count separately — but there is no separate
 * batch-level status for it, so it rolls into `failed` at the batch's single
 * word (a job that never got a device is still "did not complete work").
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

const TERMINAL: BatchStatusValue[] = ['success', 'failed', 'cancelled']

/**
 * Recompute a batch's cached status from its jobs — the only writer of
 * `batches.status` (plan 20 §3.5). Called from the one place a job reaches a
 * terminal state (`executor-host.ts`) and from the job-cancel path (plan 20
 * §4.5), so `finishedAt` is set exactly once and `batch.status` is always
 * broadcast with the live counts (the progress bar's "7/10 · 1 failed").
 */
export function recomputeBatchStatus(
  deps: { db: Db; jobStore: JobStore; broadcast: (msg: BatchStatusEvent) => void },
  batchId: string,
): BatchStatusEvent['payload'] | null {
  const rows = deps.jobStore.listByBatch(batchId)
  if (rows.length === 0) return null
  const counts = countJobs(rows)
  const status = computeBatchStatus(counts)
  const batch = deps.db.select().from(batches).where(eq(batches.id, batchId)).get()
  if (!batch) return null

  const patch: { status?: BatchStatusValue; finishedAt?: Date } = {}
  if (batch.status !== status) patch.status = status
  if (TERMINAL.includes(status) && !batch.finishedAt) patch.finishedAt = new Date()
  if (Object.keys(patch).length > 0) {
    deps.db.update(batches).set(patch).where(eq(batches.id, batchId)).run()
  }

  const payload = { batchId, status, counts }
  deps.broadcast({ type: 'batch.status', payload })
  return payload
}
