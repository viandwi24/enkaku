'use client'

import { RESULT_LIMITS, type ArtifactInfo } from '@enkaku/protocol'
import { ResultView } from '@/components/result-view/ResultView'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { fileSize } from '@/lib/format'
import { formatResult, outcomeLine } from '@/lib/jobs'
import type { JobWithNode } from '@/lib/use-job-detail'
import { cn } from '@/lib/utils'
import { JobFailureDetail } from './JobFailureDetail'

/**
 * "What happened, and what the script reported" (plan 60 §3.3, §3.4) — the
 * two things the person who ran a job came here for, plus what it was run
 * with. Extracted from `app/jobs/detail/page.tsx`'s own Summary tab card
 * (2026-08-16, closing plan 103 step 103.11's audit row 4) — the SAME
 * `ResultView`/`planResult` resolver, the SAME `undeclared`/`valid`/
 * `invalid`/`partial`/`oversize` banners `docs/design.md`'s "Result views"
 * section documents, not a thinner re-derivation of them for the popup.
 *
 * Inputs render collapsed BELOW the result (audit finding 2, carried over):
 * the result is read first, the params only when it raises a question about
 * them.
 */
export function JobResultSection({
  job,
  finished,
  crashTraceArtifact,
}: {
  job: JobWithNode
  finished: boolean
  crashTraceArtifact: ArtifactInfo | undefined
}) {
  return (
    <div className="rounded-lg border bg-surface p-4">
      <h2 className="rack-label mb-3">outcome</h2>
      <p
        className={cn(
          'text-[13.5px]',
          job.status === 'success' && 'text-led-ok',
          job.status === 'failed' && 'text-led-danger',
          job.status === 'expired' && 'text-led-warn',
        )}
      >
        {outcomeLine(job)}
      </p>
      {job.status === 'failed' && job.error && (
        <div className="mt-3">
          <JobFailureDetail job={job} crashTraceArtifact={crashTraceArtifact} />
        </div>
      )}

      <div className="mt-4 border-t pt-3">
        <h3 className="rack-label mb-2">returned</h3>
        {!finished ? (
          <p className="text-[12.5px] text-fg-subtle">A script reports its result when it finishes.</p>
        ) : job.resultStatus === 'oversize' ? (
          <div className="rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
            <p className="rack-label text-led-warn">result too large to store</p>
            <p className="mt-1 text-[12.5px] leading-relaxed">
              This run returned {typeof job.resultBytes === 'number' ? fileSize(job.resultBytes) : 'more than the limit'}. The
              farm's limit for a stored result is {fileSize(RESULT_LIMITS.defaultMaxResultBytes)}, so nothing was kept. Save
              large output as an artifact with <span className="readout">ctx.artifact.file('report', data)</span> and return a
              small summary that points at it.
            </p>
          </div>
        ) : job.result === null || job.result === undefined ? (
          <p className="text-[12.5px] text-fg-subtle">
            This script returned nothing. A script that should report something — an exit IP, a version, whether an element
            was there — returns it from <span className="readout">run()</span>.
          </p>
        ) : job.resultSchema ? (
          <>
            {job.resultStatus === 'invalid' && (
              <div className="mb-2.5 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
                <p className="rack-label text-led-warn">result doesn't match its own schema</p>
                <p className="mt-1 text-[12.5px] leading-relaxed">
                  {job.resultIssues && job.resultIssues.length > 0
                    ? job.resultIssues.map((issue) => issue.path || '(the whole value)').join(', ')
                    : 'The returned value did not satisfy the schema this script declared.'}
                </p>
              </div>
            )}
            {job.resultStatus === 'partial' && (
              <div className="mb-2.5 rounded-lg border bg-surface p-3">
                <p className="text-[12.5px] text-fg-muted">this run failed — these are the values it had reached</p>
              </div>
            )}
            <ResultView schema={job.resultSchema as JsonSchemaNode} value={job.result} />
          </>
        ) : (
          <pre className="readout max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-bg p-2.5 text-[11.5px] leading-relaxed">
            {formatResult(job.result)}
          </pre>
        )}
      </div>

      <details className="mt-4 border-t pt-3">
        <summary className="rack-label cursor-pointer list-none select-none marker:content-none">
          started with{job.params === null || job.params === undefined ? ' — nothing' : ''}
        </summary>
        {job.params === null || job.params === undefined ? (
          <p className="mt-2 text-[12.5px] text-fg-subtle">This script declares no parameters, or it was run with its defaults.</p>
        ) : (
          <pre className="readout mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-bg p-2.5 text-[11.5px] leading-relaxed">
            {formatResult(job.params)}
          </pre>
        )}
      </details>
    </div>
  )
}
