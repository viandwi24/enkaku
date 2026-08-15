import { useEffect, useRef, useState } from 'react'
import { BatchWithJobsResponseSchema, type BatchInfo, type BatchStatusValue, type JobInfo } from '@enkaku/protocol'
import { api } from '@/lib/actions'
import { ws } from '@/lib/ws'
import type { OutcomeCounts } from './OutcomeSummary'
import type { NamedOutcome } from './SkippedGroups'

/**
 * Plan 93 §3.11, §3.15, §4.8, F15, H3, step 93.11 — the report a bulk batch
 * dialog (`InstallBatchDialog`, `BulkTransferDialog`) shows without
 * navigating away (F15's "InstallBatchDialog posts one batch and navigates
 * away, showing no result at all"). Live-updated the SAME way
 * `app/batches/detail/page.tsx` already updates (`ws.on('batch.status' |
 * 'job.status', ...)`, farm-wide broadcast, no subscribe message needed —
 * `batches/detail/page.tsx`'s own existing effect is the precedent this
 * hook follows rather than inventing a second wiring), so a dialog left
 * open sees the same live counts the batch's own detail page would.
 */
export interface BatchReport {
  batch: BatchInfo | null
  jobs: JobInfo[]
  /** True once the batch reaches a terminal status (or the fetch/subscribe never started). */
  done: boolean
}

const EMPTY: BatchReport = { batch: null, jobs: [], done: false }

/** Mirrors `clusters/status.ts`'s own `TERMINAL_BATCH_STATUSES` (a core-only export this package cannot import). */
const TERMINAL: BatchStatusValue[] = ['success', 'failed', 'cancelled']
function isTerminal(status: BatchStatusValue): boolean {
  return TERMINAL.includes(status)
}

export function useBatchReport(batchId: string | null): BatchReport {
  const [report, setReport] = useState<BatchReport>(EMPTY)
  const batchIdRef = useRef<string | null>(null)

  useEffect(() => {
    batchIdRef.current = batchId
    if (!batchId) {
      setReport(EMPTY)
      return
    }
    setReport({ batch: null, jobs: [], done: false })
    void api(`/api/batches/${batchId}`, BatchWithJobsResponseSchema)
      .then((b) =>
        setReport({
          batch: b.batch,
          jobs: b.jobs,
          done: isTerminal(b.batch.status),
        }),
      )
      .catch(() => undefined)

    const off = ws.on((m) => {
      if (batchIdRef.current !== batchId) return
      if (m.type === 'batch.status' && m.payload.batchId === batchId) {
        setReport((prev) => {
          if (!prev.batch) return prev
          const batch = { ...prev.batch, status: m.payload.status, counts: m.payload.counts }
          return { ...prev, batch, done: isTerminal(batch.status) }
        })
      } else if (m.type === 'job.status' && m.payload.batchId === batchId) {
        setReport((prev) => ({
          ...prev,
          jobs: prev.jobs.some((j) => j.jobId === m.payload.jobId)
            ? prev.jobs.map((j) => (j.jobId === m.payload.jobId ? { ...j, ...m.payload } : j))
            : prev.jobs,
        }))
      }
    })
    return off
  }, [batchId])

  return report
}

/** `OutcomeSummary`'s counts, derived from a batch's own `counts` plus its skipped devices (never in `counts.total` — they got no job row at all, F11). */
export function batchOutcomeCounts(batch: BatchInfo): OutcomeCounts {
  return {
    ok: batch.counts.success,
    failed: batch.counts.failed,
    skipped: batch.skipped.length,
    total: batch.counts.total + batch.skipped.length,
  }
}

/** `SkippedGroups`' two named lists, derived from the batch's jobs (failed, with the job's own error as the reason) and its skipped devices (with the dispatch-time reason). */
export function batchOutcomeGroups(
  batch: BatchInfo,
  jobs: JobInfo[],
  deviceLabel: (id: string) => string,
): { failed: NamedOutcome[]; skipped: NamedOutcome[] } {
  return {
    failed: jobs
      .filter((j) => j.status === 'failed')
      .map((j) => ({ deviceId: j.deviceId, label: deviceLabel(j.deviceId), reason: j.error ?? 'failed' })),
    skipped: batch.skipped.map((s) => ({ deviceId: s.deviceId, label: deviceLabel(s.deviceId), reason: s.reason })),
  }
}
