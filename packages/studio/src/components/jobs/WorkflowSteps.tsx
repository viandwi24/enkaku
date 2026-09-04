'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { WorkflowDoc, WorkflowStepInfo } from '@enkaku/protocol'
import { WorkflowResumeResponseSchema } from '@enkaku/protocol'
import { api, cn, duration } from '@enkaku/ui'
import { toast } from 'sonner'
import { useNow } from '@/lib/useNow'
import { RunOverlay } from '@/components/flow/RunOverlay'
import { RunScrubber } from '@/components/flow/RunScrubber'
import { DataView } from '@/components/flow/DataView'
import { STATE_BADGE, jobHref } from './job-view'
import { JsonSnapshot } from './JsonSnapshot'

/**
 * The Timeline sub-tab of a WORKFLOW job (plan 218 §3.7, extended by plan
 * 307 §3.2, §4.1, §4.3). "A workflow job runs no device actions itself. The
 * replay of each step is on that step's own job." MVP 05 §1.2, §1.5 — still
 * true for a `script` step's OWN job link below; the canvas above answers
 * a different question (which BRANCH ran, plan 300 P11) that the list never
 * could.
 *
 * `doc` is the job's OWN snapshot (`jobs.workflow_doc`, plan 307 §3.2) — the
 * document this run actually took, not the workflow's current one, which
 * may have been edited since. `null` only for a pre-existing job whose
 * snapshot failed to parse even after the v1→v2 upgrade (`workflow_corrupt`
 * territory) — the canvas is skipped and the list below still works.
 */
const STEP_BADGE: Record<WorkflowStepInfo['status'], string> = {
  running: STATE_BADGE.running,
  success: STATE_BADGE.success,
  failed: STATE_BADGE.failed,
  skipped: 'bg-muted-2 text-dim',
  'carried-over': 'bg-accent-soft text-accent',
  cancelled: STATE_BADGE.cancelled,
}

const noop = (): void => undefined

export function WorkflowSteps({
  steps,
  finalized,
  jobId,
  runId,
  doc,
}: {
  steps: WorkflowStepInfo[]
  finalized: boolean
  jobId: string
  runId: string
  doc: WorkflowDoc | null
  onResume?: (fromStep: number) => void
}) {
  const now = useNow()
  const router = useRouter()
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)

  async function resume(fromStep: number): Promise<void> {
    try {
      const body = await api(`/api/workflow-jobs/${jobId}/resume`, WorkflowResumeResponseSchema, {
        method: 'POST',
        json: { fromStep },
      })
      toast.success('Resumed as a new run')
      router.push(jobHref(jobId, { run: body.runId }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const selectedStep = selectedSeq === null ? null : (steps.find((s) => s.seq === selectedSeq) ?? null)

  return (
    <div className="flex flex-col gap-3 px-[14px] pt-3 pb-4">
      {doc && steps.length > 0 && (
        <div className="flex h-[360px] flex-col gap-2">
          <RunOverlay
            jobId={jobId}
            runId={runId}
            doc={doc}
            findings={[]}
            selectedIds={new Set()}
            notInstalledScriptRefs={new Set()}
            pinnedIds={new Set()}
            readOnly
            onSelectionChange={noop}
            onNodesMoved={noop}
            onEdgeChange={noop}
            onEdgesRemoved={noop}
            onNodesRemoved={noop}
            onInsertOnEdge={noop}
            onConnectToEmpty={noop}
          />
          <RunScrubber steps={steps} selectedSeq={selectedSeq} onSelect={setSelectedSeq} />
          {selectedStep && (
            <div className="grid grid-cols-1 gap-3 rounded-inner border border-line-2 p-3 lg:grid-cols-2">
              <section className="min-w-0 space-y-1.5">
                <p className="rack-label">input · step #{selectedStep.seq + 1}</p>
                <DataView value={selectedStep.input} />
              </section>
              <section className="min-w-0 space-y-1.5">
                <p className="rack-label">output</p>
                <DataView value={selectedStep.output} />
              </section>
            </div>
          )}
        </div>
      )}

      <div className="pb-2 text-label text-faint">Steps · {steps.length} · each script step is a job of its own</div>
      <div className="pb-1 text-tip text-faint">A workflow job runs no device actions itself. The replay of each step is on that step's own job.</div>
      {steps.map((step) => (
        <div key={step.id} className="mb-[10px] rounded-inner border border-line-2 px-3 py-[10px]">
          <div className="flex items-center gap-[9px]">
            <span className="flex-none font-mono text-meta text-faint">#{step.seq + 1}</span>
            <span className="truncate font-mono text-[13px] font-medium">{step.stepId}</span>
            <span className={cn('flex-none rounded-pill px-[10px] py-1 text-badge font-semibold', STEP_BADGE[step.status])}>
              {step.status}
            </span>
            {step.pinned && <span className="flex-none rounded-pill bg-led-ok/20 px-[10px] py-1 text-badge font-semibold text-led-ok">pinned</span>}
            <span className="ml-auto flex-none font-mono text-meta text-faint">{duration(step.startedAt, step.finishedAt, now)}</span>
          </div>
          {step.kind === 'script' && step.jobId ? (
            <Link href={jobHref(step.jobId, { run: step.jobRunId ?? undefined })} className="mt-1 block text-meta text-accent hover:underline">
              Open this step&apos;s job
            </Link>
          ) : step.kind === 'script' ? (
            <p className="mt-1 text-meta text-faint">not enqueued yet</p>
          ) : (
            <>
              <span className="mt-1 block text-meta text-faint">gate</span>
              {step.verdict !== null && step.verdict !== undefined && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-meta text-faint">verdict</summary>
                  <JsonSnapshot title="Verdict" moment="recorded at the gate" value={step.verdict} />
                </details>
              )}
            </>
          )}
          {step.error && (
            <p className="mt-1 text-meta text-danger">
              {step.error}
              {step.errorCode ? ` · ${step.errorCode}` : ''}
            </p>
          )}
          {finalized && step.status !== 'skipped' && (
            <button
              type="button"
              onClick={() => void resume(step.seq)}
              className="mt-2 rounded-button bg-muted px-3 py-[6px] text-meta font-medium text-text-3 hover:bg-muted-2"
            >
              Resume from here
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
