import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  BatchOrderSchema,
  CatchUpSchema,
  OnApprovalRequiredSchema,
  OnOverlapSchema,
  reconcileParams,
  ScheduleResponseSchema,
  ScheduleRunsPageResponseSchema,
  ScheduleThreadModeSchema,
  ScheduleWorkTargetSchema,
  ScriptRefSchema,
  ValidateResponseSchema,
  type BatchOrder,
  type CatchUp,
  type JobInfo,
  type JsonSchemaNode,
  type OnApprovalRequired,
  type OnOverlap,
  type ScheduleFiredEvent,
  type ScheduleInfo,
  type ScheduleRunInfo,
  type ScheduleThreadMode,
  type ScheduleWorkTarget,
  type ScriptRef,
  type ShellMode,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import { rowToBatchInfo, type BatchRoutesDeps } from './batches'
import type { Db } from '../db'
import { batches, groups, schedules, scheduleAgentTargets, scheduleRuns, type ScheduleAgentTargetRow, type ScheduleRow, type ScriptRow } from '../db/schema'
import type { ExecutorRegistry } from '../jobs/executor'
import { validateScriptForRun } from '../jobs/validate-script'
import type { JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { nextFires } from '../schedules/cron'
import { fireOnce, type ScheduleAgentDispatch, type ScheduledAgentCeilings, type ScheduleRunner, type ScheduleRunnerDeps } from '../schedules/runner'
import { resolveScriptRef } from '../scripts/resolve'
import type { ScriptEntry, ScriptRegistry } from '../scripts/registry'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

const ScheduleTargetSchema = z.union([
  z.object({ groupId: z.string().min(1) }),
  // Plan 21 §9 open question #3 — "everything" is always something someone wrote down.
  z.object({ deviceIds: z.array(z.string()).min(1) }),
])

const ScheduleBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  /** `name@version` or `name@latest` (plan 62 §4.4) — the LEGACY shape: a schedule stores the REFERENCE, never a resolved id. Superseded by `workTarget` below when given; kept so every pre-plan-68 caller (Studio, `POST /api/schedules`) needs no change. */
  scriptRef: ScriptRefSchema.optional(),
  params: z.unknown().optional(),
  /** Plan 68 §3.1 — the work this schedule triggers. Omitted ⇒ derived from `scriptRef`/`params` above. */
  workTarget: ScheduleWorkTargetSchema.optional(),
  target: ScheduleTargetSchema,
  concurrency: z.number().int().min(0).default(0),
  order: BatchOrderSchema.default('as-listed'),
  onOverlap: OnOverlapSchema.default('skip'),
  queueTimeoutSec: z.number().int().min(1).nullable().default(null),
  catchUp: CatchUpSchema.default('skip'),
  jitterSec: z.number().int().min(0).default(0),
  priority: z.number().int().default(0),
  /**
   * Plan 94 §3.7, §4.8, step 94.9, F34 — passed straight through to
   * `createBatch`'s own `pacing` shape, exactly like `concurrency`/`order`/
   * `priority` above. Distinct from `jitterSec` above: `jitterSec` shifts
   * the WHOLE firing before a batch exists; these four shift EACH
   * repetition once it does (§3.7's own hazard note). `repeatCount: 1`
   * with every interval `0` (the defaults) is today's behaviour exactly.
   */
  repeatCount: z.number().int().min(1).max(1000).default(1),
  intervalMinMs: z.number().int().min(0).default(0),
  intervalMaxMs: z.number().int().min(0).default(0),
  deviceIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
  /** Plan 68 §3.2 — agent targets only. */
  threadMode: ScheduleThreadModeSchema.default('new'),
  /** Plan 68 §3.5 — agent targets only. */
  onApprovalRequired: OnApprovalRequiredSchema.default('deny'),
})

const SchedulePatchBody = ScheduleBody.partial()

const RunNowBody = z.object({ ignoreOverlap: z.boolean().default(false) })

const ValidateBody = z.object({ cron: z.string().min(1), timezone: z.string().min(1) })

