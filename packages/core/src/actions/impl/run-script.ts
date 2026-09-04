import type { ActionResult } from '@enkaku/protocol'
import { createBatch, type BatchDispatchDeps, type CreateBatchInput } from '../../groups/dispatch'
import type { JobService } from '../../services/job-service'
import { EnkakuError } from '../../util/errors'

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
    if (job) return { deviceId, status: 'done', jobId: job.id, batchId: batch.id, runId: job.latestRunId ?? undefined }
    const skip = skipped.find((s) => s.deviceId === deviceId)
    return { deviceId, status: 'skipped', message: skip?.reason ?? 'not dispatched', batchId: batch.id }
  })
  return { results, batchId: batch.id }
}

/**
 * `run-script` with `jobId` (plan 211 §4.8) — a re-run: adds a run to the
 * SAME job when the params (and device/kind) match, or creates a NEW job
 * otherwise (`JobService.addRunOrNewJob`, MVP 14 §2, §6 item 2). The target
 * is ignored — a job names its own device; a request naming a different
 * device is refused.
 */
export function runScriptOnExistingJob(
  jobService: JobService,
  jobId: string,
  target: { deviceIds: string[] },
  input: { params?: unknown; priority?: number; runtimeOverride?: unknown },
): { result: ActionResult; sameJob: boolean } {
  const original = jobService.get(jobId)
  if (!original) throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
  if (target.deviceIds.length > 0 && !target.deviceIds.every((id) => id === original.deviceId)) {
    throw new EnkakuError('E_BAD_REQUEST', `job ${jobId} runs on ${original.deviceId}; drop the target or drop jobId`)
  }
  const { job, runId, sameJob } = jobService.addRunOrNewJob(jobId, {
    deviceId: original.deviceId,
    params: input.params,
    priority: input.priority,
    runtimeOverride: input.runtimeOverride,
  })
  const message = sameJob ? undefined : 'parameters differ from the job\'s, so this is a new job'
  return {
    result: { deviceId: original.deviceId, status: 'done', jobId: job.jobId, runId, ...(message ? { message } : {}) },
    sameJob,
  }
}
