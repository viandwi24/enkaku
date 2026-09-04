import type { ActionResult } from '@enkaku/protocol'
import { createBatch, type BatchDispatchDeps, type CreateBatchInput } from '../../groups/dispatch'

export interface RunScriptInput {
  scriptId?: string
  scriptRef?: string
  params?: unknown
  concurrency: number
  order: 'as-listed' | 'random'
  priority?: number
  runtimeOverride?: unknown
  pacing?: CreateBatchInput['pacing']
  createdBy: string | null
}

/**
 * `run-script` (plan 207 §4.2, §3.2 item 5) — always creates a batch, even
 * for one device, through the existing `createBatch` path. `scriptRef` is
 * resolved exactly as `POST /api/jobs` did (`jobs.ts:207-238`).
 */
export function runScriptOnTargets(
  deps: BatchDispatchDeps,
  resolveScriptRef: (ref: string) => { id: string },
  accepted: string[],
  input: RunScriptInput,
): { results: ActionResult[]; batchId: string } {
  const scriptId = input.scriptRef ? resolveScriptRef(input.scriptRef).id : input.scriptId!
  const { batch, jobs } = createBatch(deps, {
    scriptId,
    params: input.params,
    target: { deviceIds: accepted },
    concurrency: input.concurrency,
    order: input.order,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    createdBy: input.createdBy,
    ...(input.runtimeOverride !== undefined ? { runtimeOverride: input.runtimeOverride } : {}),
    ...(input.pacing ? { pacing: input.pacing } : {}),
  })
  const jobByDevice = new Map(jobs.map((j) => [j.deviceId, j]))
  const skipped = (batch.skipped as { deviceId: string; reason: string }[] | null) ?? []
  const results: ActionResult[] = accepted.map((deviceId) => {
    const job = jobByDevice.get(deviceId)
    if (job) return { deviceId, status: 'done', jobId: job.id, batchId: batch.id }
    const skip = skipped.find((s) => s.deviceId === deviceId)
    return { deviceId, status: 'skipped', message: skip?.reason ?? 'not dispatched', batchId: batch.id }
  })
  return { results, batchId: batch.id }
}