const ERROR_STATUS: Record<string, number> = {
  schedule_not_found: 404,
  group_not_found: 404,
  E_BAD_REQUEST: 400,
  E_NOT_DISPATCHED: 409,
  E_NO_TARGETS: 409,
  unknown_script: 400,
  script_disabled: 409,
  script_not_found: 404,
  script_version_not_found: 404,
  script_ref_unresolved: 409,
  invalid_job_params: 400,
  agent_not_found: 404,
  E_AGENT_DISABLED: 409,
  E_DB: 500,
  // Plan 93 §3.12, §4.6, step 93.8 — `JobExecutor.requires`'s gate
  // (`validateScriptForRun`, via `validateScriptFor`) throws this by name at
  // schedule create/edit time now that it can, the same code every other
  // permission refusal in this codebase uses. Missing until now: nothing
  // this route called threw it before this step.
  'auth.forbidden': 403,
}

/** What a reference resolves to right now (plan 62 §4.4) — echoed alongside the schedule so the UI can show "→ 2.0.0" without a second call. */
interface ResolvesTo {
  scriptId: string
  name: string
  version: string
}

/** Never throws: an already-saved schedule may legitimately point at a reference that no longer resolves (a version disabled, or deleted, after the schedule was saved). Returns the FULL row/entry (paramsSchema included) so `paramsCompatibility` below can reuse the same resolution `tryResolve` already does, rather than resolving twice. */
function tryResolveEntry(db: Db, scriptRef: string, registry?: ScriptRegistry): (ScriptRow | ScriptEntry) | null {
  const parsed = ScriptRefSchema.safeParse(scriptRef)
  if (!parsed.success) return null
  try {
    return registry ? registry.resolve(parsed.data) : resolveScriptRef(db, parsed.data)
  } catch {
    return null
  }
}

function tryResolve(db: Db, scriptRef: string, registry?: ScriptRegistry): ResolvesTo | null {
  const row = tryResolveEntry(db, scriptRef, registry)
  return row ? { scriptId: row.id, name: row.name, version: row.version } : null
}

/**
 * Plan 95 §4.4, §4.8, §5 step 95.7 — `paramsCompatible`/`paramsFindingCount`
 * on every `ScheduleInfo`, computed against what `scriptRef` resolves to
 * RIGHT NOW (never cached from the last firing): a schedule that WILL fail
 * is visible the moment the new script version is published, not the
 * morning after it silently enqueued nothing (see `ScheduleInfoSchema`'s own
 * doc comment for why this cannot be a stored column).
 *
 * Always compatible for an agent target (nothing to reconcile) and for a
 * reference that cannot resolve right now — an unresolvable `scriptRef` is
 * its OWN failure mode, surfaced through `resolvesTo: null` and, at the next
 * firing, a `schedule.failed` audit entry naming ITS code
 * (`script_not_found`, `script_disabled`, ...). Folding that into the params
 * badge would answer a different question than the one it asks ("are the
 * stored PARAMETERS still valid") with a misleading yes/no.
 */
