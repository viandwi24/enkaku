import type { BatchInfo, JobInfo, JobStatus, ResultStatus } from '@enkaku/protocol'

/**
 * The batch report, computed from what `GET /api/batches/:id` already
 * returns (the batch plus every member `JobInfo`) — no second read, no new
 * route, no N+1 over the members.
 *
 * That constraint is the design, not a shortcut: a batch of forty members is
 * forty rows the screen already holds, and every number below is an
 * aggregation of those rows. The moment a figure needs per-RUN data (which
 * attempt failed, how long attempt 2 took) it belongs on the member's own
 * peek or on the job page, because that read is per member and a report must
 * never fan out into one request per device.
 *
 * Pure and side-effect free so the view can render it during a WS-driven
 * re-render without any effect of its own.
 */

/** One bucket of members that failed the same way. */
export interface FailureGroup {
  /** Stable identity: class, phase and the normalised message. */
  key: string
  /** The message verbatim from the first member in the bucket — real text, never the normalised form. */
  message: string
  failureClass: string | null
  errorPhase: string | null
  count: number
  deviceIds: string[]
}

export interface DurationStats {
  /** How many members contributed — a member that never started has no duration and is not counted. */
  count: number
  medianSec: number | null
  p95Sec: number | null
  minSec: number | null
  maxSec: number | null
}

export interface MemberTiming {
  jobId: string
  deviceId: string
  seconds: number
}

export interface BatchReport {
  total: number
  /** success + failed + cancelled + expired — the denominator of every rate below. */
  settled: number
  byStatus: Record<JobStatus, number>
  /** null until at least one member settles: 0 % and "nothing has finished yet" are different facts. */
  successRate: number | null
  /** Members that succeeded on their FIRST attempt (`runCount === 1`). */
  firstPass: number
  firstPassRate: number | null
  /** Every run every member has, reruns included (`sum(runCount)`). */
  attempts: number
  /** Members that ran more than once. */
  retried: number
  maxAttempts: number
  /** Attempts per member, ×1 for a batch nobody re-ran. */
  attemptsPerMember: number | null
  runtime: DurationStats
  /** `createdAt` → `startedAt`: how long members sat in the queue before a worker claimed them. */
  wait: DurationStats
  slowest: MemberTiming[]
  failures: FailureGroup[]
  resultStatus: Partial<Record<ResultStatus, number>>
  /** The highest RSS any member's runner measured, or null when nothing reported one. */
  peakRssBytes: number | null
  /** Batch `createdAt` → `finishedAt` (or now, while it runs). */
  wallSec: number
  /** Settled members per minute of wall clock — the number that answers "how long will the next forty take". */
  throughputPerMin: number | null
}

const SETTLED: readonly JobStatus[] = ['success', 'failed', 'cancelled', 'expired']

/**
 * Two failures are "the same failure" when they differ only in the numbers
 * inside them: `element not found after 8000ms` and `... after 12000ms` are
 * one bug on two devices, and a report that lists them apart is a report an
 * operator has to re-group by eye. Ids, hex and digits collapse; words do not.
 */
function normalise(message: string): string {
  return (message.split('\n')[0] ?? '')
    .trim()
    .slice(0, 200)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\d+/g, '#')
}

function stats(values: number[]): DurationStats {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    medianSec: percentile(sorted, 50),
    p95Sec: percentile(sorted, 95),
    minSec: sorted[0] ?? null,
    maxSec: sorted[sorted.length - 1] ?? null,
  }
}

