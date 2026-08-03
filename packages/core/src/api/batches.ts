import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { BatchInfo, BatchOrder, BatchStatusEvent } from '@enkaku/protocol'
import { canUseDevice } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import { createBatch } from '../clusters/dispatch'
import { computeBatchStatus, countJobs, recomputeBatchStatus } from '../clusters/status'
import type { Db } from '../db'
import { batches, devices, type BatchRow } from '../db/schema'
import type { ExecutorRegistry } from '../jobs/executor'
import { validateScriptForRun } from '../jobs/validate-script'
import { rowToJobInfo, type JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'

const CreateBatchBody = z.object({
  scriptId: z.string().min(1),
  params: z.unknown(),
  target: z.union([z.object({ clusterId: z.string().min(1) }), z.object({ deviceIds: z.array(z.string()).min(1) })]),
  concurrency: z.number().int().min(0).default(0),
  order: z.enum(['as-listed', 'random']).default('as-listed'),
  priority: z.number().int().optional(),
})

const ERROR_STATUS: Record<string, number> = {
  batch_not_found: 404,
  cluster_not_found: 404,
  E_BAD_REQUEST: 400,
  E_NO_TARGETS: 409,
  unknown_script: 400,
  script_disabled: 409,
  invalid_job_params: 400,
  E_DB: 500,
  'auth.forbidden': 403,
}

function toSec(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null
}

/**
 * Keyset over `batches` (`createdAt DESC, id DESC`, plan 30 §4.2) — a plain
 * function, testable without the rest of `BatchRoutesDeps` (jobStore,
 * scriptNames, ...) that `rowToBatchInfo` needs just to shape a response.
 */
export function queryBatchRows(
  db: Db,
  opts: { cursor: string | null; limit: number },
): { rows: BatchRow[]; nextCursor: string | null; total: number } {
  const cursor = decodeCursor(opts.cursor)
  const keyset = keysetWhere(
    cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
    batches.createdAt,
    batches.id,
  )
  const page = db
    .select()
    .from(batches)
    .where(keyset)
    .orderBy(desc(batches.createdAt), desc(batches.id))
    .limit(opts.limit + 1)
    .all()
  const hasMore = page.length > opts.limit
  const rows = hasMore ? page.slice(0, opts.limit) : page
  const last = rows[rows.length - 1]
  const nextCursor =
    hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
  const total = db.select().from(batches).all().length
  return { rows, nextCursor, total }
}

export interface BatchRoutesDeps {
  db: Db
  jobStore: JobStore
  scheduler: Scheduler
  audit: AuditLogger
  broadcastBatchStatus: (msg: BatchStatusEvent) => void
  scriptNames: (scriptIds: string[]) => Map<string, { name: string; version: string }>
  registry: ExecutorRegistry
  findScript: (scriptId: string) => { enabled: boolean } | null
}

/** Exported so `api/schedules.ts`'s `run-now` can build the same `BatchInfo` shape without a second implementation. */
export function rowToBatchInfo(deps: BatchRoutesDeps, row: BatchRow): BatchInfo {
  const jobs = deps.jobStore.listByBatch(row.id)
  const counts = countJobs(jobs)
  const script = deps.scriptNames([row.scriptId]).get(row.scriptId) ?? null
  return {
    id: row.id,
    clusterId: row.clusterId,
    scriptId: row.scriptId,
    scriptName: script?.name ?? null,
    scriptVersion: script?.version ?? null,
    params: row.params,
    concurrency: row.concurrency,
    order: row.order as BatchOrder,
    // The DB column is a cache — recomputed here too, so a page load is
    // never stale even if a broadcast was missed (plan 20 §3.5).
    status: computeBatchStatus(counts),
    createdBy: row.createdBy,
    createdAt: toSec(row.createdAt) ?? 0,
    finishedAt: toSec(row.finishedAt),
    counts,
  }
}

/**
 * Batch create, list, detail, cancel, rerun-failed (plan 20 §4.6). Cluster
 * membership is resolved once, at creation — the report is built from the
 * batch's own jobs, never re-resolved (plan 20 §3.1, §8 risk table).
 */
export function createBatchRoutes(deps: BatchRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  const mustGet = (id: string): BatchRow => {
    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    if (!row) throw new EnkakuError('batch_not_found', `no such batch: ${id}`)
    return row
  }

  // `canUseDevice` (plan 34 §3.5, §4.4) — an interactive request always has
  // an acting user (`authMiddleware` guarantees one), so both dispatch
  // routes below wire this; the schedule-fired path in `schedules/runner.ts`
  // deliberately does not (no interactive "acting user" at cron time).
  const assertDeviceAllowedFor = (user: { id: string; role: 'admin' | 'operator' } | undefined) => (deviceId: string): void => {
    if (!user) return
    const row = db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, deviceId)).get()
    if (row && !canUseDevice(user, row)) {
      throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
    }
  }

  // `job.run` (plan 34 §4.4, §4.5) — there is no `job.manage` in the ACL
  // matrix; a batch (like a schedule in `api/schedules.ts`) is a way of
  // causing jobs to run, so every route below takes the same permission an
  // operator already has for running one job by hand.
  app.post('/', requirePermission('job.run'), async (c) => {
    const body = CreateBatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const { batch } = createBatch(
      {
        db,
        scheduler: deps.scheduler,
        audit: deps.audit,
        onJobStatus: () => {},
        validateScript: (scriptId, params) => validateScriptForRun(deps, scriptId, params),
        assertDeviceAllowed: assertDeviceAllowedFor(c.get('user')),
      },
      { ...body.data, createdBy: c.get('user')?.id ?? null },
    )
    return c.json({ batch: rowToBatchInfo(deps, batch) }, 201)
  })

  app.get('/', (c) => {
    const { cursor, limit } = parsePageQuery(c)
    const { rows, nextCursor, total } = queryBatchRows(db, { cursor, limit })
    const items = rows.map((r) => rowToBatchInfo(deps, r))
    return c.json({ items, nextCursor, total })
  })

  app.get('/:id', (c) => {
    const row = mustGet(c.req.param('id'))
    const jobRows = deps.jobStore.listByBatch(row.id)
    const names = deps.scriptNames(jobRows.map((j) => j.scriptId))
    return c.json({
      batch: rowToBatchInfo(deps, row),
      jobs: jobRows.map((j) => rowToJobInfo(j, names.get(j.scriptId) ?? null)),
    })
  })

  // Cancels queued jobs only — running ones are left to finish (plan 20 §4.6, acceptance #6).
  app.post('/:id/cancel', requirePermission('job.run'), (c) => {
    const row = mustGet(c.req.param('id'))
    const cancelled = deps.jobStore.cancelQueuedInBatch(row.id)
    recomputeBatchStatus({ db, jobStore: deps.jobStore, broadcast: deps.broadcastBatchStatus }, row.id)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'batch.cancel', target: row.id, meta: { cancelled } })
    return c.json({ cancelled })
  })

  // A new batch over the failed devices — `params` is copied verbatim from
  // the original (plan 20 §9 open question #4: the common case is a flaky
  // device, not wrong parameters).
  app.post('/:id/rerun-failed', requirePermission('job.run'), (c) => {
    const row = mustGet(c.req.param('id'))
    const jobRows = deps.jobStore.listByBatch(row.id)
    const failedDeviceIds = jobRows.filter((j) => j.status === 'failed').map((j) => j.deviceId)
    if (failedDeviceIds.length === 0) {
      throw new EnkakuError('E_NO_TARGETS', 'this batch has no failed jobs to re-run')
    }
    const { batch } = createBatch(
      {
        db,
        scheduler: deps.scheduler,
        audit: deps.audit,
        onJobStatus: () => {},
        validateScript: (scriptId, params) => validateScriptForRun(deps, scriptId, params),
        assertDeviceAllowed: assertDeviceAllowedFor(c.get('user')),
      },
      {
        scriptId: row.scriptId,
        params: row.params,
        target: { deviceIds: failedDeviceIds },
        concurrency: row.concurrency,
        order: row.order as BatchOrder,
        createdBy: c.get('user')?.id ?? null,
      },
    )
    return c.json({ batch: rowToBatchInfo(deps, batch) }, 201)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
