'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BatchesPageResponseSchema, JobsPageResponseSchema, type BatchInfo, type JobInfo } from '@enkaku/protocol'
import { CaretLeftIcon, CaretRightIcon, api, cn } from '@enkaku/ui'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'
import { JOB_FILTERS, type JobCounts, type JobFilter } from '@/lib/use-job-counts'
import { STATE_DOT, batchHref, batchState, jobHref, jobSubLine } from './job-view'
import type { JobsTab } from './JobsTabStrip'

/**
 * The 268px left column (design handoff, "Screen: Jobs", "Left list"):
 * `width: 268px`, `border-right: 1px solid var(--line)`; wrapping filter
 * chips at `padding: 5px 10px`, `border-radius: 8px`, active
 * `var(--accent-soft)`; rows of a state dot plus a `Geist Mono` 12px name
 * with the sub-line indented 14px beneath; a footer of "1-12 of 63" and
 * 26x26 prev/next, twelve rows per page, resetting to page 1 when the tab or
 * the filter changes.
 *
 * `flex-wrap` on the chip row is not decoration: the handoff says
 * "**wrapping** (never a clipped scroll row)", because five chips with counts
 * do not fit 268px minus padding and a horizontal scroller hides the last
 * two behind a gesture nobody discovers.
 *
 * The window never reflows under the reader (plan 218 §3.4): a `job.status`
 * or `batch.status` push MERGES into a loaded row and never prepends, and a
 * refetch happens only while `page === 0`, which is where a new row belongs
 * and where a reader watching for one is looking.
 */
const PER_PAGE = 12

type Row = { id: string; name: string; state: ReturnType<typeof batchState>; sub: string; href: string }

export function JobsSidebar({
  tab,
  selectedId,
  counts,
}: {
  tab: JobsTab
  selectedId: string | null
  counts: JobCounts
}) {
  const [filter, setFilter] = useState<JobFilter>('all')
  const [page, setPage] = useState(0)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [batches, setBatches] = useState<BatchInfo[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [hasNext, setHasNext] = useState(false)
  const cursors = useRef<Array<string | null>>([null])
  const now = useNow()

  // The handoff: "changing tab or filter resets to page 1".
  useEffect(() => {
    cursors.current = [null]
    setPage(0)
  }, [tab, filter])

  useEffect(() => {
    let disposed = false
    const cursor = cursors.current[page] ?? null
    const q = new URLSearchParams({ limit: String(PER_PAGE) })
    if (filter !== 'all') q.set('status', filter)
    if (cursor) q.set('cursor', cursor)
    void (async () => {
      try {
        if (tab === 'jobs') {
          const p = await api(`/api/jobs?${q.toString()}`, JobsPageResponseSchema)
          if (disposed) return
          cursors.current[page + 1] = p.nextCursor
          setJobs(p.items)
          setTotal(p.total)
          setHasNext(p.nextCursor !== null)
        } else {
          const p = await api(`/api/batches?${q.toString()}`, BatchesPageResponseSchema)
          if (disposed) return
          cursors.current[page + 1] = p.nextCursor
          setBatches(p.items)
          setTotal(p.total)
          setHasNext(p.nextCursor !== null)
        }
      } catch {
        if (!disposed) {
          setJobs([])
          setBatches([])
          setTotal(null)
          setHasNext(false)
        }
      }
    })()
    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filter, page, counts.jobs, counts.batches])

  // Merge in place only. `counts` above is the page-0 refetch trigger: the
  // coalescer that moves the tab and chip numbers is the same signal that a
  // row entered or left the list, so the window follows it without a second
  // timer of its own.
  useEffect(() => {
    const off = ws.on((m) => {
      if (m.type === 'job.status') {
        setJobs((p) => (p.some((j) => j.jobId === m.payload.jobId) ? p.map((j) => (j.jobId === m.payload.jobId ? { ...j, ...m.payload } : j)) : p))
      } else if (m.type === 'batch.status') {
        setBatches((p) =>
          p.map((b) => (b.id === m.payload.batchId ? { ...b, status: m.payload.status, counts: m.payload.counts } : b)),
        )
      }
    })
    return off
  }, [])

  const rows: Row[] = useMemo(() => {
    if (tab === 'jobs') {
      return jobs.map((j) => ({
        id: j.jobId,
        // `scriptName` for a script job, `scriptName` denormalised from the
        // workflow name for a workflow job (plan 211 §4.1.2), the id as the
        // last resort for a job whose script row is gone.
        name: j.scriptName ?? j.jobId.slice(0, 12),
        state: j.status,
        sub: jobSubLine(j, now),
        href: jobHref(j.jobId),
      }))
    }
    return batches.map((b) => {
      const done = b.counts.success + b.counts.failed + b.counts.cancelled
      return {
        id: b.id,
        name: b.scriptName ?? b.id.slice(0, 12),
        state: batchState(b.status),
        sub: `${b.counts.total} device${b.counts.total === 1 ? '' : 's'} · ${done}/${b.counts.total}${b.counts.failed > 0 ? ` · ${b.counts.failed} failed` : ''}`,
        href: batchHref(b.id),
      }
    })
  }, [tab, jobs, batches, now])

  const first = page * PER_PAGE + 1
  const last = page * PER_PAGE + rows.length
  const pageNote = rows.length === 0 ? 'none' : `${first}–${last} of ${total ?? last}`

  return (
    <div className="flex min-h-0 w-[268px] flex-none flex-col border-r border-line">
      <div className="flex flex-none flex-wrap gap-1 p-[10px]">
        {JOB_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'flex-none rounded-small px-[10px] py-[5px] text-meta transition-colors',
              f === filter ? 'bg-accent-soft font-semibold text-accent' : 'bg-muted font-medium text-dim hover:text-text',
            )}
          >
            {f === 'all' ? 'All' : f[0]?.toUpperCase() + f.slice(1)}
            {counts.byFilter[f] !== null && <span className="ml-[6px] opacity-65">{counts.byFilter[f]}</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-[10px]">
        {rows.map((r) => (
          <Link
            key={r.id}
            href={r.href}
            className={cn(
              'flex items-center gap-[10px] rounded-button px-2 py-[9px] transition-colors',
              r.id === selectedId ? 'bg-accent-soft' : 'hover:bg-muted',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-[7px]">
                <span className={cn('size-[7px] flex-none rounded-pill', STATE_DOT[r.state])} aria-hidden />
                <span className="truncate font-mono text-[12px]">{r.name}</span>
              </div>
              <div className="mt-1 truncate pl-[14px] text-label text-faint">{r.sub}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="flex flex-none items-center gap-[6px] border-t border-line px-[10px] py-2">
        <span className="min-w-0 flex-1 truncate text-label text-faint">{pageNote}</span>
        <button
          type="button"
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="grid size-[26px] flex-none place-items-center rounded-small border border-border-2 bg-panel-2 text-text-3 disabled:cursor-default disabled:text-faint-2"
        >
          <CaretLeftIcon className="size-[13px]" />
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={!hasNext}
          onClick={() => setPage((p) => p + 1)}
          className="grid size-[26px] flex-none place-items-center rounded-small border border-border-2 bg-panel-2 text-text-3 disabled:cursor-default disabled:text-faint-2"
        >
          <CaretRightIcon className="size-[13px]" />
        </button>
      </div>
    </div>
  )
}
