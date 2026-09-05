import { WORKFLOW_LIMITS } from '@enkaku/protocol'
import type { Db } from '../db'
import { jobRuns, jobs, workflowSteps } from '../db/schema'
import type { SimulateResult } from './simulate'

/**
 * Persists one `simulateWorkflow` result as `trigger: 'simulate'` (plan 309
 * §3.4, §4.3) — stored, not returned synchronously, which is what buys G6:
 * the canvas replays it through the SAME `RunOverlay`/node panel/scrubber a
 * real run uses, with no second read path. Reuses the `jobs`/`job_runs`/
 * `workflow_steps` tables unchanged rather than a parallel schema, on the
 * same "one read path" logic.
 *
 * `deviceId` is the empty string, never `null` and never a real device's id
 * (a real device id is always non-empty — spec's `stableId`,
 * `ro.serialno`/`ANDROID_ID`). Plan 309 §4.3 describes `deviceId` becoming
 * nullable; this repo took the narrower path instead, DELIBERATELY: `jobs`/
 * `job_runs`'s `deviceId` is read, unguarded, by roughly 250 call sites
 * across the queue, claim, and device-activity machinery (`claimNext`,
 * `runningByDevice`, the Jobs list device filter, batch dispatch...) built
 * on the assumption that it is always a real string. Widening the column to
 * `string | null` would turn every one of those into a call this plan would
 * have had to re-audit for a `null` it can never actually receive (a
 * `simulate` run is INSERTED already terminal — `queued`/`running` is never
 * its status — so it is never a candidate for `claimNext` regardless of what
 * `deviceId` holds). The empty string is distinguishable from every real
 * device id, is `NOT NULL`-safe, and needed no migration; `trigger ===
 * 'simulate'` is what actually marks a run as fabricated, not `deviceId`.
 * This is a recorded deviation from the plan's own §4.3 sketch — see the
 * plan's §11 handoff.
 */
const SIMULATE_DEVICE_ID = ''

function capOutput(value: unknown): { output: unknown; truncated: string | null } {
  let json: string
  try {
    json = JSON.stringify(value ?? null)
  } catch {
    return { output: null, truncated: "the step's output could not be serialised to JSON — dropped" }
  }
  const bytes = new TextEncoder().encode(json).length
  if (bytes <= WORKFLOW_LIMITS.maxNodeOutputBytes) return { output: value ?? null, truncated: null }
  return { output: null, truncated: `output was ${bytes} bytes, over the ${WORKFLOW_LIMITS.maxNodeOutputBytes}-byte cap — dropped` }
}

export interface StoreSimulateRunInput {
  workflowName: string
  workflowDoc: unknown
  params: unknown
  createdBy: string | null
  result: SimulateResult
}

/** Writes one simulation as a terminal `jobs`/`job_runs` pair plus its `workflow_steps` rows, and returns the ids the route answers with. */
export function storeSimulateRun(db: Db, input: StoreSimulateRunInput): { jobId: string; runId: string } {
  const now = new Date()
  const jobId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const runStatus = input.result.status === 'stopped' ? 'failed' : input.result.status

  db.insert(jobs)
    .values({
      id: jobId,
      kind: 'workflow',
      workflowName: input.workflowName,
      workflowDoc: input.workflowDoc,
      deviceId: SIMULATE_DEVICE_ID,
      params: input.params,
      scriptName: input.workflowName,
      scriptVersion: null,
      createdBy: input.createdBy,
      createdAt: now,
      latestRunId: runId,
      runCount: 1,
    })
    .run()

  const errorMessage = input.result.status === 'stopped' ? `${input.result.reason} (stopped at "${input.result.stoppedAtNodeId}")` : (input.result.status === 'failed' ? input.result.error : undefined) ?? null

  db.insert(jobRuns)
    .values({
      id: runId,
      jobId,
      seq: 1,
      trigger: 'simulate',
      status: runStatus,
      deviceId: SIMULATE_DEVICE_ID,
      scriptName: input.workflowName,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      result: runStatus === 'success' ? { steps: input.result.steps.length } : null,
      error: errorMessage,
      seed: 0,
    })
    .run()

  input.result.steps.forEach((step) => {
    const { output, truncated } = capOutput(step.output)
    db.insert(workflowSteps)
      .values({
        id: crypto.randomUUID(),
        runId,
        seq: step.seq,
        stepId: step.nodeId,
        kind: step.kind,
        jobId: null,
        jobRunId: null,
        status: 'success',
        startedAt: now,
        finishedAt: now,
        output,
        outputTruncated: truncated,
        input: step.input,
        takenEdge: step.takenEdge,
        pinned: step.source === 'pin',
        verdict: null,
        error: null,
        errorCode: null,
      })
      .run()
  })

  if (input.result.status === 'stopped') {
    db.insert(workflowSteps)
      .values({
        id: crypto.randomUUID(),
        runId,
        seq: input.result.steps.length,
        stepId: input.result.stoppedAtNodeId,
        kind: 'script',
        jobId: null,
        jobRunId: null,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
        output: null,
        outputTruncated: null,
        input: null,
        takenEdge: null,
        pinned: false,
        verdict: null,
        error: input.result.reason,
        errorCode: 'E_WORKFLOW_SIMULATE_STOPPED',
      })
      .run()
  }

  return { jobId, runId }
}
