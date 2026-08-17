'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ArtifactInfo } from '@enkaku/protocol'
import { coreBase } from '@/lib/ws'
import type { JobWithNode } from '@/lib/use-job-detail'
import { cn } from '@enkaku/ui'

/**
 * Why a job failed, with the failing line shown rather than described (plan
 * 60 §3.4) — extracted from `app/jobs/detail/page.tsx`'s own `failureDetail`
 * (2026-08-16, part of closing plan 103 step 103.11's audit row 4). Renders
 * `null` for anything that is not `job.status === 'failed' && job.error`, so
 * a caller can render it unconditionally rather than re-deriving the guard.
 * Owns its own crash-trace disclosure state (`traceOpen`/`traceText`) —
 * self-contained, so it drops into the device popup's Jobs tab exactly as it
 * drops into the page, with no extra props for the caller to wire.
 */
export function JobFailureDetail({ job, crashTraceArtifact }: { job: JobWithNode; crashTraceArtifact: ArtifactInfo | undefined }) {
  const [traceOpen, setTraceOpen] = useState(false)
  const [traceText, setTraceText] = useState<string | null>(null)

  useEffect(() => {
    if (!traceOpen || !crashTraceArtifact || traceText !== null) return
    void fetch(`${coreBase()}/api/artifacts/${crashTraceArtifact.id}/content`)
      .then((r) => (r.ok ? r.text() : 'Could not load the trace.'))
      .then(setTraceText)
      .catch(() => setTraceText('Could not load the trace.'))
  }, [traceOpen, crashTraceArtifact, traceText])

  if (job.status !== 'failed' || !job.error) return null

  return (
    <div className="rounded-lg border border-led-danger/40 bg-led-danger/5 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="rack-label text-led-danger">failure reason{job.errorPhase ? ` — during ${job.errorPhase}` : ''}</p>
        {/* Plan 36 §4.4 — infra vs script vs load, so "this suite is flaky" becomes an answerable question. */}
        {job.failureClass && (
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              job.failureClass === 'infra' && 'border-led-warn/40 bg-led-warn/10 text-led-warn',
              job.failureClass === 'load' && 'border-line bg-transparent text-fg-muted',
              job.failureClass === 'script' && 'border-led-danger/40 bg-led-danger/10 text-led-danger',
            )}
          >
            {job.failureClass}
          </span>
        )}
      </div>
      <p className="mt-1 break-words text-[13px]">{job.error}</p>
      {crashTraceArtifact && (
        <div className="mt-2.5 border-t border-led-danger/20 pt-2.5">
          <button
            type="button"
            onClick={() => setTraceOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-led-danger hover:underline"
          >
            {traceOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
            {traceOpen ? 'Hide crash trace' : 'Show crash trace'}
          </button>
          {traceOpen && (
            <pre className="readout mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-led-danger/20 bg-surface p-2.5 text-[11px] leading-relaxed">
              {traceText ?? 'Loading…'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