/** Nearest-rank, on an already-sorted array. Null on an empty one — never 0. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? null
}

export function buildBatchReport(batch: BatchInfo, jobs: JobInfo[], nowMs: number): BatchReport {
  const byStatus: Record<JobStatus, number> = { queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, expired: 0 }
  const runtimes: number[] = []
  const waits: number[] = []
  const timings: MemberTiming[] = []
  const groups = new Map<string, FailureGroup>()
  const resultStatus: Partial<Record<ResultStatus, number>> = {}

  let attempts = 0
  let retried = 0
  let maxAttempts = 0
  let firstPass = 0
  let peakRssBytes: number | null = null

  for (const j of jobs) {
    byStatus[j.status] += 1
    attempts += j.runCount
    if (j.runCount > 1) retried += 1
    if (j.runCount > maxAttempts) maxAttempts = j.runCount
    if (j.status === 'success' && j.runCount <= 1) firstPass += 1
    if (j.peakRssBytes !== null) peakRssBytes = Math.max(peakRssBytes ?? 0, j.peakRssBytes)
    if (j.resultStatus) resultStatus[j.resultStatus] = (resultStatus[j.resultStatus] ?? 0) + 1

    if (j.startedAt !== null) {
      waits.push(Math.max(0, j.startedAt - j.createdAt))
      // A running member's duration is measured against the clock, so the
      // median of a batch in flight is a live number rather than a number
      // that only appears once everything has stopped.
      const end = j.finishedAt ?? Math.floor(nowMs / 1000)
      const seconds = Math.max(0, end - j.startedAt)
      if (j.finishedAt !== null) runtimes.push(seconds)
      timings.push({ jobId: j.jobId, deviceId: j.deviceId, seconds })
    }

    if (j.status === 'failed') {
      const message = j.error ?? 'no message was recorded'
      const key = `${j.failureClass ?? '-'}|${j.errorPhase ?? '-'}|${normalise(message)}`
      const existing = groups.get(key)
      if (existing) {
        existing.count += 1
        existing.deviceIds.push(j.deviceId)
      } else {
        groups.set(key, { key, message, failureClass: j.failureClass, errorPhase: j.errorPhase, count: 1, deviceIds: [j.deviceId] })
      }
    }
  }

  const total = jobs.length
  const settled = SETTLED.reduce((sum, s) => sum + byStatus[s], 0)
  const wallSec = Math.max(0, (batch.finishedAt ?? Math.floor(nowMs / 1000)) - batch.createdAt)

  return {
    total,
    settled,
    byStatus,
    successRate: settled === 0 ? null : byStatus.success / settled,
    firstPass,
    firstPassRate: settled === 0 ? null : firstPass / settled,
    attempts,
    retried,
    maxAttempts,
    attemptsPerMember: total === 0 ? null : attempts / total,
    runtime: stats(runtimes),
    wait: stats(waits),
    slowest: [...timings].sort((a, b) => b.seconds - a.seconds).slice(0, 3),
    failures: [...groups.values()].sort((a, b) => b.count - a.count),
    resultStatus,
    peakRssBytes,
    wallSec,
    throughputPerMin: wallSec < 5 || settled === 0 ? null : settled / (wallSec / 60),
  }
}

/** `12m 41s`, `41s`, `1h 04m` — seconds a report can print without arithmetic. */
export function secondsLabel(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/** `95%`, or `—` for a rate that has no denominator yet. Never rounds a non-zero rate down to `0%`. */
export function percentLabel(rate: number | null): string {
  if (rate === null) return '—'
  const pct = rate * 100
  if (pct > 0 && pct < 1) return '<1%'
  if (pct < 100 && pct > 99) return '>99%'
  return `${Math.round(pct)}%`
}

/**
 * The report as plain text, for the place most batch results actually end up:
 * a chat message to whoever asked for the run.
 *
 * Everything here is already on the screen — this exists so that reporting a
 * batch does not mean screenshotting it, and so the numbers a client is told
 * are the same numbers the farm computed rather than ones retyped by hand.
 */
export function summaryText(batch: BatchInfo, report: BatchReport): string {
  const lines = [
    `${batch.scriptName ?? batch.scriptId}${batch.scriptVersion ? ` @${batch.scriptVersion}` : ''} — ${report.total} device${report.total === 1 ? '' : 's'}`,
    `Success ${report.byStatus.success}/${report.settled} (${percentLabel(report.successRate)}) · first-pass ${report.firstPass} (${percentLabel(report.firstPassRate)})`,
    `Attempts ${report.attempts} run${report.attempts === 1 ? '' : 's'}${report.retried > 0 ? ` · ${report.retried} member${report.retried === 1 ? '' : 's'} re-run (max ×${report.maxAttempts})` : ''}`,
    `Runtime median ${secondsLabel(report.runtime.medianSec)} · p95 ${secondsLabel(report.runtime.p95Sec)} · wall ${secondsLabel(report.wallSec)}${report.throughputPerMin === null ? '' : ` · ${report.throughputPerMin.toFixed(1)}/min`}`,
    `Concurrency ${batch.concurrency === 0 ? 'unlimited' : batch.concurrency} · order ${batch.order}${batch.pacing ? ' · paced' : ''}`,
  ]
  if (report.failures.length > 0) {
    lines.push('Failures:')
    for (const g of report.failures) {
      lines.push(`  ×${g.count} ${g.message.split('\n')[0]}${g.errorPhase ? ` (during ${g.errorPhase})` : ''}`)
    }
  }
  if (batch.skipped.length > 0) lines.push(`Skipped: ${batch.skipped.length} device${batch.skipped.length === 1 ? '' : 's'} never got a job`)
  return lines.join('\n')
}
