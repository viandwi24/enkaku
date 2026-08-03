import { asc, eq, inArray } from 'drizzle-orm'
import type { JobInfo } from '@enkaku/protocol'
import type { Db } from '../db'
import { batches, clusters, devices, jobs, type BatchRow, type JobRow } from '../db/schema'
import type { AuditLogger } from '../auth/audit'
import { rowToJobInfo } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import { resolveCluster, resolveTarget, type ResolvedCluster } from './resolve'

export interface CreateBatchInput {
  scriptId: string
  params: unknown
  target: { clusterId: string } | { deviceIds: string[] }
  concurrency: number
  order: 'as-listed' | 'random'
  priority?: number
  createdBy?: string | null
  /**
   * Plan 21 §3.3, §4.2 — unix seconds; the queue-timeout reaper expires a
   * `queued` job past this deadline. Null/omitted means "wait forever". This
   * lives on the job, not the batch, because the same question applies to any
   * job regardless of what created it — a schedule just happens to be the
   * first caller that sets it (`now + queueTimeoutSec`).
   */
  expiresAt?: number | null
}

export interface BatchDispatchDeps {
  db: Db
  scheduler: Scheduler
  audit: AuditLogger
  onJobStatus: (info: JobInfo) => void
  /**
   * Validate the script and its params before any job is created — the same
   * check a standalone job goes through in `job-service.ts`. Without this, a
   * typo'd or disabled scriptId would silently create N jobs each doomed to
   * fail individually at claim time instead of failing fast, once, at
   * dispatch. Optional so unit tests can exercise dispatch without wiring a
   * full executor registry.
   */
  validateScript?: (scriptId: string, params: unknown) => unknown
  /**
   * `canUseDevice` (plan 34 §3.5, §4.4) — called once per RESOLVED usable
   * device, before any job row is built, so an operator targeting a device
   * they do not own refuses the WHOLE batch rather than silently dispatching
   * a smaller one. Throws to refuse; a caller with no interest in ownership
   * (a schedule firing on its own cron, which has no interactive "acting
   * user" — see plan 34 §9 open question area) simply omits this.
   */
  assertDeviceAllowed?: (deviceId: string) => void
}

/**
 * Fisher-Yates using `crypto.getRandomValues`, not `Math.random()` (plan 20
 * §4.4). Resolved once, at dispatch — the report then shows the order that
 * actually ran; nothing depends on a random number that no longer exists
 * (plan 20 §3.2).
 */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  const rand = new Uint32Array(arr.length)
  crypto.getRandomValues(rand)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rand[i] as number) % (i + 1)
    const tmp = arr[i] as T
    arr[i] = arr[j] as T
    arr[j] = tmp
  }
  return arr
}

function toJobRow(input: {
  scriptId: string
  deviceId: string
  params: unknown
  priority: number
  batchId: string
  batchSeq: number
  now: Date
  expiresAt: number | null
}): JobRow {
  return {
    id: crypto.randomUUID(),
    scriptId: input.scriptId,
    deviceId: input.deviceId,
    params: input.params ?? null,
    priority: input.priority,
    status: 'queued',
    leaseExpiresAt: null,
    result: null,
    error: null,
    createdAt: input.now,
    startedAt: null,
    finishedAt: null,
    batchId: input.batchId,
    batchSeq: input.batchSeq,
    expiresAt: input.expiresAt,
    failureClass: null,
    infraAttempts: 0,
  }
}

/**
 * Resolve targets → insert the batch → insert one job per device with
 * `batchSeq` assigned in the final order → audit → kick the scheduler (plan
 * 20 §4.4). The batch row and every job row are inserted in one transaction,
 * so a crash between them cannot half-create a batch (plan 20 §3.4).
 *
 * A cluster (or an ad-hoc list) resolving to zero usable devices is a coded
 * error at dispatch, not an empty batch (plan 20 §3.1, §4.3): silently doing
 * nothing is the failure mode people notice last.
 */
