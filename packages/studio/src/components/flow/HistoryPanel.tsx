'use client'

import { useEffect, useState } from 'react'
import type { WorkflowRunSummary } from '@enkaku/protocol'
import { Badge, Spinner, cn, relativeTime } from '@enkaku/ui'
import { fetchWorkflowRuns } from '@/lib/api'

/**
 * A workflow's own run history, beside its canvas (the n8n Executions
 * panel).
 *
 * The point is not a second list of jobs — the Jobs screen already has one.
 * It is that an author standing in the editor asks a different question:
 * "what has THIS pipeline done, and can I see it on the graph I am looking
 * at". So selecting a row does not navigate anywhere; it replays that run
 * over the canvas already on screen, with the edges it took lit and each
 * node carrying its own outcome (owner, 2026-09-05).
 *
 * Every row states its device, because a workflow run without a device is
 * half a fact — and the step counts, because a run that SUCCEEDED with three
 * failed steps (every failing node wired to a recovery edge) is a real,
 * ordinary state that one status word cannot express.
 */
export function HistoryPanel({
  workflowName,
  selectedRunId,
  onSelect,
}: {
  workflowName: string
  selectedRunId: string | null
  onSelect(run: { jobId: string; runId: string } | null): void
}) {
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null)

  useEffect(() => {
    let disposed = false
    const load = () =>
      void fetchWorkflowRuns(workflowName, 40).then((p) => {
        if (!disposed) setRuns(p.items)
      })
    load()
    // A running workflow's step count climbs while the panel is open; five
    // seconds is the same cadence the Jobs counters already poll at.
    const timer = setInterval(load, 5000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [workflowName])

  if (runs === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-4 text-dim" />
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="p-[14px] text-body text-dim">
        <p className="text-text">No runs yet.</p>
        <p className="mt-1">Run this workflow on a device, or press Simulate to walk it with no device attached. Every run lands here and replays on the canvas.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex-none border-b border-line px-[12px] py-[8px] text-label text-faint">
        {runs.length} run{runs.length === 1 ? '' : 's'} · newest first
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((r) => {
          const selected = r.runId === selectedRunId
          const running = r.status === 'running' || r.status === 'queued'
          return (
            <li key={r.runId}>
              <button
                type="button"
                onClick={() => onSelect(selected ? null : { jobId: r.jobId, runId: r.runId })}
                className={cn(
                  'flex w-full flex-col gap-[3px] border-b border-line px-[12px] py-[9px] text-left transition-colors',
                  selected ? 'bg-accent-soft' : 'hover:bg-hover',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn('font-mono text-meta', selected ? 'text-accent' : 'text-faint')}>#{r.seq}</span>
                  <StatusChip status={r.status} />
                  {/* The count that a status word cannot carry. Silent when
                      nothing failed — a clean run should not have to say so. */}
                  {r.failedSteps > 0 && (
                    <span className="text-meta text-warn">
                      {r.failedSteps}/{r.steps} step{r.steps === 1 ? '' : 's'} failed
                    </span>
                  )}
                  {running && <Spinner className="size-3 text-dim" />}
                  <span className="ml-auto text-meta text-faint">{relativeTime(r.startedAt ?? r.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2 text-meta text-dim">
                  <span className="truncate">{r.deviceLabel ?? 'no device'}</span>
                  <span className="text-faint">·</span>
                  <span>{r.steps} step{r.steps === 1 ? '' : 's'}</span>
                  <span className="text-faint">·</span>
                  <span>{r.trigger}</span>
                </div>
                {r.error && <p className="truncate text-meta text-danger">{r.error}</p>}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  if (status === 'success') return <Badge variant="outline" className="border-ok/40 text-ok">success</Badge>
  if (status === 'failed') return <Badge variant="outline" className="border-danger/40 text-danger">failed</Badge>
  if (status === 'cancelled') return <Badge variant="outline" className="border-line-2 text-faint">cancelled</Badge>
  return <Badge variant="outline" className="border-accent/40 text-accent">{status}</Badge>
}
