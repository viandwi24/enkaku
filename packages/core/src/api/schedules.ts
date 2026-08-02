import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  BatchOrderSchema,
  CatchUpSchema,
  OnOverlapSchema,
  type BatchOrder,
  type CatchUp,
  type JobInfo,
  type OnOverlap,
  type ScheduleFiredEvent,
  type ScheduleInfo,
  type ScheduleRunInfo,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { rowToBatchInfo, type BatchRoutesDeps } from './batches'
import type { Db } from '../db'
import { batches, clusters, schedules, scheduleRuns, type ScheduleRow } from '../db/schema'
import type { ExecutorRegistry } from '../jobs/executor'
import { validateScriptForRun } from '../jobs/validate-script'
import type { JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { nextFires } from '../schedules/cron'
import { fireOnce, type ScheduleRunner, type ScheduleRunnerDeps } from '../schedules/runner'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'

const ScheduleTargetSchema = z.union([
  z.object({ clusterId: z.string().min(1) }),
  // Plan 21 §9 open question #3 — "everything" is always something someone wrote down.
  z.object({ deviceIds: z.array(z.string()).min(1) }),
])

const ScheduleBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  scriptId: z.string().min(1),
  params: z.unknown(),
  target: ScheduleTargetSchema,
  concurrency: z.number().int().min(0).default(0),
  order: BatchOrderSchema.default('as-listed'),
  onOverlap: OnOverlapSchema.default('skip'),
  queueTimeoutSec: z.number().int().min(1).nullable().default(null),
  catchUp: CatchUpSchema.default('skip'),
  jitterSec: z.number().int().min(0).default(0),
  priority: z.number().int().default(0),
})

const SchedulePatchBody = ScheduleBody.partial()

const RunNowBody = z.object({ ignoreOverlap: z.boolean().default(false) })

const ValidateBody = z.object({ cron: z.string().min(1), timezone: z.string().min(1) })

const ERROR_STATUS: Record<string, number> = {
  schedule_not_found: 404,
  cluster_not_found: 404,
  E_BAD_REQUEST: 400,
  E_NOT_DISPATCHED: 409,
  E_NO_TARGETS: 409,
  unknown_script: 400,
  script_disabled: 409,
  invalid_job_params: 400,
  E_DB: 500,
}

function toSec(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null
}

/** Keyset over `schedules` (`createdAt DESC, id DESC`, plan 30 §4.2) — a plain function, testable on its own. */
export function querySchedulesRows(
  db: Db,
  opts: { cursor: string | null; limit: number },
): { rows: ScheduleRow[]; nextCursor: string | null; total: number } {
  const cursor = decodeCursor(opts.cursor)
  const keyset = keysetWhere(
    cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
    schedules.createdAt,
    schedules.id,
  )
  const page = db
    .select()
    .from(schedules)
    .where(keyset)
    .orderBy(desc(schedules.createdAt), desc(schedules.id))
    .limit(opts.limit + 1)
    .all()
  const hasMore = page.length > opts.limit
  const rows = hasMore ? page.slice(0, opts.limit) : page
  const last = rows[rows.length - 1]
  const nextCursor =
    hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
  const total = db.select().from(schedules).all().length
  return { rows, nextCursor, total }
}

/** Keyset over one schedule's `schedule_runs` (`dueAt DESC, id DESC`, plan 30 §4.2). */
export function queryScheduleRunsRows(
  db: Db,
  scheduleId: string,
  opts: { cursor: string | null; limit: number },
): { rows: Array<typeof scheduleRuns.$inferSelect>; nextCursor: string | null; total: number } {
  const cursor = decodeCursor(opts.cursor)
  const keyset = keysetWhere(
    cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
    scheduleRuns.dueAt,
    scheduleRuns.id,
  )
  const scopedWhere = keyset ? and(eq(scheduleRuns.scheduleId, scheduleId), keyset) : eq(scheduleRuns.scheduleId, scheduleId)
  const page = db
    .select()
    .from(scheduleRuns)
    .where(scopedWhere)
    .orderBy(desc(scheduleRuns.dueAt), desc(scheduleRuns.id))
    .limit(opts.limit + 1)
    .all()
  const hasMore = page.length > opts.limit
  const rows = hasMore ? page.slice(0, opts.limit) : page
  const last = rows[rows.length - 1]
  const nextCursor =
    hasMore && last ? encodeCursor(Math.floor((last.dueAt ?? new Date(0)).getTime() / 1000), last.id) : null
  const total = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId)).all().length
  return { rows, nextCursor, total }
}

export interface ScheduleRoutesDeps {
  db: Db
  jobStore: JobStore
  scheduler: Scheduler
  audit: AuditLogger
  log: Logger
  runner: ScheduleRunner
  registry: ExecutorRegistry
  findScript: (scriptId: string) => { enabled: boolean } | null
  scriptNames: (scriptIds: string[]) => Map<string, { name: string; version: string }>
  onJobStatus: (info: JobInfo) => void
  broadcastBatchStatus: BatchRoutesDeps['broadcastBatchStatus']
  broadcastFired: (msg: ScheduleFiredEvent) => void
}