export function createBatch(deps: BatchDispatchDeps, input: CreateBatchInput): { batch: BatchRow; jobs: JobRow[] } {
  const { db } = deps
  const validatedParams = deps.validateScript ? deps.validateScript(input.scriptId, input.params) : input.params

  let clusterId: string | null = null
  let resolved: ResolvedCluster
  if ('clusterId' in input.target) {
    const cluster = db.select().from(clusters).where(eq(clusters.id, input.target.clusterId)).get()
    if (!cluster) throw new EnkakuError('cluster_not_found', `no such cluster: ${input.target.clusterId}`)
    clusterId = cluster.id
    resolved = resolveCluster(db, cluster)
  } else {
    resolved = resolveTarget(db, { tags: [], deviceIds: input.target.deviceIds })
  }

  if (resolved.usable.length === 0) {
    throw new EnkakuError(
      'E_NO_TARGETS',
      resolved.skipped.length > 0
        ? `no usable devices — every match was unavailable: ${resolved.skipped.map((s) => `${s.deviceId} (${s.reason})`).join(', ')}`
        : 'no devices matched this target',
    )
  }

  // `canUseDevice` (plan 34 §3.5, §4.4) — before any job row exists, so a
  // refusal never leaves a half-created batch.
  if (deps.assertDeviceAllowed) {
    for (const t of resolved.usable) deps.assertDeviceAllowed(t.deviceId)
  }

  const ordered = input.order === 'random' ? shuffle(resolved.usable) : resolved.usable
  const batchId = crypto.randomUUID()
  const now = new Date()
  const priority = input.priority ?? 0

  const expiresAt = input.expiresAt ?? null
  const jobRows = ordered.map((t, i) =>
    toJobRow({ scriptId: input.scriptId, deviceId: t.deviceId, params: validatedParams, priority, batchId, batchSeq: i, now, expiresAt }),
  )

  db.transaction((tx) => {
    tx.insert(batches)
      .values({
        id: batchId,
        clusterId,
        scriptId: input.scriptId,
        params: validatedParams ?? null,
        concurrency: input.concurrency,
        order: input.order,
        status: 'queued',
        createdBy: input.createdBy ?? null,
        createdAt: now,
        finishedAt: null,
      })
      .run()
    for (const row of jobRows) tx.insert(jobs).values(row).run()
  })

  const batch = db.select().from(batches).where(eq(batches.id, batchId)).get()
  if (!batch) throw new EnkakuError('E_DB', 'batch insert did not persist')

  deps.audit.record({
    userId: input.createdBy ?? null,
    action: 'job.run',
    target: batchId,
    meta: { scriptId: input.scriptId, deviceCount: jobRows.length, order: input.order, skipped: resolved.skipped },
  })
  for (const row of jobRows) deps.onJobStatus(rowToJobInfo(row))
  deps.scheduler.kick()

  return { batch, jobs: jobRows }
}

/**
 * Plan 36 §3.6 — after an infra failure, a batch member should move to
 * another eligible device rather than retrying against the one that is
 * failing. Batch dispatch (`createBatch` above) already put exactly one job
 * row per resolved device, so "the batch's device set" is simply the
 * distinct `deviceId`s among the job's own siblings — this works whether the
 * batch came from a saved cluster or an ad-hoc device list, with no need to
 * re-resolve either.
 *
 * Picks the lowest-`batchSeq` sibling device that is currently `idle` and
 * not the device the job just failed on. Returns null when none is
 * available — the caller then requeues the job on its own current device,
 * exactly as plan 36 §3.6 describes ("if none is available it retries on
 * the same device after the backoff").
 */
export function pickRebindDevice(db: Db, job: JobRow): string | null {
  if (!job.batchId) return null
  const siblings = db.select({ deviceId: jobs.deviceId }).from(jobs).where(eq(jobs.batchId, job.batchId)).orderBy(asc(jobs.batchSeq)).all()
  const candidateIds = [...new Set(siblings.map((s) => s.deviceId))].filter((id) => id !== job.deviceId)
  if (candidateIds.length === 0) return null
  const rows = db.select().from(devices).where(inArray(devices.id, candidateIds)).all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of candidateIds) {
    if (byId.get(id)?.status === 'idle') return id
  }
  return null
}