function paramsCompatibility(
  db: Db,
  row: ScheduleRow,
  agentTarget: ScheduleAgentTargetRow | null,
  registry?: ScriptRegistry,
): { paramsCompatible: boolean; paramsFindingCount: number } {
  if (agentTarget) return { paramsCompatible: true, paramsFindingCount: 0 }
  const entry = tryResolveEntry(db, row.scriptRef, registry)
  if (!entry) return { paramsCompatible: true, paramsFindingCount: 0 }
  const { findings, blocking } = reconcileParams(entry.paramsSchema as JsonSchemaNode | null, row.params)
  return { paramsCompatible: !blocking, paramsFindingCount: findings.length }
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
  /** Plan 68 §4.2 — the agent side of dispatch; passed straight through to `schedules/runner.ts`'s `fireOnce`. Optional so a host without the agent series wired (or a test) simply cannot create an agent-target schedule. */
  agentDispatch?: ScheduleAgentDispatch
  /** Validates an agent id/slug at schedule-write time (plan 68 §4.2) — a schedule saved against an agent that does not exist would otherwise fail silently at its first firing. */
  agentExists?: (agentId: string) => boolean
  scheduledAgentCeilings?: () => ScheduledAgentCeilings
  notifySystem?: ScheduleRunnerDeps['notifySystem']
  /** Plan 82 §3.3, §3.5 — resolves through the registry so a schedule can target a plugin script and is refused (`script_is_dev`) for a dev-only one (criterion 18). `registry` above is the unrelated job EXECUTOR registry (`jobs/executor.ts`) — named `scriptRegistry` here to avoid colliding with it. Optional so every pre-plan-82 test keeps compiling unedited. */
  scriptRegistry?: ScriptRegistry
  /**
   * Plan 93 §3.12, §4.6, step 93.8 — live farm settings, threaded into
   * `validateScriptForRun` at both the CREATE/PATCH-time validation calls
   * below (an interactive request, actor role from `c.get('user')`) and into
   * `runnerDeps.validateScript` (no actor — cron/`run-now` firing, the same
   * "no interactive caller" reasoning `schedules/runner.ts` already states
   * for `assertDeviceAllowed`) so `JobExecutor.requires` binds for a
   * schedule exactly as it now does for a batch (`BatchRoutesDeps`'s own
   * identical pair). Optional so every pre-93.8 test keeps compiling
   * unedited.
   */
  shellMode?: () => ShellMode
  transferEnabled?: () => boolean
}

/** One `scheduleAgentTargets` row, or null for a script-kind schedule (plan 68 §4.1's companion-table discriminator). */
function getAgentTargetRow(db: Db, scheduleId: string): ScheduleAgentTargetRow | null {
  return db.select().from(scheduleAgentTargets).where(eq(scheduleAgentTargets.scheduleId, scheduleId)).get() ?? null
}

/** Batched, for the list endpoint — one query for a whole page rather than N. */
function loadAgentTargets(db: Db, scheduleIds: string[]): Map<string, ScheduleAgentTargetRow> {
  if (scheduleIds.length === 0) return new Map()
  const rows = db.select().from(scheduleAgentTargets).where(inArray(scheduleAgentTargets.scheduleId, scheduleIds)).all()
  return new Map(rows.map((r) => [r.scheduleId, r]))
}

function workTargetFor(row: ScheduleRow, agentTarget: ScheduleAgentTargetRow | null): ScheduleWorkTarget {
  if (agentTarget) return { kind: 'agent', agentId: agentTarget.agentId, prompt: agentTarget.prompt }
  return { kind: 'script', ref: row.scriptRef as ScriptRef, params: row.params ?? undefined }
}

