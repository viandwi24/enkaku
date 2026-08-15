import { JobSummarySchema, type JobStatus, type JobSummary } from '@enkaku/protocol'
import { z } from 'zod'
import type { JobsCall } from './ipc'

export interface JobsListResult {
  items: JobSummary[]
  nextCursor: string | null
  total: number
}

const JobsListResultSchema = z.object({
  items: z.array(JobSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.number(),
})

/** `ctx.jobs.trigger()`'s input (plan 81 §3.6, §4.2). */
export interface TriggerInput {
  /** `name`, `name@version`, or `name@latest` — resolved and pinned at trigger time (§3.4). */
  script: string
  params?: unknown
  /** Defaults to the triggering job's own device (§3.5). */
  deviceId?: string
  /** Defaults to 0 — a triggered job never jumps the queue (§8 risk table). */
  priority?: number
  /**
   * Idempotency key (§3.3; plan 99 §3.2, §4.8 folds in `nodeId`). Omitted,
   * the runtime derives `${jobId}:${nodeId ?? ''}:${attempt}:${callIndex}` —
   * the same script code re-executed (a re-run `finish()`) reproduces the
   * same sequence of default keys, so the second call dedupes; a genuine
   * retry has a different `attempt` and therefore triggers a fresh job. Two
   * workflow nodes sharing one `jobId` and one `attempt` counter derive
   * DIFFERENT keys because `nodeId` differs between them, closing a
   * data-loss bug where node 2's trigger would otherwise silently dedupe
   * into node 1's (plan 99 F20).
   */
  key?: string
  /** Defaults to the triggering job's own `expiresAt` (§8) — explicit `null` means no expiry, overriding that inheritance. */
  expiresAt?: number | null
}

/** `ctx.jobs.trigger()`'s return (plan 81 §3.6). Always both fields — `deduped` is required, not optional, so destructuring it is unavoidable. */
export interface TriggerResult {
  jobId: string
  deduped: boolean
}

const TriggerResultSchema = z.object({ jobId: z.string(), deduped: z.boolean() })

export interface JobsApiClient {
  list(opts?: { status?: JobStatus; limit?: number; cursor?: string }): Promise<JobsListResult>
  previous(): Promise<JobSummary | null>
  queuedAfter(opts?: { limit?: number }): Promise<JobSummary[]>
  /**
   * Deliberately `unknown | null`, not schema-validated (plan 80 §4.3): a
   * result is whatever JSON another script's `run()` returned, and this
   * boundary has no schema to check it against — same reasoning as
   * `kv-client.ts`'s `getRaw`. `null` covers every refusal (not-found,
   * foreign-namespace, not-finished) alike; the reason is logged parent-side.
   */
  resultOf(jobId: string): Promise<unknown | null>
  /**
   * The schema check lives HERE, not on the server (plan 97 §4.6, §5 step
   * 97.5) — the same reasoning `kv-client.ts`'s `get` already gives: the
   * server does not know what shape a READING script expects, so this
   * boundary validates against the CALLER's own schema before handing the
   * value back, throwing an error that names the job and the mismatched
   * path (never a silently mis-shaped object).
   */
  resultOf<T>(jobId: string, schema: z.ZodType<T>): Promise<T | null>
  /**
   * Fire-and-forget (plan 81 §3.6): resolves once the job is QUEUED, never
   * once it runs or finishes — awaiting a job on the same device would
   * deadlock against the very job that is awaiting it. A refusal (too deep,
   * chain full, fan-out, a blocked/quarantined target device, or the
   * script reference itself failing to resolve) rejects the promise, which
   * is what makes the throw reach the script (§3.2).
   */
  trigger(input: TriggerInput): Promise<TriggerResult>
}

/**
 * One `JobsApi` bound to the caller's own job (plan 80 §4.2, §4.3) — `request`
 * is the caller's own `jobs.call` → `jobs.result` round trip
 * (`child-entry.ts`'s `jobsRequest`), injected exactly like `createKvApiFor`
 * so this module stays a plain, directly-testable function.
 *
 * `job` (plan 81 §3.3, §4.2) is the caller's own `{ id, attempt }` — needed
 * ONLY to derive `trigger()`'s default idempotency key. It is not read from
 * anywhere else in this module: `list`/`previous`/`queuedAfter`/`resultOf`
 * are unaffected by plan 81 and take no such parameter. `nodeId` (plan 99
 * §3.2, §4.8, closes F20) is the workflow node this execution belongs to —
 * undefined for every job outside a workflow — folded into the SAME key
 * derivation, because several nodes of one workflow share one `jobId` and
 * one `attempt` counter and would otherwise derive colliding default keys,
 * silently deduping node 2's trigger into node 1's.
 */
export function createJobsApiFor(
  request: <T>(call: JobsCall) => Promise<T>,
  job: { id: string; attempt: number; nodeId?: string },
): JobsApiClient {
  // The count of `trigger()` calls made so far in THIS attempt (§3.3) — a
  // plain in-process counter, not a database query: a fresh process (a
  // re-run `finish()`, or a genuinely new retry attempt) naturally restarts
  // it at 0, which is exactly what reproduces the same key sequence for the
  // SAME attempt and a DIFFERENT one for a different `attempt` number.
  let triggerCallIndex = 0

  return {
    async list(opts) {
      const raw = await request<unknown>({
        method: 'list',
        ...(opts?.status !== undefined ? { status: opts.status } : {}),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.cursor !== undefined ? { cursor: opts.cursor } : {}),
      })
      return JobsListResultSchema.parse(raw)
    },

    async previous() {
      const raw = await request<unknown>({ method: 'previous' })
      if (raw === null || raw === undefined) return null
      return JobSummarySchema.parse(raw)
    },

    async queuedAfter(opts) {
      const raw = await request<unknown>({
        method: 'queuedAfter',
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      })
      return z.array(JobSummarySchema).parse(raw)
    },

    async resultOf<T>(jobId: string, schema?: z.ZodType<T>) {
      const raw = await request<unknown>({ method: 'resultOf', jobId })
      if (!schema) return raw
      if (raw === null || raw === undefined) return null
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        throw Object.assign(
          new Error(`jobs.resultOf("${jobId}"): the stored result does not match the given schema — ${parsed.error.message}`),
          { code: 'E_RESULT_SCHEMA_MISMATCH' },
        )
      }
      return parsed.data
    },

    async trigger(input) {
      const idx = triggerCallIndex++
      const key = input.key ?? `${job.id}:${job.nodeId ?? ''}:${job.attempt}:${idx}`
      const raw = await request<unknown>({
        method: 'trigger',
        script: input.script,
        key,
        ...(input.params !== undefined ? { params: input.params } : {}),
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      })
      return TriggerResultSchema.parse(raw)
    },
  }
}
