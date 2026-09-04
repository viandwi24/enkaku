import type { BatchInfo, JobInfo, JobStatus } from '@enkaku/protocol'
import { duration, relativeTime } from '@enkaku/ui'

/**
 * The words, the colours and the addresses of the Jobs screen, in one pure
 * module so the sidebar, the header, the run picker and the compare view all
 * say the same thing (plan 218 §3.3, §4.1).
 */

/** The state dot and the state badge, from the prototype's own `jobColor`/`jobSoft`
 *  (`Enkaku Device List.dc.html:2040-2041`): running accent, queued faint, failed
 *  danger, everything settled ok. `cancelled` and `expired` are this plan's
 *  extension: the handoff draws four states and the wire has six. */
export const STATE_DOT: Record<JobStatus, string> = {
  running: 'bg-accent',
  queued: 'bg-faint',
  success: 'bg-ok',
  failed: 'bg-danger',
  cancelled: 'bg-warn',
  expired: 'bg-warn-2',
}

export const STATE_BADGE: Record<JobStatus, string> = {
  running: 'bg-accent-soft text-accent',
  queued: 'bg-muted-2 text-dim',
  success: 'bg-accent-soft text-accent',
  failed: 'bg-danger-soft text-danger',
  cancelled: 'bg-warn-soft text-warn',
  expired: 'bg-warn-soft text-warn',
}

/** The handoff capitalises its state words ("Running", "Queued"); the wire does not. */
export const STATE_WORD: Record<JobStatus, string> = {
  running: 'Running',
  queued: 'Queued',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/** A batch's status projected onto the five job states the chips filter by.
 *  `stopping` reads as Running: members are still being aborted. */
export function batchState(status: BatchInfo['status']): JobStatus {
  return status === 'stopping' ? 'running' : (status as JobStatus)
}

/**
 * The one address shape for a job (plan 218 §3.3). `/jobs/detail` no longer
 * exists; every link into a job goes through this.
 */
export function jobHref(jobId: string, opts?: { view?: string; run?: string }): string {
  const q = new URLSearchParams({ job: jobId })
  if (opts?.view) q.set('view', opts.view)
  if (opts?.run) q.set('run', opts.run)
  return `/jobs?${q.toString()}`
}

export function batchHref(batchId: string): string {
  return `/jobs?tab=batches&job=${encodeURIComponent(batchId)}`
}

/** `20:40` — the wall clock the handoff's meta line shows, from unix seconds. */
export function clockTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The four sub-line wordings the handoff names, in its own order
 * (`README.md:337-338`): "step 4 of 12 · 34%", "position 1 · est 4m",
 * "19:58 · 12m 41s", "element not found · 17:32". `queuePosition` is not on
 * the wire, so a queued run reads "queued 4m ago" instead of "position 1";
 * inventing a position would be inventing a number (plan 218 §9 Q3).
 */
export function jobSubLine(job: JobInfo, now: number): string {
  if (job.status === 'running' && job.kind === 'workflow' && job.stepSeq !== null) {
    return `step ${job.stepSeq + 1} · ${relativeTime(job.startedAt ?? job.createdAt, now)}`
  }
  if (job.status === 'running') return `running ${duration(job.startedAt, null, now)}`
  if (job.status === 'queued') return `queued ${relativeTime(job.createdAt, now)}`
  if (job.status === 'failed' && job.error) {
    return `${job.error.split('\n')[0]?.slice(0, 60) ?? 'failed'} · ${clockTime(job.finishedAt ?? job.createdAt)}`
  }
  return `${clockTime(job.finishedAt ?? job.createdAt)} · ${duration(job.startedAt, job.finishedAt, now)}`
}

/** The stripe the handoff paints behind every placeholder screen
 *  (`Enkaku Device List.dc.html:1524`). An inline style, not a Tailwind
 *  arbitrary value: it names two tokens, so it follows the theme, and it can
 *  never be mistaken for the v3 `bg-[--color-x]` bracket form that compiles to
 *  nothing under Tailwind v4 (`CLAUDE.md`). */
export const STRIPE = {
  background: 'repeating-linear-gradient(135deg, var(--muted) 0 6px, var(--muted-2) 6px 12px)',
} as const

/** `bytes` isn't always known (a value that never round-tripped through the
 *  wire's own `resultBytes`); this is the honest client-side measure of a
 *  JSON value's own printed size, in UTF-8 bytes, never an estimate. */
export function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length
  } catch {
    return 0
  }
}