function rowToScheduleInfo(deps: ScheduleRoutesDeps, row: ScheduleRow, agentTarget: ScheduleAgentTargetRow | null): ScheduleInfo {
  const { paramsCompatible, paramsFindingCount } = paramsCompatibility(deps.db, row, agentTarget, deps.scriptRegistry)
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled ?? true,
    cron: row.cron,
    timezone: row.timezone,
    target: workTargetFor(row, agentTarget),
    // Legacy fields (plan 62) — populated only for a script target; null for an agent one.
    scriptRef: agentTarget ? null : row.scriptRef,
    params: agentTarget ? null : row.params,
    groupId: row.groupId,
    deviceIds: (row.deviceIds as string[] | null) ?? [],
    concurrency: row.concurrency,
    order: row.order as BatchOrder,
    onOverlap: row.onOverlap as OnOverlap,
    queueTimeoutSec: row.queueTimeoutSec,
    catchUp: row.catchUp as CatchUp,
    jitterSec: row.jitterSec,
    priority: row.priority,
    repeatCount: row.repeatCount,
    intervalMinMs: row.intervalMinMs,
    intervalMaxMs: row.intervalMaxMs,
    deviceIntervalMs: row.deviceIntervalMs,
    threadMode: (agentTarget?.threadMode as ScheduleThreadMode | undefined) ?? 'new',
    threadId: agentTarget?.threadId ?? null,
    onApprovalRequired: (agentTarget?.onApprovalRequired as OnApprovalRequired | undefined) ?? 'deny',
    lastFiredAt: toSec(row.lastFiredAt),
    lastBatchId: row.lastBatchId,
    lastAgentRunId: agentTarget?.lastAgentRunId ?? null,
    createdBy: row.createdBy,
    createdAt: toSec(row.createdAt) ?? 0,
    nextFireAt: row.enabled ? (deps.runner.nextFires().get(row.id) ?? null) : null,
    paramsCompatible,
    paramsFindingCount,
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
    jitterMs: row.jitterMs,
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
    // Plan 93 §3.12, §4.6, step 93.8 — no `actorRole`: `run-now` (below) AND
    // the real cron-fired path both funnel through this same closure, and
    // neither has a stable per-request actor the way `POST /`/`PATCH /:id`
    // below do — `run-now`'s own interactive user is available at ITS call
    // site but not here, where `runnerDeps` is built once. `shellMode`/
    // `transferEnabled` still bind, so a farm-wide switch is still honoured
    // either way.
    validateScript: (scriptId, params) => validateScriptForRun(deps, scriptId, params),
    ...(deps.agentDispatch ? { agentDispatch: deps.agentDispatch } : {}),
    ...(deps.scheduledAgentCeilings ? { scheduledAgentCeilings: deps.scheduledAgentCeilings } : {}),
    ...(deps.notifySystem ? { notifySystem: deps.notifySystem } : {}),
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

  /**
   * Plan 93 §3.12, §4.6, step 93.8 — the interactive counterpart of
   * `runnerDeps.validateScript` above: these three call sites (`POST /`,
   * `PATCH /:id` x2) all have a real per-request user, so `JobExecutor.
   * requires`'s role half is actually enforced at schedule create/edit time
   * — the same "actor merged in per call" split `api/batches.ts`'s own
   * `validateScriptFor` uses.
   */
  const validateScriptFor = (user: { role: 'admin' | 'operator' } | undefined) => (scriptId: string, params: unknown) =>
    validateScriptForRun({ ...deps, actorRole: () => user?.role ?? null }, scriptId, params)

  const assertGroupExists = (target: z.infer<typeof ScheduleTargetSchema>): void => {
    if (!('groupId' in target)) return
    const row = db.select().from(groups).where(eq(groups.id, target.groupId)).get()
    if (!row) throw new EnkakuError('group_not_found', `no such group: ${target.groupId}`)
  }

  const assertCronValid = (cron: string, timezone: string): void => {
    const result = nextFires(cron, timezone, 1)
    if (!result.ok) throw new EnkakuError('E_BAD_REQUEST', `invalid cron expression: ${result.error}`)
  }

  /** Mirrors `POST /api/batches`'s own `pacing` refine (F34: the same shape, the same check). */
  const assertPacingValid = (intervalMinMs: number, intervalMaxMs: number): void => {
    if (intervalMinMs > intervalMaxMs) throw new EnkakuError('E_BAD_REQUEST', 'the interval range is inverted')
  }

  app.post('/validate', async (c) => {
    const body = ValidateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { cron, timezone } is required')
    const result = nextFires(body.data.cron, body.data.timezone, 5)
    if (!result.ok) return typedJson(c, ValidateResponseSchema, { valid: false, nextFires: [], error: result.error })
    return typedJson(c, ValidateResponseSchema, { valid: true, nextFires: result.value })
  })

  app.get('/', (c) => {
    const { cursor, limit } = parsePageQuery(c)
    const { rows, nextCursor, total } = querySchedulesRows(db, { cursor, limit })
    const agentTargets = loadAgentTargets(db, rows.map((r) => r.id))
    const items = rows.map((r) => rowToScheduleInfo(deps, r, agentTargets.get(r.id) ?? null))
    return c.json({ items, nextCursor, total })
  })

  /** Plan 68 §3.1, §4.2 — either the explicit `workTarget`, or (backward compatible) `scriptRef`/`params` treated as `{kind: 'script'}`. Exactly one of the two shapes must resolve, or the request is malformed. */
  const resolveWorkTargetInput = (body: z.infer<typeof ScheduleBody>): ScheduleWorkTarget => {
    if (body.workTarget) return body.workTarget
    if (!body.scriptRef) throw new EnkakuError('E_BAD_REQUEST', 'either workTarget or scriptRef is required')
    return { kind: 'script', ref: body.scriptRef, params: body.params }
  }

  const assertAgentTargetValid = (workTarget: ScheduleWorkTarget): void => {
    if (workTarget.kind !== 'agent') return
    if (!deps.agentExists || !deps.agentExists(workTarget.agentId)) {
      throw new EnkakuError('agent_not_found', `no such agent: ${workTarget.agentId}`)
    }
  }

  // `job.run` (plan 34 §4.4, §4.5) — there is no `job.manage` in the ACL
  // matrix; a schedule (and a batch, in `api/batches.ts`) is a way of
  // causing jobs to run, so it takes the same permission an operator already
  // has for running one job by hand — no lockout, one pattern.
  app.post('/', requirePermission('job.run'), async (c) => {
    const body = ScheduleBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    assertCronValid(body.data.cron, body.data.timezone)
    assertGroupExists(body.data.target)
    assertPacingValid(body.data.intervalMinMs, body.data.intervalMaxMs)
    const workTarget = resolveWorkTargetInput(body.data)
    assertAgentTargetValid(workTarget)

    // Resolved BEFORE the row is written (plan 62 §4.4) — a schedule created
    // on a reference that cannot resolve right now would be indistinguishable
    // from one saved correctly, until its first (silent) firing failure.
    // For an agent target, `scriptRef` is simply unused (`''`) — the
    // dispatcher branches on the presence of a `scheduleAgentTargets` row
    // before this column is ever read (plan 68 §4.2, `db/schema.ts`'s
    // `scheduleAgentTargets` doc comment).
    const resolved = workTarget.kind === 'script' ? (deps.scriptRegistry ? deps.scriptRegistry.resolve(workTarget.ref) : resolveScriptRef(db, workTarget.ref)) : null
    const validatedParams = workTarget.kind === 'script' ? validateScriptFor(c.get('user'))(resolved!.id, workTarget.params) : null

    const row: ScheduleRow = {
      id: crypto.randomUUID(),
      name: body.data.name,
      enabled: body.data.enabled,
      cron: body.data.cron,
      timezone: body.data.timezone,
      // Stored verbatim — never the resolved id (plan 62 §3.3, §3.2): a
      // `@latest` reference is meant to float on every future firing.
      scriptRef: workTarget.kind === 'script' ? workTarget.ref : '',
      params: workTarget.kind === 'script' ? (validatedParams ?? null) : null,
      groupId: 'groupId' in body.data.target ? body.data.target.groupId : null,
      deviceIds: 'deviceIds' in body.data.target ? body.data.target.deviceIds : null,
      concurrency: body.data.concurrency,
      order: body.data.order,
      onOverlap: body.data.onOverlap,
      queueTimeoutSec: body.data.queueTimeoutSec,
      catchUp: body.data.catchUp,
      jitterSec: body.data.jitterSec,
      priority: body.data.priority,
      repeatCount: body.data.repeatCount,
      intervalMinMs: body.data.intervalMinMs,
      intervalMaxMs: body.data.intervalMaxMs,
      deviceIntervalMs: body.data.deviceIntervalMs,
      lastFiredAt: null,
      lastBatchId: null,
      createdBy: c.get('user')?.id ?? null,
      createdAt: new Date(),
    }
    db.insert(schedules).values(row).run()

    let agentTargetRow: ScheduleAgentTargetRow | null = null
    if (workTarget.kind === 'agent') {
      agentTargetRow = {
        scheduleId: row.id,
        agentId: workTarget.agentId,
        prompt: workTarget.prompt,
        threadMode: body.data.threadMode,
        threadId: null,
        onApprovalRequired: body.data.onApprovalRequired,
        lastAgentRunId: null,
        createdAt: new Date(),
      }
      db.insert(scheduleAgentTargets).values(agentTargetRow).run()
    }

    deps.runner.reload()
    deps.audit.record({ userId: row.createdBy, action: 'schedule.create', target: row.id, meta: { name: row.name, cron: row.cron, kind: workTarget.kind } })
    // Echoes what a script reference resolves to RIGHT NOW (plan 62 §4.4), so the UI can show
    // "→ 2.0.0" without a second call — null for an agent target, which has nothing to resolve.
    const resolvesTo: ResolvesTo | null = resolved ? { scriptId: resolved.id, name: resolved.name, version: resolved.version } : null
    return typedJson(c, ScheduleResponseSchema, { schedule: rowToScheduleInfo(deps, row, agentTargetRow), resolvesTo }, 201)
  })

  app.get('/:id', (c) => {
    const row = mustGet(c.req.param('id'))
    const agentTarget = getAgentTargetRow(db, row.id)
    return typedJson(c, ScheduleResponseSchema, { schedule: rowToScheduleInfo(deps, row, agentTarget), resolvesTo: agentTarget ? null : tryResolve(db, row.scriptRef, deps.scriptRegistry) })
  })

  app.patch('/:id', requirePermission('job.run'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = SchedulePatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const nextCron = body.data.cron ?? row.cron
    const nextTimezone = body.data.timezone ?? row.timezone
    if (body.data.cron !== undefined || body.data.timezone !== undefined) assertCronValid(nextCron, nextTimezone)
    if (body.data.target !== undefined) assertGroupExists(body.data.target)
    if (body.data.intervalMinMs !== undefined || body.data.intervalMaxMs !== undefined) {
      assertPacingValid(body.data.intervalMinMs ?? row.intervalMinMs, body.data.intervalMaxMs ?? row.intervalMaxMs)
    }

    const patch: Partial<ScheduleRow> = {}
    if (body.data.name !== undefined) patch.name = body.data.name
    if (body.data.enabled !== undefined) patch.enabled = body.data.enabled
    if (body.data.cron !== undefined) patch.cron = body.data.cron
    if (body.data.timezone !== undefined) patch.timezone = body.data.timezone
    if (body.data.target !== undefined) {
      patch.groupId = 'groupId' in body.data.target ? body.data.target.groupId : null
      patch.deviceIds = 'deviceIds' in body.data.target ? body.data.target.deviceIds : null
    }

    // Plan 68 §3.1, §4.2 — switching (or updating) the WORK target. `existingAgentTarget` tracks the
    // live truth across this handler so the final response (and the trailing threadMode/
    // onApprovalRequired patch below) reads correctly either way.
    let existingAgentTarget = getAgentTargetRow(db, row.id)

    if (body.data.workTarget !== undefined) {
      const wt = body.data.workTarget
      if (wt.kind === 'script') {
        const resolved = deps.scriptRegistry ? deps.scriptRegistry.resolve(wt.ref) : resolveScriptRef(db, wt.ref)
        patch.scriptRef = wt.ref
        patch.params = validateScriptFor(c.get('user'))(resolved.id, wt.params) ?? null
        if (existingAgentTarget) {
          db.delete(scheduleAgentTargets).where(eq(scheduleAgentTargets.scheduleId, row.id)).run()
          existingAgentTarget = null
        }
      } else {
        assertAgentTargetValid(wt)
        if (existingAgentTarget) {
          db.update(scheduleAgentTargets).set({ agentId: wt.agentId, prompt: wt.prompt }).where(eq(scheduleAgentTargets.scheduleId, row.id)).run()
        } else {
          patch.scriptRef = '' // no longer used — see `scheduleAgentTargets`'s doc comment
          patch.params = null
          db.insert(scheduleAgentTargets)
            .values({
              scheduleId: row.id,
              agentId: wt.agentId,
              prompt: wt.prompt,
              threadMode: body.data.threadMode ?? 'new',
              threadId: null,
              onApprovalRequired: body.data.onApprovalRequired ?? 'deny',
              lastAgentRunId: null,
              createdAt: new Date(),
            })
            .run()
        }
        existingAgentTarget = getAgentTargetRow(db, row.id)
      }
    } else if ((body.data.scriptRef !== undefined || body.data.params !== undefined) && !existingAgentTarget) {
      // Legacy path (plan 62) — unchanged behaviour for an already-script-kind schedule.
      const scriptRef = body.data.scriptRef ?? row.scriptRef
      // Resolved BEFORE the row is written, same reasoning as POST above.
      const resolved = deps.scriptRegistry ? deps.scriptRegistry.resolve(scriptRef as ScriptRef) : resolveScriptRef(db, scriptRef as ScriptRef)
      patch.scriptRef = scriptRef
      patch.params = validateScriptFor(c.get('user'))(resolved.id, body.data.params ?? row.params) ?? null
    }

    if (existingAgentTarget && (body.data.threadMode !== undefined || body.data.onApprovalRequired !== undefined)) {
      const agentPatch: Partial<ScheduleAgentTargetRow> = {}
      if (body.data.threadMode !== undefined) agentPatch.threadMode = body.data.threadMode
      if (body.data.onApprovalRequired !== undefined) agentPatch.onApprovalRequired = body.data.onApprovalRequired
      db.update(scheduleAgentTargets).set(agentPatch).where(eq(scheduleAgentTargets.scheduleId, row.id)).run()
    }

    if (body.data.concurrency !== undefined) patch.concurrency = body.data.concurrency
    if (body.data.order !== undefined) patch.order = body.data.order
    if (body.data.onOverlap !== undefined) patch.onOverlap = body.data.onOverlap
    if (body.data.queueTimeoutSec !== undefined) patch.queueTimeoutSec = body.data.queueTimeoutSec
    if (body.data.catchUp !== undefined) patch.catchUp = body.data.catchUp
    if (body.data.jitterSec !== undefined) patch.jitterSec = body.data.jitterSec
    if (body.data.priority !== undefined) patch.priority = body.data.priority
    if (body.data.repeatCount !== undefined) patch.repeatCount = body.data.repeatCount
    if (body.data.intervalMinMs !== undefined) patch.intervalMinMs = body.data.intervalMinMs
    if (body.data.intervalMaxMs !== undefined) patch.intervalMaxMs = body.data.intervalMaxMs
    if (body.data.deviceIntervalMs !== undefined) patch.deviceIntervalMs = body.data.deviceIntervalMs

    if (Object.keys(patch).length > 0) db.update(schedules).set(patch).where(eq(schedules.id, row.id)).run()
    deps.runner.reload()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'schedule.update', target: row.id, meta: { patch: Object.keys(patch) } })
    const finalRow = mustGet(row.id)
    const finalAgentTarget = getAgentTargetRow(db, row.id)
    return typedJson(c, ScheduleResponseSchema, { schedule: rowToScheduleInfo(deps, finalRow, finalAgentTarget), resolvesTo: finalAgentTarget ? null : tryResolve(db, finalRow.scriptRef, deps.scriptRegistry) })
  })

  app.delete('/:id', requirePermission('job.run'), (c) => {
    const row = mustGet(c.req.param('id'))
    db.delete(scheduleAgentTargets).where(eq(scheduleAgentTargets.scheduleId, row.id)).run()
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
    return typedJson(c, ScheduleRunsPageResponseSchema, { items, nextCursor, total })
  })

  // Ignores the cron — fires right now — but still honours onOverlap unless
  // the operator explicitly overrides it (plan 21 §9 open question #2).
  app.post('/:id/run-now', requirePermission('job.run'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const agentTargetBefore = getAgentTargetRow(db, row.id)
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
    if (!latest || latest.outcome !== 'dispatched') {
      throw new EnkakuError('E_NOT_DISPATCHED', latest?.detail ?? `run-now did not dispatch (${latest?.outcome ?? 'unknown'})`)
    }

    if (agentTargetBefore) {
      // Plan 68 §4.2 — an agent-target firing produces a RUN, not a batch.
      const updatedTarget = getAgentTargetRow(db, row.id)
      if (!updatedTarget?.lastAgentRunId) throw new EnkakuError('E_NOT_DISPATCHED', latest.detail ?? 'run-now did not dispatch')
      deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'schedule.run-now', target: row.id, meta: { runId: updatedTarget.lastAgentRunId } })
      return c.json({ run: { runId: updatedTarget.lastAgentRunId, threadId: updatedTarget.threadId } })
    }

    if (!latest.batchId) throw new EnkakuError('E_NOT_DISPATCHED', latest.detail ?? 'run-now did not dispatch')
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
