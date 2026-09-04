'use client'

import { useEffect, useRef, useState } from 'react'
import { WorkflowStepsResponseSchema, type WorkflowStepInfo } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { ws } from '@/lib/ws'

/**
 * The run overlay's own projection (plan 307 §3.1) — drawn the same way
 * whether it came from a live WebSocket or from a finished run's rows. A
 * node absent from this map is `pending`: it has not reached the recorder
 * yet, or the recorder never logs it at all (`start`/`finish`, plan 301
 * §3.2, §3.4).
 */
export type RunNodeStatus = 'running' | 'ok' | 'failed' | 'pinned' | 'skipped'

export interface RunNodeState {
  status: RunNodeStatus
  seq: number
  takenEdge: string | null
  startedAt: number | null
  endedAt: number | null
  input: unknown
  output: unknown
  error: string | null
}

export type RunState = Record<string, RunNodeState>

function statusOf(step: WorkflowStepInfo): RunNodeStatus {
  if (step.pinned) return 'pinned'
  switch (step.status) {
    case 'running':
      return 'running'
    case 'success':
    case 'carried-over':
      return 'ok'
    case 'failed':
      return 'failed'
    case 'skipped':
    case 'cancelled':
      return 'skipped'
  }
}

function projectSteps(items: WorkflowStepInfo[]): RunState {
  const state: RunState = {}
  // A loop can revisit the same node id more than once in one run
  // (`workflow_steps.seq`'s own doc comment) — the LATEST step for a node
  // id is the one the canvas should show, same rule the last-run route
  // already applies (`packages/core/src/api/workflows.ts`).
  for (const step of items) {
    const existing = state[step.stepId]
    if (existing && existing.seq > step.seq) continue
    state[step.stepId] = {
      status: statusOf(step),
      seq: step.seq,
      takenEdge: step.takenEdge,
      startedAt: step.startedAt,
      endedAt: step.finishedAt,
      input: step.input,
      output: step.output,
      error: step.error,
    }
  }
  return state
}

export interface UseRunStateResult {
  /** Empty until the first HTTP snapshot lands — `RunOverlay` draws nothing until then (plan 307 §3.3: fetch first, subscribe second, the same order every other live screen in this repo uses). */
  runState: RunState
  /** Newest-seq-last, exactly as the API returns them — the scrubber's own source (§4.3). */
  steps: WorkflowStepInfo[]
  /** Whether the RUN (not the job) has settled — `TERMINAL_RUN_STATUSES` on the core side. */
  finalized: boolean
  loading: boolean
}

const EMPTY: UseRunStateResult = { runState: {}, steps: [], finalized: true, loading: false }

/**
 * HTTP snapshot, then WS subscription, projected into `RunState` (plan 307
 * §3.1, §3.3, step 307.1). No new message type: this listens to `job.status`
 * for the workflow job itself (its own status settling) and for every CHILD
 * job a `script` step enqueues (`parentWorkflowJobId === jobId`, already on
 * `JobInfoSchema` since plan 82) — the same field `use-job-detail.ts` already
 * reads for "step N of workflow job".
 *
 * A `gate`/`switch`/`delay` step has no job of its own and so broadcasts no
 * `job.status` at all — it runs and settles inside the workflow job's own
 * process with no live wire signal. The 1.5s poll below is the honest,
 * additive fallback for exactly that gap (recorded in the handoff report,
 * plan 307 §3.3): every refetch — WS-triggered or polled — asks the same
 * HTTP snapshot, so it is never a second source of truth, only a second
 * reason to re-read the one source that exists.
 */
export function useRunState(jobId: string | null, runId: string | null): UseRunStateResult {
  const [items, setItems] = useState<WorkflowStepInfo[]>([])
  const [finalized, setFinalized] = useState(true)
  const [loading, setLoading] = useState(false)
  // Read by the poll below so it always sees the LATEST finalized flag, not
  // the one captured when the effect first ran.
  const finalizedRef = useRef(true)

  useEffect(() => {
    if (!jobId || !runId) {
      setItems([])
      setFinalized(true)
      setLoading(false)
      return
    }
    let disposed = false
    setLoading(true)

    const load = (): void => {
      void api(`/api/workflow-jobs/${jobId}/runs/${runId}/steps`, WorkflowStepsResponseSchema)
        .then((b) => {
          if (disposed) return
          setItems(b.items)
          setFinalized(b.finalized)
          finalizedRef.current = b.finalized
          setLoading(false)
        })
        .catch(() => {
          if (!disposed) setLoading(false)
        })
    }

    load()

    const off = ws.on((m) => {
      if (m.type !== 'job.status') return
      if (m.payload.jobId === jobId || m.payload.parentWorkflowJobId === jobId) load()
    })

    // The fallback poll (see this hook's own doc comment) — stops the moment
    // the run settles, so a finished run never polls forever.
    const poll = window.setInterval(() => {
      if (!finalizedRef.current) load()
    }, 1_500)

    return () => {
      disposed = true
      off()
      window.clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, runId])

  if (!jobId || !runId) return EMPTY
  return { runState: projectSteps(items), steps: items, finalized, loading }
}
