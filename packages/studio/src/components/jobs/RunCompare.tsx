'use client'

import Link from 'next/link'
import { cn } from '@enkaku/ui'
import { useJobDetail } from '@/lib/use-job-detail'
import { jobHref } from './job-view'
import { JsonSnapshot } from './JsonSnapshot'
import { LogsTab } from './LogsTab'
import { diffJson } from './json-diff'

/**
 * Two runs side by side (MVP 14 §2: "Selecting two runs shows their results
 * side by side ... structured results (`resultSchema`, plan 97) get a
 * field-by-field diff, everything else a plain split view"). Renders in
 * place of the sub-tab body whenever `?compare=` names a second run.
 */
export function RunCompare({
  jobId,
  runId,
  compareRunId,
  view,
}: {
  jobId: string
  runId: string | null
  compareRunId: string
  view: string
}) {
  const a = useJobDetail(jobId, runId)
  const b = useJobDetail(jobId, compareRunId)

  if (view === 'timeline' || view === 'artifacts') {
    return (
      <div className="p-[14px]">
        <p className="text-meta text-faint">
          Two runs cannot be compared here. Pick Output or Logs, or{' '}
          <Link href={jobHref(jobId, { view, run: runId ?? undefined })} className="text-accent hover:underline">
            close the comparison
          </Link>
          .
        </p>
      </div>
    )
  }

  if (!a.run || !b.run) {
    return <p className="p-[14px] text-meta text-faint">Loading…</p>
  }

  if (view === 'inputs') {
    return (
      <div className="p-[14px]">
        <p className="pb-[10px] text-tip text-faint">Both runs share the job&apos;s parameters. A run with different parameters is a different job.</p>
        <div className="grid grid-cols-2 gap-[10px]">
          <JsonSnapshot title="Input snapshot" moment="captured at start" value={a.job?.params} />
          <JsonSnapshot title="Input snapshot" moment="captured at start" value={b.job?.params} />
        </div>
      </div>
    )
  }

  if (view === 'logs') {
    return (
      <div className="grid grid-cols-2 gap-[10px] p-[14px]">
        <LogsTab logs={a.logs} truncated={a.logsTruncated} phase={a.logsPhase} />
        <LogsTab logs={b.logs} truncated={b.logsTruncated} phase={b.logsPhase} />
      </div>
    )
  }

  // Output.
  if (a.run.resultSchema !== null || b.run.resultSchema !== null) {
    const rows = diffJson(a.run.result, b.run.result)
    const changed = rows.filter((r) => r.state !== 'same').length
    return (
      <div className="p-[14px]">
        <p className="pb-[10px] text-meta text-faint">
          run {a.run.seq} compared with run {b.run.seq} · {changed} of {rows.length} fields differ
        </p>
        <div className="overflow-hidden rounded-inner border border-line-2">
          {rows.map((row, i) => (
            <div
              key={row.path}
              className={cn(
                'grid grid-cols-[1fr_1fr_1fr] gap-3 px-3 py-[7px]',
                i < rows.length - 1 && 'border-b border-muted-2',
                row.state === 'changed' && 'bg-warn-soft',
                (row.state === 'only-left' || row.state === 'only-right') && 'bg-muted',
              )}
            >
              <span className="truncate font-mono text-meta text-text">{row.path}</span>
              <span className="truncate font-mono text-meta text-text-3">{row.left}</span>
              <span className="truncate font-mono text-meta text-text-3">{row.right}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-[10px] p-[14px]">
      <JsonSnapshot
        title="Output snapshot"
        moment="captured at exit"
        value={a.run.result}
        bytes={a.run.resultBytes}
        status={a.run.resultStatus}
        issues={a.run.resultIssues}
      />
      <JsonSnapshot
        title="Output snapshot"
        moment="captured at exit"
        value={b.run.result}
        bytes={b.run.resultBytes}
        status={b.run.resultStatus}
        issues={b.run.resultIssues}
      />
    </div>
  )
}
