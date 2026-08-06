import { z } from 'zod'
import { JobDetailSchema, JobInfoSchema, JobStatusSchema, ScriptRefSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor } from '../api/pagination'
import { defineCapability } from './types'

/** `job.run`, `.get`, `.list`, `.cancel` (plan 63 §4.3 table) — one-line
 * delegations to `ctx.jobService`, the SAME `JobService` `POST /api/jobs`
 * and the `job.enqueue`/`job.cancel` WS messages already call (plan 04
 * §4.7's "one code path for both REST and WS" — this is the third path
 * into that same function, not a fourth implementation). `scriptRef`
 * resolution (plan 62) happens here, before `jobService.enqueue` is called,
 * mirroring `api/jobs.ts`'s own deviation (§62's header: `JobService.enqueue`
 * only ever sees a concrete `scriptId`). */

const RunInput = z
  .object({
    scriptId: z.string().min(1).optional(),
    scriptRef: ScriptRefSchema.optional(),
    deviceId: z.string().min(1),
    params: z.unknown(),
    priority: z.number().int().optional(),
  })
  .refine((b) => (b.scriptId ? 1 : 0) + (b.scriptRef ? 1 : 0) === 1, {
    message: 'exactly one of scriptId or scriptRef is required',
  })

export const jobRun = defineCapability({
  id: 'job.run',
  input: RunInput,
  output: JobInfoSchema,
  permission: 'job.run',
  lease: 'none',
  deadline: 10_000,
  effect: 'write',
  description:
    'Enqueue a job: run a script against a device. Accepts scriptId (a concrete published version) or ' +
    'scriptRef ("name@version" / "name@latest") — exactly one. Returns immediately with the queued job; poll ' +
    'job.get for its outcome.',
  handler: (ctx, input) => {
    const scriptId = input.scriptId ?? ctx.resolveScriptRef(input.scriptRef as string).id
    return Promise.resolve(
      ctx.jobService.enqueue({
        scriptId,
        deviceId: input.deviceId,
        params: input.params,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        actor: ctx.actor,
      }),
    )
  },
})

export const jobGet = defineCapability({
  id: 'job.get',
  input: z.object({ jobId: z.string() }),
  output: JobDetailSchema,
  permission: 'job.view',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description: 'Get one job in full, including its result (the script\'s own return value) once it has finished.',
  handler: (ctx, { jobId }) => {
    const job = ctx.jobService.get(jobId)
    if (!job) throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
    return Promise.resolve(job)
  },
})

const ListInput = z.object({
  deviceId: z.string().optional(),
  status: JobStatusSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().nullable().optional(),
})

const ListOutput = z.object({ items: z.array(JobInfoSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative() })

export const jobList = defineCapability({
  id: 'job.list',
  input: ListInput,
  output: ListOutput,
  permission: 'job.view',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description: 'List jobs, newest first, optionally filtered by device or status. Keyset-paginated via cursor/nextCursor.',
  handler: (ctx, { deviceId, status, limit, cursor }) => {
    const result = ctx.jobService.list({
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(limit !== undefined ? { limit } : {}),
      cursor: cursor ? decodeCursor(cursor) : null,
    })
    return Promise.resolve({
      items: result.jobs,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor.sortValue, result.nextCursor.id) : null,
      total: result.total,
    })
  },
})

export const jobCancel = defineCapability({
  id: 'job.cancel',
  input: z.object({ jobId: z.string() }),
  output: JobInfoSchema,
  permission: 'job.cancel.any',
  lease: 'none',
  deadline: 10_000,
  effect: 'write',
  description: 'Cancel a queued or running job.',
  handler: (ctx, { jobId }) => Promise.resolve(ctx.jobService.cancel(jobId)),
})

export const JOB_CAPABILITIES = [jobRun, jobGet, jobList, jobCancel]