function rowToScheduleInfo(deps: ScheduleRoutesDeps, row: ScheduleRow): ScheduleInfo {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled ?? true,
    cron: row.cron,
    timezone: row.timezone,
    scriptId: row.scriptId,
    params: row.params,
    clusterId: row.clusterId,
    deviceIds: (row.deviceIds as string[] | null) ?? [],
    concurrency: row.concurrency,
    order: row.order as BatchOrder,
    onOverlap: row.onOverlap as OnOverlap,
    queueTimeoutSec: row.queueTimeoutSec,
    catchUp: row.catchUp as CatchUp,
    jitterSec: row.jitterSec,
    priority: row.priority,
    lastFiredAt: toSec(row.lastFiredAt),
    lastBatchId: row.lastBatchId,
    createdBy: row.createdBy,
    createdAt: toSec(row.createdAt) ?? 0,
    nextFireAt: row.enabled ? (deps.runner.nextFires().get(row.id) ?? null) : null,
  }
}

function rowToScheduleRunInfo(row: typeof scheduleRuns.$inferSelect): ScheduleRunInfo {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    dueAt: toSec(row.dueAt) ?? 0,
    firedAt: toSec(row.firedAt),
    outcome: row.outcome as ScheduleRunInfo['outcome'],
    batchId: row.batchId,
    detail: row.detail,
    missedCount: row.missedCount,
  }
}

/**
 * Schedule CRUD, `run-now`, `runs`, `validate` (plan 21 §4.4). A schedule
 * triggers a **batch** through plan 20's `createBatch` — never a bare job —
 * which is why the actual dispatch machinery lives in `schedules/runner.ts`
 * and this file only ever calls into it: `run-now` reuses `fireOnce` (never
 * a second dispatch path), and every mutation calls `runner.reload()` so the
 * live countdown never drifts from what is actually saved.
 */
