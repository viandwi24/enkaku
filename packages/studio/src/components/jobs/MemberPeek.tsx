'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { JobInfo } from '@enkaku/protocol'
import {
  ArrowSquareOutIcon,
  Button,
  ImagesIcon,
  ListDashesIcon,
  LoadingRows,
  MagnifyingGlassIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SignInIcon,
  SignOutIcon,
  cn,
  duration,
} from '@enkaku/ui'
import { useNow } from '@/lib/useNow'
import { useJobDetail } from '@/lib/use-job-detail'
import { STATE_BADGE, STATE_WORD, jobHref } from './job-view'
import { JsonSnapshot } from './JsonSnapshot'
import { LogsTab } from './LogsTab'
import { ArtifactsTab } from './ArtifactsTab'

/**
 * A member's inputs, output, logs and artifacts, in a popover on its own row
 * (owner, 2026-09-08).
 *
 * The batch's Members table already answers "which device failed"; the next
 * question — "with what, and what did it print" — used to cost a navigation
 * to the job page and a navigation back, once per device, on a screen whose
 * whole purpose is comparing twenty devices to each other. Four of the job
 * detail's five tabs need nothing but the job's own reads, so they are here,
 * side by side with the row they belong to.
 *
 * **What deliberately stays on the job page**: the timeline (and a workflow
 * job's step replay), the run comparison, the debug bundle export, Open
 * device. Those are the ones you open ONE of, deliberately, and each needs
 * room this popover does not have. The footer link says so rather than
 * leaving an operator to discover the gap.
 *
 * The body is a separate component because Radix unmounts a closed popover's
 * content: a members table of forty rows holds forty triggers and issues
 * exactly zero of their reads until one is opened.
 */

type PeekView = 'inputs' | 'output' | 'logs' | 'artifacts'

const VIEWS: readonly { key: PeekView; label: string; icon: ReactNode }[] = [
  { key: 'inputs', label: 'Inputs', icon: <SignInIcon className="size-[13px]" /> },
  { key: 'output', label: 'Output', icon: <SignOutIcon className="size-[13px]" /> },
  { key: 'logs', label: 'Logs', icon: <ListDashesIcon className="size-[13px]" /> },
  { key: 'artifacts', label: 'Artifacts', icon: <ImagesIcon className="size-[13px]" /> },
]

function PeekBody({ job, title }: { job: JobInfo; title: ReactNode }) {
  const [view, setView] = useState<PeekView>(job.status === 'failed' ? 'logs' : 'output')
  /** null means "the latest run", exactly as the job page's own `?run=` does. */
  const [runId, setRunId] = useState<string | null>(null)
  const now = useNow()
  const detail = useJobDetail(job.jobId, runId)
  const { job: full, runs, run, artifacts, logs, logsTruncated, logsPhase, error } = detail

  return (
    <div className="flex max-h-[min(70vh,540px)] min-h-0 flex-col">
      <header className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-[9px]">
        <span className="min-w-0 truncate text-row font-medium text-text">{title}</span>
        <span className={cn('flex-none rounded-small px-[7px] py-[2px] text-label font-semibold', STATE_BADGE[run?.status ?? job.status])}>
          {STATE_WORD[run?.status ?? job.status]}
        </span>
        <span className="flex-none text-meta text-faint tabular-nums">
          {duration(run?.startedAt ?? job.startedAt, run?.finishedAt ?? job.finishedAt, now)}
        </span>
        <Link
          href={jobHref(job.jobId, { run: runId ?? undefined })}
          className="ml-auto flex flex-none items-center gap-[5px] text-meta font-medium text-accent hover:underline"
        >
          Open details
          <ArrowSquareOutIcon className="size-[12px]" aria-hidden />
        </Link>
      </header>

      {/* Attempts. A member that was re-run three times has three stories, and
          the interesting one is usually not the last. */}
      {runs.length > 1 && (
        <div className="flex flex-none flex-wrap items-center gap-[4px] border-b border-line px-3 py-[7px]">
          <span className="mr-1 text-tip text-faint">{runs.length} attempts</span>
          {[...runs]
            .sort((a, b) => a.seq - b.seq)
            .map((x) => (
              <button
                key={x.runId}
                type="button"
                onClick={() => setRunId(x.runId)}
                title={`${STATE_WORD[x.status]} · ${x.trigger}`}
                className={cn(
                  'flex-none rounded-small px-[7px] py-[3px] text-label font-medium transition-colors',
                  x.runId === (run?.runId ?? '') ? STATE_BADGE[x.status] : 'bg-muted text-dim hover:text-text',
                )}
              >
                #{x.seq}
              </button>
            ))}
        </div>
      )}

      <div className="flex flex-none items-center gap-[3px] border-b border-line px-2 py-[6px]">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            aria-current={v.key === view ? 'true' : undefined}
            className={cn(
              'flex flex-none items-center gap-[6px] rounded-input px-[9px] py-[5px] text-body transition-colors',
              v.key === view ? 'bg-accent-soft font-semibold text-accent' : 'font-medium text-faint hover:text-text',
            )}
          >
            {v.icon}
            {v.label}
            {v.key === 'artifacts' && artifacts.length > 0 && <span className="text-tip opacity-70">{artifacts.length}</span>}
          </button>
        ))}
      </div>

      {run?.status === 'failed' && (
        <div className="flex-none border-b border-line bg-danger-soft px-3 py-[6px] text-meta text-danger">
          <span className="font-semibold">
            {run.errorPhase ? `Failed during ${run.errorPhase}` : 'Failed'}
            {run.failureClass ? ` · ${run.failureClass}` : ''}
          </span>{' '}
          <span className="font-mono">{run.error ?? 'no message was recorded'}</span>
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-[14px] text-body text-danger">{error}</p>
        ) : !full || !run ? (
          <div className="p-[14px]">
            <LoadingRows rows={4} />
          </div>
        ) : view === 'inputs' ? (
          <JsonSnapshot title="Input snapshot" moment="captured at start" value={full.params} />
        ) : view === 'output' ? (
          <JsonSnapshot
            title="Output snapshot"
            moment="captured at exit"
            value={run.result}
            bytes={run.resultBytes}
            status={run.resultStatus}
            issues={run.resultIssues}
          />
        ) : view === 'logs' ? (
          <LogsTab logs={logs} truncated={logsTruncated} phase={logsPhase} />
        ) : (
          <ArtifactsTab artifacts={artifacts} />
        )}
      </div>

      <footer className="flex-none border-t border-line px-3 py-[7px] text-tip text-faint">
        Timeline, run comparison and the debug bundle are on the job’s own page.
      </footer>
    </div>
  )
}

export function MemberPeek({ job, title }: { job: JobInfo; title: ReactNode }) {
  const [open, setOpen] = useState(false)
  const noRuns = job.runCount === 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={noRuns}
          title={noRuns ? 'This member has no run to show yet' : 'Peek at inputs, output, logs and artifacts'}
          aria-label="Peek at this member"
        >
          <MagnifyingGlassIcon className="size-3.5" aria-hidden />
          Peek
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="left" sideOffset={8} collisionPadding={12} className="w-[min(620px,calc(100vw-32px))] p-0">
        <PeekBody job={job} title={title} />
      </PopoverContent>
    </Popover>
  )
}
