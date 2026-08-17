import { eq } from 'drizzle-orm'
import type { BatchCounts, BatchStatusEvent, BatchStatusValue } from '@enkaku/protocol'
import type { Db } from '../db'
import { batches, type JobRow } from '../db/schema'
import type { JobStore } from '../queue/job-store'
import type { BatchPacer } from './pacer'

/**
 * Tally a batch's jobs by status (plan 20 §3.5; plan 21 §3.3 adds `expired`;
 * plan 36 §4.4 splits `failed` into `failedScript` / `failedInfra` from
 * `jobs.failureClass` — a `load`-classified failure counts as infra here too,
 * since it is still a farm-caused failure from the batch's point of view).
 */
export function countJobs(rows: JobRow[]): BatchCounts {
  const counts: BatchCounts = {
    total: rows.length,
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    failedScript: 0,
    failedInfra: 0,
  }
  for (const r of rows) {
    const status = (r.status ?? 'queued') as keyof Omit<BatchCounts, 'total' | 'failedScript' | 'failedInfra'>
    if (status in counts) counts[status] += 1
    if (status === 'failed') {
      if (r.failureClass === 'infra' || r.failureClass === 'load') counts.failedInfra += 1
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

/**
 * Exported so `api/batches.ts`'s `rowToBatchInfo` can apply the SAME
 * "stopping is held until every member is terminal" rule this file's own
 * `recomputeBatchStatus` uses (plan 94 §3.9, step 94.8) — one definition of
 * "terminal", never two that could drift.
 */
export const TERMINAL_BATCH_STATUSES: BatchStatusValue[] = ['success', 'failed', 'cancelled']
const TERMINAL = TERMINAL_BATCH_STATUSES

/**
 * Recompute a batch's cached status from its jobs — the only writer of
 * `batches.status` (plan 20 §3.5). Called from the one place a job reaches a
 * terminal state (`executor-host.ts`) and from the job-cancel path (plan 20
 * §4.5), so `finishedAt` is set exactly once and `batch.status` is always
 * broadcast with the live counts (the progress bar's "7/10 · 1 failed").
 */
export function recomputeBatchStatus(
  deps: {
    db: Db
    jobStore: JobStore
    broadcast: (msg: BatchStatusEvent) => void
    /**
     * Plan 94 §3.8, §4.8, step 94.7 — optional, same fallback shape every
     * other accessor in this codebase has: unwired (every pre-94.7 caller),
     * a settled member never plans a further repetition, which is correct —
     * there IS no pacing without a pacer.
     */
    pacer?: BatchPacer
  },
  batchId: string,
  /**
   * Plan 94 §3.8, §4.8, step 94.7 — the device whose job just reached a
   * terminal state, if that is why this recompute is happening. This is
   * the ONE hook into the pacer (F32): a bulk queued-cancel (`POST
   * /:id/cancel`, a schedule's `cancel-previous`) recomputes status too but
   * passes no device — nothing there is "a repetition settling", so no
   * further repetition is planned from it.
   */
  settledDeviceId?: string,
): BatchStatusEvent['payload'] | null {
  const rows = deps.jobStore.listByBatch(batchId)
  const batch = deps.db.select().from(batches).where(eq(batches.id, batchId)).get()
  if (!batch) return null

  if (rows.length === 0) {
    // `clusters/dispatch.ts`'s `createBatch` is the ONLY writer of a
    // `batches` row, and it always inserts it together with >= 1 job row in
    // the SAME transaction (`E_NO_TARGETS` refuses before anything is
    // persisted when no device matches). So reaching this branch — an
    // EXISTING row whose own jobs list comes back empty — can only mean
    // every one of its job rows was deleted after the fact; the one path
    // found is `device/lifecycle.ts`'s `forget({ deleteHistory: true })`,
    // which deletes `jobs` rows by `deviceId` but never touches `batches`.
    // It is never "not dispatched yet" — that shape cannot outlive
    // `createBatch`'s own transaction.
    //
    // This is reachable in production, not just in theory: `stopBatch`
    // (`api/batches.ts`) calls this function unconditionally as its own
    // step 4 ("recompute the batch status once, at the end", plan 94 §3.9),
    // including when the batch's only device was already forgotten before
    // the operator hit Stop. Before this branch existed, the pre-existing
    // early `return null` here made that call a silent no-op — the row
    // stayed `stopping` forever, which is the owner's own stuck tray entry
    // (this pass's bug report). A batch with no jobs left has none to wait
    // on, so it resolves straight to `cancelled` — terminal — regardless of
    // what it was heading toward (`stopping`, a stale `queued`/`running`
    // nothing will ever settle again). Skipped once the row is ALREADY
    // terminal, so a batch that finished normally long before its history
    // was deleted is never re-broadcast or have its `finishedAt` disturbed.
    if (TERMINAL.includes(batch.status as BatchStatusValue)) return null
    const finishedAt = batch.finishedAt ?? new Date()
    deps.db.update(batches).set({ status: 'cancelled', finishedAt }).where(eq(batches.id, batchId)).run()
    const payload = { batchId, status: 'cancelled' as BatchStatusValue, counts: countJobs(rows) }
    deps.broadcast({ type: 'batch.status', payload })
    return payload
  }

  const counts = countJobs(rows)
  const status = computeBatchStatus(counts)

  // `stopping` (plan 94 §3.9, step 94.8) is a state written directly by the
  // stop endpoint, never derived from job counts — `computeBatchStatus`
  // never produces it, so this recompute must never clobber it back to
  // `running`/`queued` while members are still settling underneath it. Once
  // every member IS terminal, the batch is allowed to move on to whatever
  // `computeBatchStatus` derives (`success` | `failed` | `cancelled`), the
  // same as any other batch — that is what actually ends the `stopping`
  // state; nothing else writes `batches.status` away from it.
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