export function createScheduleRoutes(deps: ScheduleRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  const mustGet = (id: string): ScheduleRow => {
    const row = db.select().from(schedules).where(eq(schedules.id, id)).get()
    if (!row) throw new EnkakuError('schedule_not_found', `no such schedule: ${id}`)
    return row
  }

  const runnerDeps: ScheduleRunnerDeps = {
    db: deps.db,
    jobStore: deps.jobStore,
    scheduler: deps.scheduler,
    audit: deps.audit,
    log: deps.log,
    onJobStatus: deps.onJobStatus,
    broadcastBatchStatus: deps.broadcastBatchStatus,
    broadcastFired: deps.broadcastFired,
    validateScript: (scriptId, params) => validateScriptForRun(deps, scriptId, params),
  }

  const batchDeps: BatchRoutesDeps = {
    db: deps.db,
    jobStore: deps.jobStore,
    scheduler: deps.scheduler,
    audit: deps.audit,
    broadcastBatchStatus: deps.broadcastBatchStatus,
    scriptNames: deps.scriptNames,
    registry: deps.registry,
    findScript: deps.findScript,
  }

  const assertClusterExists = (target: z.infer<typeof ScheduleTargetSchema>): void => {
    if (!('clusterId' in target)) return
    const row = db.select().from(clusters).where(eq(clusters.id, target.clusterId)).get()
    if (!row) throw new EnkakuError('cluster_not_found', `no such cluster: ${target.clusterId}`)
  }

  const assertCronValid = (cron: string, timezone: string): void => {
    const result = nextFires(cron, timezone, 1)
    if (!result.ok) throw new EnkakuError('E_BAD_REQUEST', `invalid cron expression: ${result.error}`)
  }

  app.post('/validate', async (c) => {
    const body = ValidateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { cron, timezone } is required')
    const result = nextFires(body.data.cron, body.data.timezone, 5)
    if (!result.ok) return c.json({ valid: false, nextFires: [], error: result.error })
    return c.json({ valid: true, nextFires: result.value })
  })

  app.get('/', (c) => {
    const { cursor, limit } = parsePageQuery(c)
    const { rows, nextCursor, total } = querySchedulesRows(db, { cursor, limit })
    const items = rows.map((r) => rowToScheduleInfo(deps, r))
    // Legacy key, kept alongside `items` for one release (plan 30 §3.3).
    return c.json({ items, nextCursor, total, schedules: items })
  })

  app.post('/', async (c) => {
    const body = ScheduleBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    assertCronValid(body.data.cron, body.data.timezone)
    assertClusterExists(body.data.target)
    const validatedParams = validateScriptForRun(deps, body.data.scriptId, body.data.params)

    const row: ScheduleRow = {
      id: crypto.randomUUID(),
      name: body.data.name,
      enabled: body.data.enabled,
      cron: body.data.cron,
      timezone: body.data.timezone,
      scriptId: body.data.scriptId,
      params: validatedParams ?? null,
      clusterId: 'clusterId' in body.data.target ? body.data.target.clusterId : null,
      deviceIds: 'deviceIds' in body.data.target ? body.data.target.deviceIds : null,
      concurrency: body.data.concurrency,
      order: body.data.order,
      onOverlap: body.data.onOverlap,
      queueTimeoutSec: body.data.queueTimeoutSec,
      catchUp: body.data.catchUp,
      jitterSec: body.data.jitterSec,
      priority: body.data.priority,
      lastFiredAt: null,
      lastBatchId: null,
      createdBy: c.get('user')?.id ?? null,
      createdAt: new Date(),
    }
    db.insert(schedules).values(row).run()
    deps.runner.reload()
    deps.audit.record({ userId: row.createdBy, action: 'schedule.create', target: row.id, meta: { name: row.name, cron: row.cron } })
    return c.json({ schedule: rowToScheduleInfo(deps, row) }, 201)
  })

  app.get('/:id', (c) => c.json({ schedule: rowToScheduleInfo(deps, mustGet(c.req.param('id'))) }))

  app.patch('/:id', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = SchedulePatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const nextCron = body.data.cron ?? row.cron
    const nextTimezone = body.data.timezone ?? row.timezone
    if (body.data.cron !== undefined || body.data.timezone !== undefined) assertCronValid(nextCron, nextTimezone)
    if (body.data.target !== undefined) assertClusterExists(body.data.target)

    const patch: Partial<ScheduleRow> = {}
    if (body.data.name !== undefined) patch.name = body.data.name
    if (body.data.enabled !== undefined) patch.enabled = body.data.enabled
    if (body.data.cron !== undefined) patch.cron = body.data.cron
    if (body.data.timezone !== undefined) patch.timezone = body.data.timezone
    if (body.data.target !== undefined) {
      patch.clusterId = 'clusterId' in body.data.target ? body.data.target.clusterId : null
      patch.deviceIds = 'deviceIds' in body.data.target ? body.data.target.deviceIds : null
    }
    if (body.data.scriptId !== undefined || body.data.params !== undefined) {
      const scriptId = body.data.scriptId ?? row.scriptId
      patch.scriptId = scriptId
      patch.params = validateScriptForRun(deps, scriptId, body.data.params ?? row.params) ?? null
    }
    if (body.data.concurrency !== undefined) patch.concurrency = body.data.concurrency
    if (body.data.order !== undefined) patch.order = body.data.order
    if (body.data.onOverlap !== undefined) patch.onOverlap = body.data.onOverlap
    if (body.data.queueTimeoutSec !== undefined) patch.queueTimeoutSec = body.data.queueTimeoutSec
    if (body.data.catchUp !== undefined) patch.catchUp = body.data.catchUp
    if (body.data.jitterSec !== undefined) patch.jitterSec = body.data.jitterSec
    if (body.data.priority !== undefined) patch.priority = body.data.priority

    if (Object.keys(patch).length > 0) db.update(schedules).set(patch).where(eq(schedules.id, row.id)).run()
    deps.runner.reload()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'schedule.update', target: row.id, meta: { patch: Object.keys(patch) } })
    return c.json({ schedule: rowToScheduleInfo(deps, mustGet(row.id)) })
  })

  app.delete('/:id', (c) => {
    const row = mustGet(c.req.param('id'))
    db.delete(schedules).where(eq(schedules.id, row.id)).run()
    deps.runner.reload()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'schedule.delete', target: row.id, meta: { name: row.name } })
    return c.body(null, 204)
  })

  app.get('/:id/runs', (c) => {
    const row = mustGet(c.req.param('id'))
    const { cursor, limit } = parsePageQuery(c)
    const { rows, nextCursor, total } = queryScheduleRunsRows(db, row.id, { cursor, limit })
    const items = rows.map(rowToScheduleRunInfo)
    // Legacy key, kept alongside `items` for one release (plan 30 §3.3).
    return c.json({ items, nextCursor, total, runs: items })
  })

  // Ignores the cron — fires right now — but still honours onOverlap unless
  // the operator explicitly overrides it (plan 21 §9 open question #2).
  app.post('/:id/run-now', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = RunNowBody.safeParse(await c.req.json().catch(() => ({})))
    const ignoreOverlap = body.success && body.data.ignoreOverlap
    // Never applies jitter to a manual "run now" — the operator asked for it now.
    const effective: ScheduleRow = { ...row, jitterSec: 0, ...(ignoreOverlap ? { onOverlap: 'queue' as const } : {}) }

    await fireOnce(runnerDeps, effective, new Date())
    deps.runner.reload()

    const latest = db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, row.id))
      .orderBy(desc(scheduleRuns.dueAt))
      .limit(1)
      .get()
    if (!latest || latest.outcome !== 'dispatched' || !latest.batchId) {
      throw new EnkakuError('E_NOT_DISPATCHED', latest?.detail ?? `run-now did not dispatch (${latest?.outcome ?? 'unknown'})`)
    }
    const batchRow = db.select().from(batches).where(eq(batches.id, latest.batchId)).get()
    if (!batchRow) throw new EnkakuError('E_DB', 'the dispatched batch did not persist')

    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'schedule.run-now', target: row.id, meta: { batchId: batchRow.id } })
    return c.json({ batch: rowToBatchInfo(batchDeps, batchRow) })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
