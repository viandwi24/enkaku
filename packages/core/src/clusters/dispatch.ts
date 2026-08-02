import { eq } from 'drizzle-orm'
import type { JobInfo } from '@enkaku/protocol'
import type { Db } from '../db'
import { batches, clusters, jobs, type BatchRow, type JobRow } from '../db/schema'
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
