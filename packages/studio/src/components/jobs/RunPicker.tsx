'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { JobRunInfo } from '@enkaku/protocol'
import { ArrowsLeftRightIcon, CaretDownIcon, cn, duration, relativeTime } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'
import { useNow } from '@/lib/useNow'
import { STATE_DOT, STATE_WORD, clockTime, jobHref } from './job-view'

/**
 * The run picker (MVP 15 §2, "The run picker on the Jobs detail (MVP 14)" —
 * one of the four things the design handoff leaves undesigned, and MVP 15 §1
 * row "Runs of one job" is its whole brief: "The detail header's meta line
 * gains a run picker ('run 3 of 3 ·') and Re-run adds a run. To be drawn into
 * the prototype.").
 *
 * So it is drawn as the FIRST SEGMENT of the meta line and nowhere else: a
 * job's runs are not a tab, not a sidebar and not a second list. The meta
 * line already reads "job_8f21c4 · dev-011 · schedule · 20:40 · running 3m
 * 08s"; this puts "run 3 of 3" in front of it, in the same 11.5px
 * `var(--faint)` as its neighbours, underlined on hover so it reads as the
 * one clickable segment.
 *
 * The popover lists every run NEWEST FIRST with three of the four facts MVP
 * 14 §2 names: "status, duration, trigger, and who or what started it".
 * `JobRunInfo` carries no per-run actor (plan 218 §4.8's own discrepancy
 * note: `jobs.createdBy` does not exist on the wire either, so the "who"
 * half cannot be shown at all here — a protocol gap, not a rendering one).
 * Selecting one sets `?run=`; the compare control beside it sets `?compare=`
 * and is what `RunCompare` (plan 218 §4.11) renders from.
 *
 * `data-menu-root` and `useOverlay('menu', ...)` are plan 213's shell
 * contract (§4.9): the outside-click listener and the Escape tier are
 * installed once by `AppShell`, and a screen registers rather than adding its
 * own `document` listener.
 */
export function RunPicker({
  jobId,
  runs,
  currentRunId,
  compareRunId,
}: {
  jobId: string
  runs: readonly JobRunInfo[]
  currentRunId: string | null
  compareRunId: string | null
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const now = useNow()
  useOverlay('menu', open, () => setOpen(false))

  const index = runs.findIndex((r) => r.runId === currentRunId)
  const shown = index >= 0 ? runs[index] : runs[0]
  // Runs arrive newest first (plan 211 §4.2.1), so `seq` is the human number
  // and `runs.length` is the total. A job whose older runs were swept
  // (MVP 14 §5) shows "run 4 of 1", which is the honest reading: this is run
  // four, and one run is still kept.
  const label = shown ? `run ${shown.seq} of ${runs.length}` : 'no runs'

  if (runs.length === 0) return <span className="flex-none">{label}</span>

  return (
    <span className="relative flex-none" data-menu-root="1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-[3px] text-meta text-faint hover:text-text hover:underline"
      >
        {label}
        <CaretDownIcon className="size-[11px]" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-[320px] overflow-hidden rounded-card border border-border-2 bg-panel p-1 shadow-popover"
        >
          {runs.map((r) => (
            <div key={r.runId} className="flex items-center gap-2 rounded-button px-[10px] py-[9px] hover:bg-muted">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  router.push(jobHref(jobId, { run: r.runId }))
                }}
                className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
              >
                <span className={cn('size-[7px] flex-none rounded-pill', STATE_DOT[r.status])} aria-hidden />
                <span className="flex-none font-mono text-meta text-text">run {r.seq}</span>
                <span className="min-w-0 flex-1 truncate text-label text-faint">
                  {STATE_WORD[r.status]} · {duration(r.startedAt, r.finishedAt, now)} · {r.trigger} · {clockTime(r.createdAt)}
                </span>
              </button>
              {/* MVP 14 §2: "Selecting two runs shows their results side by
                  side". The second run is a toggle on the row, not a second
                  list: comparing is a property of a pair, and a pair is one
                  chosen run plus the one already on screen. */}
              <button
                type="button"
                aria-label={compareRunId === r.runId ? `Stop comparing run ${r.seq}` : `Compare with run ${r.seq}`}
                disabled={r.runId === (currentRunId ?? runs[0]?.runId)}
                onClick={() => {
                  setOpen(false)
                  const q = new URLSearchParams({ job: jobId })
                  if (currentRunId) q.set('run', currentRunId)
                  if (compareRunId !== r.runId) q.set('compare', r.runId)
                  router.push(`/jobs?${q.toString()}`)
                }}
                className={cn(
                  'grid size-[26px] flex-none place-items-center rounded-small transition-colors disabled:opacity-30',
                  compareRunId === r.runId ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-muted-2 hover:text-text',
                )}
              >
                <ArrowsLeftRightIcon className="size-[13px]" />
              </button>
            </div>
          ))}
          <p className="px-[10px] py-2 text-tip text-faint">
            {/* MVP 14 §2 and §6 item 2, stated where the decision bites. */}
            Re-run adds a run to this job. Changing parameters creates a new job, because the intent changed.
          </p>
        </div>
      )}
    </span>
  )
}
