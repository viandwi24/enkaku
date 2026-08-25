import { join, normalize } from 'node:path'
import { Hono } from 'hono'
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  BatchArtifactsResponseSchema,
  BatchResponseSchema,
  BatchStopResponseSchema,
  BatchWithJobsResponseSchema,
  BatchesPageResponseSchema,
  defaultFarmSettings,
  reconcileParams,
  SkippedDeviceSchema,
  type BatchArtifactInfo,
  type BatchCounts,
  type BatchInfo,
  type BatchOrder,
  type BatchStatusEvent,
  type BatchStatusValue,
  type JobSettings,
  type JsonSchemaNode,
  type ShellMode,
} from '@enkaku/protocol'
import { canCancelJob, canUseDevice } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Role } from '../auth/service'
import { createBatch, type BatchDispatchDeps } from '../clusters/dispatch'
import type { BatchPacer } from '../clusters/pacer'
import { computeBatchStatus, countJobs, recomputeBatchStatus, TERMINAL_BATCH_STATUSES } from '../clusters/status'
import type { Db } from '../db'
import { artifacts, batches, devices, scripts, type BatchRow, type JobRow } from '../db/schema'
import type { ExecutorRegistry } from '../jobs/executor'
import { validateScriptForRun } from '../jobs/validate-script'
import { rowToJobInfo, type JobStore } from '../queue/job-store'
import { formatDeviceLabel, loadDeviceNumbers } from '../registry/device-number'
import type { Scheduler } from '../queue/scheduler'
import type { ScriptRegistry } from '../scripts/registry'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'
import { createZipStream, ZipTooLargeError, type ZipEntryInput } from './zip-stream'

const CreateBatchBody = z.object({
  scriptId: z.string().min(1),
  params: z.unknown(),
  target: z.union([z.object({ clusterId: z.string().min(1) }), z.object({ deviceIds: z.array(z.string()).min(1) })]),
  concurrency: z.number().int().min(0).default(0),
  order: z.enum(['as-listed', 'random']).default('as-listed'),
  priority: z.number().int().optional(),
  /**
   * Plan 98 §3.8, step 98.7 — the operator's own per-batch runtime layer,
   * shared by every member job (`clusters/dispatch.ts`'s `createBatch`
   * resolves it once for the whole batch, same as `scriptId`/`params`
   * above). `unknown` for the identical reason `api/jobs.ts`'s own
   * `EnqueueBody.runtimeOverride` is: `createBatch()` is the one place that
   * validates it against `RuntimeEnvelopeSchema`
   * (`E_RUNTIME_ENVELOPE_INVALID`) and checks it against the farm's own
   * ceiling (`E_RUNTIME_OVER_CEILING`, mapped to 400 below), so this body
   * declares no second shape. This gap closed per
   * docs/plans/96-m61-hotfixes.md, continuing that document's numbering.
   */
  runtimeOverride: z.unknown().optional(),
  /**
   * Plan 94 §3.7, §4.8, §4.9, step 94.7 — absent (or `count: 1` with every
   * interval `0`) means today's behaviour exactly: one repetition, no
   * delay, no stagger — so every existing caller (plan 93's bulk actions
   * included) is unaffected. `intervalMs[0] <= intervalMs[1]` is enforced
   * here, at the boundary, rather than left for `createBatch`/the pacer to
   * discover.
   */
  pacing: z
    .object({
      count: z.number().int().min(1).max(1000).default(1),
      intervalMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([0, 0]),
      deviceIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
    })
    .refine((p) => p.intervalMs[0] <= p.intervalMs[1], 'the interval range is inverted')
    .optional(),
})

const ERROR_STATUS: Record<string, number> = {
  batch_not_found: 404,
  cluster_not_found: 404,
  E_BAD_REQUEST: 400,
  E_NO_TARGETS: 409,
  unknown_script: 400,
  script_disabled: 409,
  invalid_job_params: 400,
  // A state conflict, not a malformed request (plan 95 §4.4, §5 step 95.7):
  // the ORIGINAL params were fine when the batch was created; the schema
  // moved out from under them since. 409, matching E_NO_TARGETS's own
  // "cannot proceed as configured right now" family, not 400's "you sent me
  // something wrong".
  params_incompatible: 409,
  E_DB: 500,
  'auth.forbidden': 403,
  // Plan 98 §3.3 S1, §3.8, §4.5, steps 98.6/98.7 — `clusters/dispatch.ts`'s
  // `createBatch()` throws these three by name, the SAME codes
  // `api/jobs.ts`'s own `ERROR_STATUS` already maps for a standalone
  // enqueue (that file's own comment explains why each is genuinely a 400).
  // This map was missing all three until now: this file's own `onError`
  // below maps any UNLISTED `EnkakuError.code` to 500, so a batch dispatch
  // that hit the version gate, a malformed override, or an over-ceiling
  // override surfaced as an opaque 500 rather than the coded 400 an
  // operator (and Studio's own error handling) expects — found auditing the
  // runtimeOverride gap this same commit closes, fixed here in the file that
  // already owns this map. docs/plans/96-m61-hotfixes.md, continuing that
  // document's numbering.
  E_RUNTIME_UNSUPPORTED: 400,
  E_RUNTIME_ENVELOPE_INVALID: 400,
  E_RUNTIME_OVER_CEILING: 400,
  // Plan 93 §3.13, §4.4, §4.7, step 93.10 — `GET /:id/artifacts.zip`'s own
  // pre-flight cap (`zip-stream.ts`'s `ZipTooLargeError`, re-thrown as this
  // coded error below): refused BEFORE the first byte, so this status code
  // is the only thing the caller ever sees for it — never a truncated body.
  E_TRANSFER_TOO_LARGE: 413,
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
  /**
   * Plan 95 §4.4, §5 step 95.7 — read through for `rerun-failed`'s params
   * schema lookup (`paramsSchemaFor` below), not for dispatch: `registry`
   * above is the unrelated job EXECUTOR registry, named `scriptRegistry`
   * here to avoid colliding with it, exactly as `ScheduleRoutesDeps` already
   * does. Optional so every pre-95.7 test keeps compiling unedited and
   * falls back to a direct `scripts` table read.
   */
  scriptRegistry?: ScriptRegistry
  /**
   * Plan 98 §3.7, §3.8, §4.1, §4.6, §4.7 — live `job` farm settings, threaded
   * into `clusters/dispatch.ts`'s `createBatch()` (`BatchDispatchDeps.
   * farmJobSettings`, already accepted there but never reachable through
   * this route until now). Optional and additive, the same graceful
   * degradation every other unwired accessor in this codebase has: omitted,
   * `createBatch()` falls back to its own `DEFAULT_FARM_JOB_SETTINGS` (every
   * `job.*` field at its built-in default, including "no ceiling" on
   * `maxTimeoutMs`/`memory.maxRssBytes`) — the exact behaviour before this
   * field existed.
   *
   * **Found, not yet fully closed, while wiring `runtimeOverride`'s farm
   * ceiling check onto a batch (docs/plans/96-m61-hotfixes.md, continuing
   * that document's numbering)**: without this getter actually being called
   * with a LIVE farm settings function, `E_RUNTIME_OVER_CEILING` can never
   * fire for a batch's own override, no matter how large — the ceiling
   * always resolves to "none" (`JobSettingsSchema`'s own defaults:
   * `maxTimeoutMs: null`, `memory.maxRssBytes: null`). `daemon.ts`'s own
   * `createBatchRoutes({...})` call site does not pass this key today (that
   * file is outside this fix's ownership — see this plan's own file-scope
   * note) — wiring `farmJobSettings: () => settingsStore.get().job` there,
   * the identical accessor `daemon.ts` already builds for `services/
   * job-service.ts`'s own `createJobService({...})` call, is the one
   * remaining step to make a batch's farm ceiling bind for real.
   */
  farmJobSettings?: () => JobSettings
  /**
   * Plan 94 §3.7, §3.8, §4.8, step 94.7 — optional like every other
   * accessor above: unwired (a test harness with no interest in pacing), a
   * `pacing` block on the request body is still stored on the batch row
   * (`createBatch` writes it unconditionally) but repetition 0 never gets
   * its stagger and no further repetition is ever planned — the same
   * graceful-degradation shape `deps.pacer` has in `BatchDispatchDeps`
   * itself.
   */
  pacer?: BatchPacer
  /**
   * Plan 94 §3.9, §4.9, step 94.8 — `POST /:id/stop`'s ONLY abort path for a
   * `running` member (§3.9 rule 3, "no second abort path"): `JobService.
   * cancel()` already owns the device-ownership-aware abort/escalation logic
   * (`services/job-service.ts`) — a parallel implementation here would drift
   * from it the first time either changes. `Pick<..., 'cancel'>` rather than
   * the full interface: this route needs nothing else from it. Optional like
   * every other accessor above: a test harness with no interest in stopping
   * gets `E_BAD_REQUEST` from `/stop` rather than a hard crash; every real
   * host (`daemon.ts`) wires the same `jobService` instance it already
   * builds for `createJobRoutes`.
   */
  jobService?: Pick<JobService, 'cancel'>
  /**
   * Plan 93 §3.12, §4.6, step 93.8 — live farm settings, threaded into
   * `validateScriptForRun` at every dispatch call site below (`POST /`,
   * `POST /:id/rerun-failed`, `POST /:id/rerun`) so `JobExecutor.requires`
   * actually binds against the REAL farm rather than always resolving to
   * "not evaluated". Optional so every pre-93.8 test keeps compiling
   * unedited — omitted, an `internal:install` batch dispatches exactly as it
   * did before this step (F10, closed here).
   */
  shellMode?: () => ShellMode
  transferEnabled?: () => boolean
  /**
   * Plan 93 §3.13, §4.4, §4.7, step 93.10 — the app-data root `GET
   * /:id/artifacts.zip` resolves each artifact's stored RELATIVE path
   * against (the same convention `api/artifacts.ts`'s own `/:id/content`
   * uses). Optional like every other accessor above: a test harness with no
   * interest in the archive route never calls it — `GET /:id/artifacts`
   * (the metadata listing) needs no file access at all and works either
   * way; only the `.zip` route requires this and refuses cleanly when it is
   * absent.
   */
  dataDir?: string
  /**
   * Plan 93 §3.13, §4.1, §4.7, step 93.10 — live `transfer` farm settings,
   * read for `maxArchiveBytes` only (`zip-stream.ts`'s own pre-flight cap).
   * Optional, same graceful-degradation shape as `shellMode`/
   * `transferEnabled` above: unwired, the archive route falls back to the
   * protocol's own default (2 GiB) rather than refusing to build ANY
   * archive.
   */
  archiveSettings?: () => { maxArchiveBytes: number }
}

/**
 * Exactly the members {@link createBatchDispatchDeps} reads — so a host that
 * is not building this router at all (plan 108 §4.5, step 108.5's plugin
 * action executor) can call the same factory without inventing a `jobStore`,
 * a broadcaster or a `scriptNames` lookup it has no use for.
 */
export type BatchDispatchHostDeps = Pick<
  BatchRoutesDeps,
  'db' | 'scheduler' | 'audit' | 'registry' | 'findScript' | 'scriptRegistry' | 'farmJobSettings' | 'pacer' | 'shellMode' | 'transferEnabled'
>

/**
 * The ONE construction of `clusters/dispatch.ts`'s `BatchDispatchDeps`. Every
 * dispatch route in this file calls it, and so does `daemon.ts`'s
 * `createPluginRoutes({ actions: { batch } })` wiring (plan 108 §4.5, step
 * 108.5) — so a batch dispatched from a plugin screen and one dispatched from
 * the Batches page are gated by literally the same closures, never by two
 * copies of one object literal that drift.
 *
 * It absorbs the two per-request helpers this file used to build inline —
 * `validateScriptFor` (plan 93 §3.12, §4.6, step 93.8: `validateScriptForRun`
 * merged with the REQUESTING user's role, closing F10's `internal:install`
 * escalation) and `assertDeviceAllowedFor` (`canUseDevice`, plan 34 §3.5,
 * §4.4: an operator targeting a device they do not own refuses the WHOLE
 * batch before a row is written) — plus the three farm-wide accessors
 * (`scriptNameOf`, `farmJobSettings`, `pacer`) the same literal carried.
 *
 * `actor` is per REQUEST, not per router, which is why this is a function and
 * not a field on `deps`: one gate needs the caller's role, the other their
 * identity. `null`/`undefined` means there is no interactive caller — a
 * schedule firing at cron time (`schedules/runner.ts`) — and then neither
 * gate applies, exactly as before.
 */
export function createBatchDispatchDeps(
  deps: BatchDispatchHostDeps,
  actor: { id: string; role: Role } | null | undefined,
): BatchDispatchDeps {
  return {
    db: deps.db,
    scheduler: deps.scheduler,
    audit: deps.audit,
    onJobStatus: () => {},
    validateScript: (scriptId, params) => validateScriptForRun({ ...deps, actorRole: () => actor?.role ?? null }, scriptId, params),
    assertDeviceAllowed: (deviceId) => {
      if (!actor) return
      const row = deps.db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, deviceId)).get()
      if (row && !canUseDevice(actor, row)) {
        throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
      }
    },
    // Plan 98 §3.7, §4.4, §4.6, step 98.5 — a batch member denormalises
    // `scriptName`/`scriptVersion` and resolves `runtime.maxConcurrent`
    // exactly the way a standalone enqueue does (`services/job-service.ts`'s
    // own `scriptNameOf` wiring in `daemon.ts`).
    scriptNameOf: (scriptId) => deps.scriptRegistry?.get(scriptId) ?? null,
    // Plan 98 §3.7, §3.8, §4.1, §4.6, §4.7 — see `BatchRoutesDeps.
    // farmJobSettings`'s own comment: without a LIVE accessor here a batch's
    // `runtimeOverride` ceiling check can never refuse anything.
    farmJobSettings: deps.farmJobSettings,
    pacer: deps.pacer,
  }
}

/**
 * The CURRENT params schema for a concrete `scripts.id` (plan 95 §5 step
 * 95.7) — read through `scriptRegistry` when wired (covers a dev-slot
 * script, whose schema can be redefined under the same stable id between a
 * batch's original run and a later rerun-failed — plan 82 §3.3), or a
 * direct read of the `scripts` table otherwise. Never throws: an unknown
 * scriptId (the script was deleted since the batch ran) resolves to `null`,
 * which `reconcileParams` treats as "no schema, nothing to reconcile".
 */
function paramsSchemaFor(db: Db, scriptId: string, registry?: ScriptRegistry): unknown {
  if (registry) return registry.get(scriptId)?.paramsSchema ?? null
  return db.select({ paramsSchema: scripts.paramsSchema }).from(scripts).where(eq(scripts.id, scriptId)).get()?.paramsSchema ?? null
}

/** Exported so `api/schedules.ts`'s `run-now` can build the same `BatchInfo` shape without a second implementation. */
/**
 * Plan 94 §3.7, §4.8, step 94.7 — `null` when the row's own pacing columns
 * are today's default (`repeatCount: 1`, every interval `0`): an unpaced
 * batch and a batch dispatched before this plan both read identically.
 */
/**
 * Plan 93 §3.12, §4.2, §4.6, step 93.8 — `row.skipped` is an untyped JSON
 * column (`db/schema.ts`'s `text('skipped', {mode: 'json'})`, no `$type<>()`
 * pinned), so it is validated through the wire schema here rather than
 * `as`-cast (00-overview §4's rule for anything crossing a DB-JSON boundary).
 * `[]` for `null` (no skips, or a pre-93.8 batch) — never a distinct
 * "unknown" state.
 */
function skippedOf(row: BatchRow): BatchInfo['skipped'] {
  const parsed = z.array(SkippedDeviceSchema).safeParse(row.skipped ?? [])
  return parsed.success ? parsed.data : []
}

function pacingOf(row: BatchRow): BatchInfo['pacing'] {
  if (row.repeatCount <= 1 && row.deviceIntervalMs <= 0 && row.intervalMinMs <= 0 && row.intervalMaxMs <= 0) return null
  return {
    repeatCount: row.repeatCount,
    intervalMinMs: row.intervalMinMs,
    intervalMaxMs: row.intervalMaxMs,
    deviceIntervalMs: row.deviceIntervalMs,
  }
}

/**
 * Plan 94 §3.9, §4.8, step 94.8 — `row.status` is the single source of truth
 * for `'stopping'`: nothing derives it from job counts (`computeBatchStatus`
 * never produces it), and it is held exactly as long as
 * `clusters/status.ts`'s `recomputeBatchStatus` holds it — until every
 * member has actually reached a terminal state. Once it has, `row.status`
 * itself has already moved on (that recompute is the only thing that ever
 * writes it away), so this simply mirrors the row rather than re-deriving
 * anything.
 *
 * **`docs/plans/96-m61-hotfixes.md` §96.30 — `counts.total === 0` is handled
 * FIRST, before the `stopping` hold above ever gets a chance to apply.**
 * `clusters/dispatch.ts`'s `createBatch` is the only writer of a `batches`
 * row and always inserts it together with >= 1 job row, in the same
 * transaction (`E_NO_TARGETS` refuses before anything is persisted
 * otherwise) — so an EXISTING row can only read `counts.total === 0` because
 * every one of its job rows was deleted afterward (`device/lifecycle.ts`'s
 * `forget({ deleteHistory: true })` is the one path found), never because it
 * has not been dispatched yet — that shape cannot outlive `createBatch`'s
 * own transaction. `computeBatchStatus`'s own `total === 0 → 'queued'`
 * branch exists for a hypothetical batch-before-jobs-exist that this
 * codebase never actually persists; applying it here would report a
 * non-terminal status FOREVER for a row that will never settle again —
 * exactly as immortal as the `stopping` hold two lines down, just silent
 * about it (this is `recomputeBatchStatus`'s OWN write-time fix for the
 * identical shape; this function is the READ-time half, so it heals a row
 * that is stuck in the database RIGHT NOW, on the very next `GET`, with no
 * migration and no backfill). It resolves to `cancelled` — terminal — since
 * a batch with no jobs left has none to wait on, regardless of what status
 * it was heading toward.
 */
function statusOf(row: BatchRow, counts: BatchCounts): BatchStatusValue {
  if (counts.total === 0) return 'cancelled'
  const computed = computeBatchStatus(counts)
  if (row.status === 'stopping' && !TERMINAL_BATCH_STATUSES.includes(computed)) return 'stopping'
  return computed
}

/**
 * F30 — "includes expired members" (acceptance criterion 19). A job that
 * timed out in queue (`jobs.status: 'expired'`, plan 21 §3.3) never ran at
 * all, which is exactly the same "this device did not get its work done"
 * outcome a `failed` job represents from an operator's point of view — a
 * rerun that only looked at `failed` silently gave up on every device that
 * lost the race against `expiresAt` instead of ever running the script.
 * Deduplicated: a paced batch can have several job rows (different
 * repetitions) for the same device, and this step's own trap (d) means the
 * rerun targets DEVICES, once each, never repetitions — see
 * `carryForwardShape`'s own doc comment for why the pacing carried forward
 * is the batch's own full shape rather than "however many repetitions this
 * device still owed".
 */
const RERUN_TARGET_STATUSES = new Set(['failed', 'expired'])

function failedOrExpiredDeviceIds(jobRows: JobRow[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const j of jobRows) {
    if (!RERUN_TARGET_STATUSES.has(j.status ?? '')) continue
    if (seen.has(j.deviceId)) continue
    seen.add(j.deviceId)
    ids.push(j.deviceId)
  }
  return ids
}

/**
 * Plan 94 §5 step 94.11 (F30, acceptance criterion 19) — the ONE place both
 * rerun routes below (`POST /:id/rerun-failed`, `POST /:id/rerun`) read the
 * original batch's own pacing/priority/queue-timeout shape from, so they
 * cannot diverge later the way this whole session's dominant defect class
 * did (correct, tested code whose sibling call site never got the same
 * treatment, 21+ instances) — copy this function's CALLERS, never its body.
 *
 * **`priority`** carries forward unchanged. It lives on every member job
 * row, not the batch (`db/schema.ts`'s `batches` table has no `priority`
 * column of its own — `jobs.priority` is where `createBatch` actually
 * writes it, uniformly, for every member), so it is read off the ORIGINAL
 * batch's own job rows rather than re-derived. `0` (the farm default) for a
 * batch with no members at all — cannot happen for a real rerun (both
 * callers already refuse with `E_NO_TARGETS` before reaching this
 * function), kept only so this function has no partial-input footgun.
 *
 * **`expiresAt` is deliberately NOT copied verbatim (trap b).** It is an
 * absolute unix-seconds instant (`jobs.expires_at`, plan 21 §3.3), and by
 * the time anyone reruns a batch its original queue-timeout deadline has
 * almost certainly already passed — copying the raw value would make every
 * rerun job expire the instant it is queued: a rerun that reports "success"
 * (`201`, a new batch created) while dispatching work that can never
 * actually run, silently. What carries forward is the POLICY, not the
 * instant: the original queue timeout's own DURATION (`original expiresAt -
 * the original batch's own createdAt`), re-applied from THIS rerun's own
 * `now`. A batch with no queue timeout at all (`expiresAt: null` on every
 * member) reruns with none either — "wait forever" is itself a policy, and
 * it survives unchanged. Tested explicitly for the already-expired case.
 *
 * **Pacing carries forward as the ORIGINAL batch's own full shape** — same
 * `count`/`intervalMs`/`deviceIntervalMs` — applied to the rerun's own
 * (failed-device-only) target (trap d: "rerun the failed devices, not the
 * failed repetitions"). The alternative reading — "count = however many
 * repetitions were still owed" — was considered and rejected: an operator
 * re-running a paced batch's failures is asking "redo this device's whole
 * run", not "resume it from wherever it broke", and a single device can
 * fail on repetition 2, succeed on repetition 3, and fail again on
 * repetition 4 — "how many repetitions are still owed" has no single
 * well-defined answer for that device, while "redo the whole thing" always
 * does. **The stagger restarts from THIS dispatch's own "now" for free
 * (trap c)**: `createBatch` calls `deps.pacer.planFirst` at the moment IT
 * runs, keyed off the pacer's own clock, never the original batch's
 * `createdAt` — this function does not (and must not) try to re-derive or
 * pass through a stagger origin itself; it only carries the SHAPE
 * (`count`/`intervalMs`/`deviceIntervalMs`), never a timestamp.
 */
function carryForwardShape(
  row: BatchRow,
  jobRows: JobRow[],
  now: Date,
): { priority: number; expiresAt: number | null; pacing: { count: number; intervalMs: [number, number]; deviceIntervalMs: number } | null } {
  const priority = jobRows[0]?.priority ?? 0
  const originalExpiresAt = jobRows[0]?.expiresAt ?? null
  const nowSec = Math.floor(now.getTime() / 1000)
  let expiresAt: number | null = null
  if (originalExpiresAt != null) {
    const createdAtSec = toSec(row.createdAt) ?? nowSec
    const durationSec = Math.max(0, originalExpiresAt - createdAtSec)
    expiresAt = nowSec + durationSec
  }
  const pacing = pacingOf(row)
  return {
    priority,
    expiresAt,
    pacing: pacing
      ? { count: pacing.repeatCount, intervalMs: [pacing.intervalMinMs, pacing.intervalMaxMs], deviceIntervalMs: pacing.deviceIntervalMs }
      : null,
  }
}

export function rowToBatchInfo(deps: BatchRoutesDeps, row: BatchRow): BatchInfo {
  const jobs = deps.jobStore.listByBatch(row.id)
  const counts = countJobs(jobs)
  const script = deps.scriptNames([row.scriptId]).get(row.scriptId) ?? null
  const pacing = pacingOf(row)
  // Plan 94 §3.8, §4.8, step 94.7 — "rowToBatchInfo reports planned/completed
  // repetitions per device." Rendering it is Studio's own surface, step
  // 94.10 — this is the wire shape it will read, not built there.
  const repeats = pacing
    ? Array.from(new Set(jobs.map((j) => j.deviceId))).map((deviceId) => ({
        deviceId,
        completed: jobs.filter((j) => j.deviceId === deviceId).length,
        planned: pacing.repeatCount,
      }))
    : []
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
    // never stale even if a broadcast was missed (plan 20 §3.5). `row.status`
    // can now be `'stopping'` (plan 94 §3.9, §4.8, step 94.8's own value,
    // written directly by `POST /:id/stop`, never derived from job counts) —
    // this mirrors `clusters/status.ts`'s `recomputeBatchStatus`'s OWN "held
    // until every member is terminal" rule exactly (`TERMINAL_BATCH_STATUSES`,
    // imported from there rather than redefined here), so a page load mid-stop
    // reads `stopping` instead of misreporting `running`/`queued`.
    status: statusOf(row, counts),
    createdBy: row.createdBy,
    createdAt: toSec(row.createdAt) ?? 0,
    finishedAt: toSec(row.finishedAt),
    counts,
    pacing,
    repeats,
    skipped: skippedOf(row),
  }
}

/** Result of {@link stopBatch} — always present, never a partial shape (plan 94 §3.9, §4.9). */
export interface StopBatchResult {
  cancelled: number
  aborted: number
  refused: number
  refusedDeviceIds: string[]
}

/**
 * Deps `stopBatch` needs — a subset of `BatchRoutesDeps`, so `schedules/
 * runner.ts` (which owns no `Hono` app and builds its own deps shape) can
 * call it with exactly what it already has, rather than constructing a full
 * route-deps object just to reach one function (plan 94 §3.9, step 94.8:
 * "`onOverlap: 'cancel-previous'` uses the same stop").
 */
export interface StopBatchDeps {
  db: Db
  jobStore: JobStore
  broadcastBatchStatus: (msg: BatchStatusEvent) => void
  jobService?: Pick<JobService, 'cancel'>
}

/**
 * The one stop path (plan 94 §3.9, §4.8/§4.9, step 94.8) — used by both
 * `POST /:id/stop` below and `schedules/runner.ts`'s `onOverlap:
 * 'cancel-previous'`, so a paced batch cancelled by a schedule firing again
 * stops exactly as thoroughly as an operator's own Stop button. In order:
 *
 * 1. Mark the batch `stopping` FIRST — what the pacer's `onMemberSettled`
 *    reads (`NON_PLANNING_STATUS`, checked before anything else there) — so
 *    there is no window, in any interleaving, where a settling member's
 *    repetition sneaks in after this call started (§3.9's own argument).
 * 2. Walk every member that is still `queued` or `running`. `actor === null`
 *    means "no interactive caller" (a schedule firing at cron time, exactly
 *    like `assertDeviceAllowedFor`'s own `if (!user) return` above) — every
 *    member is allowed. An `actor` gates PER MEMBER by `canCancelJob` (F27):
 *    refused members are counted and named, never silently skipped.
 * 3. Every allowed member — queued or running alike — goes through the
 *    EXACT SAME `JobService.cancel()` path a standalone `POST /api/jobs/:id/
 *    cancel` uses (§3.9 rule 3, "no second abort path"): `cancel()` itself
 *    branches on the job's own current status (`cancelQueued` vs. aborting a
 *    live executor, falling back to `finishExternally`), so this function
 *    never re-implements either branch.
 * 4. Recompute the batch status once, at the end, from whatever actually
 *    happened — never assumed from the per-member counts above, since a
 *    member could have settled on its own between step 2's snapshot and
 *    step 3's cancel.
 *
 * No `jobService` wired (a test harness with no interest in stopping):
 * every member is counted `refused` rather than silently doing nothing —
 * honest about doing zero work, never a false `cancelled`/`aborted`.
 */
export function stopBatch(deps: StopBatchDeps, batchId: string, actor: { id: string; role: Role } | null): StopBatchResult {
  // Step 1 — first, per the ordering argument above.
  deps.db.update(batches).set({ status: 'stopping' }).where(eq(batches.id, batchId)).run()

  const members = deps.jobStore.listByBatch(batchId)
  const result: StopBatchResult = { cancelled: 0, aborted: 0, refused: 0, refusedDeviceIds: [] }

  for (const member of members) {
    if (member.status !== 'queued' && member.status !== 'running') continue

    if (actor) {
      const deviceRow = deps.db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, member.deviceId)).get()
      if (!canCancelJob(actor, deviceRow ?? null)) {
        result.refused += 1
        result.refusedDeviceIds.push(member.deviceId)
        continue
      }
    }

    if (!deps.jobService) {
      result.refused += 1
      result.refusedDeviceIds.push(member.deviceId)
      continue
    }

    const wasQueued = member.status === 'queued'
    try {
      deps.jobService.cancel(member.id)
      if (wasQueued) result.cancelled += 1
      else result.aborted += 1
    } catch {
      // The job settled on its own between the listing above and this call
      // (`job_not_cancellable`) — not this stop's doing, so it counts toward
      // none of the three buckets; the final recompute below still tallies
      // it correctly either way.
    }
  }

  recomputeBatchStatus({ db: deps.db, jobStore: deps.jobStore, broadcast: deps.broadcastBatchStatus }, batchId)
  return result
}

/** Same slugging `api/artifacts.ts`'s own upload route uses for a filename — kept local rather than shared, since the two callers slug two different kinds of string (a device label here, an upload's own label there) and neither wants the other's `|| 'upload'`/`|| 'device'` fallback. */
const slugLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'device'

/** One collected-files row (before it is shaped into the wire `BatchArtifactInfo`) — carries the artifact's stored RELATIVE `path` too, which the metadata route (`GET /:id/artifacts`) never returns but the archive route (`GET /:id/artifacts.zip`) needs to actually open the file. */
interface CollectedArtifact extends BatchArtifactInfo {
  path: string
  /**
   * `devices.label` VERBATIM — no number, no `#` (plan 124 §3.7).
   *
   * The wire `deviceLabel` above is now the composed, human form (`#7 Pixel
   * 6`), which is what every UI naming this row should show. The ZIP route
   * below must NOT use it: its entry names are `<label-slug>-<stableId>/…`,
   * and slugging `#7 Pixel 6` would rewrite every archive path the moment a
   * farm allocated numbers — silently changing filenames operators and
   * scripts already depend on, for no gain (`stableId`, which is already in
   * the path, is the disambiguator there, and it is exact). Plan 124 §3.7
   * names this one site explicitly: "a `#` in a filename is a new problem."
   *
   * Internal only — like `path`, it is destructured off before the metadata
   * route answers, so it never reaches `BatchArtifactSchema`.
   */
  rawDeviceLabel: string
}

/**
 * `GET /api/batches/:id/artifacts` and `.../artifacts.zip`'s shared query
 * (plan 93 §3.13, §4.4, §4.7, step 93.10) — a plain join from the batch's
 * own member jobs through `artifacts.jobId` (F12's fix, step 93.9: a pull
 * performed by a job now stamps that job's id onto the artifact it
 * produced), denormalising the CURRENT device label/stableId at read time
 * rather than trusting anything cached on the artifact row itself.
 */
function collectBatchArtifacts(db: Db, jobStore: JobStore, batchId: string): CollectedArtifact[] {
  const jobRows = jobStore.listByBatch(batchId)
  if (jobRows.length === 0) return []
  const jobIds = jobRows.map((j) => j.id)
  const deviceIdByJobId = new Map(jobRows.map((j) => [j.id, j.deviceId]))

  const artifactRows = db.select().from(artifacts).where(inArray(artifacts.jobId, jobIds)).all()
  if (artifactRows.length === 0) return []

  const deviceIds = Array.from(new Set(artifactRows.map((a) => a.deviceId ?? deviceIdByJobId.get(a.jobId ?? '')).filter((id): id is string => !!id)))
  const deviceRows = deviceIds.length
    ? db.select({ id: devices.id, label: devices.label, stableId: devices.stableId }).from(devices).where(inArray(devices.id, deviceIds)).all()
    : []
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]))
  // stableId → number for the WHOLE fleet, in ONE statement (plan 124 §3.7,
  // plan 19 §4.3's no-N+1 rule) — a batch of 45 devices producing four
  // artifacts each would otherwise take 180 `lookupDeviceNumber` calls to
  // answer one listing. Loaded only when there is at least one device to name;
  // a batch whose artifacts are all non-device-scoped never touches
  // `device_numbers` at all.
  const numbers = deviceIds.length ? loadDeviceNumbers(db) : new Map<string, number>()

  const out: CollectedArtifact[] = []
  for (const row of artifactRows) {
    const deviceId = row.deviceId ?? deviceIdByJobId.get(row.jobId ?? '') ?? null
    if (!row.jobId || !deviceId) continue // not a device-scoped pull artifact — nothing this route reports on
    const device = deviceById.get(deviceId)
    // The device id is the last-resort name for a device row that is GONE —
    // a forgotten device's artifacts outlive it, and a blank cell would be
    // worse than a uuid. It has no number by definition, so the composed and
    // the raw forms are the same string in that case.
    const rawLabel = device?.label ?? deviceId
    out.push({
      artifactId: row.id,
      jobId: row.jobId,
      deviceId,
      // Composed here, on the server, rather than shipped as a second
      // `deviceNumber` field for the UI to compose (plan 124 §3.7): this row
      // outlives the device that produced it, so a Studio table rendering an
      // artifact from a forgotten device holds no `DeviceInfo` to compose
      // against — a split field would be null exactly where it is needed.
      deviceLabel: formatDeviceLabel(device ? (numbers.get(device.stableId) ?? null) : null, rawLabel),
      rawDeviceLabel: rawLabel,
      stableId: device?.stableId ?? deviceId,
      filename: row.label ?? row.path.split('/').pop() ?? 'file',
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : 0,
      contentUrl: `/api/artifacts/${row.id}/content`,
      path: row.path,
    })
  }
  return out
}

/**
 * Batch create, list, detail, stop, rerun-failed (plan 20 §4.6; plan 94 §3.9
 * replaces `cancel` with `stop`). Cluster membership is resolved once, at
 * creation — the report is built from the batch's own jobs, never
 * re-resolved (plan 20 §3.1, §8 risk table).
 */
export function createBatchRoutes(deps: BatchRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  const mustGet = (id: string): BatchRow => {
    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    if (!row) throw new EnkakuError('batch_not_found', `no such batch: ${id}`)
    return row
  }

  // Every dispatch route below (`POST /`, `POST /:id/rerun-failed`, `POST
  // /:id/rerun`) builds its `BatchDispatchDeps` through the ONE exported
  // factory above, with the requesting user as the actor — an interactive
  // request always has one (`authMiddleware` guarantees it); the
  // schedule-fired path in `schedules/runner.ts` deliberately has none.
  const dispatchDepsFor = (user: { id: string; role: Role } | undefined): BatchDispatchDeps => createBatchDispatchDeps(deps, user)

  // `job.run` (plan 34 §4.4, §4.5) — there is no `job.manage` in the ACL
  // matrix; a batch (like a schedule in `api/schedules.ts`) is a way of
  // causing jobs to run, so every route below takes the same permission an
  // operator already has for running one job by hand.
  app.post('/', requirePermission('job.run'), async (c) => {
    const body = CreateBatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const { batch } = createBatch(dispatchDepsFor(c.get('user')), {
      ...body.data,
      pacing: body.data.pacing ?? null,
      createdBy: c.get('user')?.id ?? null,
    })
    return typedJson(c, BatchResponseSchema, { batch: rowToBatchInfo(deps, batch) }, 201)
  })

  app.get('/', (c) => {
    const { cursor, limit } = parsePageQuery(c)
    const { rows, nextCursor, total } = queryBatchRows(db, { cursor, limit })
    const items = rows.map((r) => rowToBatchInfo(deps, r))
    return typedJson(c, BatchesPageResponseSchema, { items, nextCursor, total })
  })

  app.get('/:id', (c) => {
    const row = mustGet(c.req.param('id'))
    const jobRows = deps.jobStore.listByBatch(row.id)
    const names = deps.scriptNames(jobRows.map((j) => j.scriptId))
    return typedJson(c, BatchWithJobsResponseSchema, {
      batch: rowToBatchInfo(deps, row),
      jobs: jobRows.map((j) => rowToJobInfo(j, names.get(j.scriptId) ?? null)),
    })
  })

  // "End Task" must mean *end* (plan 94 §3.9, §4.9, step 94.8) — REPLACES
  // `POST /:id/cancel` (00-overview §4.3: not kept beside it — "cancel some
  // of it" was never a useful verb, and F26 is why it read like a bug):
  // cancels every queued member, aborts every running one through
  // `JobService.cancel` (no second abort path), and marks the batch
  // `stopping` FIRST so the pacer never plans another repetition, in any
  // interleaving. Gated per member by `canCancelJob` (F27) — an operator
  // stops exactly the members they could have stopped individually; the
  // rest are refused and COUNTED, never silently skipped.
  app.post('/:id/stop', requirePermission('job.run'), (c) => {
    const row = mustGet(c.req.param('id'))
    const user = c.get('user')
    const actor = user ? { id: user.id, role: user.role } : null
    const result = stopBatch(deps, row.id, actor)
    deps.audit.record({ userId: user?.id ?? null, action: 'batch.stop', target: row.id, meta: result })
    return typedJson(c, BatchStopResponseSchema, result)
  })

  // A new batch over the failed devices — `params` is copied verbatim from
  // the original (plan 20 §9 open question #4: the common case is a flaky
  // device, not wrong parameters). "Verbatim" now means *reconciled*
  // verbatim (plan 95 §4.4, §5 step 95.7): `row.scriptId` is a concrete,
  // immutable version (plan 62 §3.3), so its schema cannot itself have
  // moved — EXCEPT for a dev-slot script (plan 82 §3.3), whose schema can be
  // redefined under the SAME stable id between the batch's original run and
  // this rerun. Rerun-failed has no form and no human reviewing the
  // parameters before they run again, so it takes the unattended discipline
  // (plan 95 §4.4): a blocking finding refuses the whole rerun rather than
  // re-enqueuing jobs against parameters that no longer satisfy the schema;
  // a non-blocking one (a field reset to its new default, a stale field the
  // schema no longer declares dropped) is applied automatically — the raw
  // stored value would otherwise still fail `createBatch`'s own param
  // validation for the exact field reconciliation just repaired.
  app.post('/:id/rerun-failed', requirePermission('job.run'), (c) => {
    const row = mustGet(c.req.param('id'))
    const jobRows = deps.jobStore.listByBatch(row.id)
    const failedDeviceIds = failedOrExpiredDeviceIds(jobRows)
    if (failedDeviceIds.length === 0) {
      throw new EnkakuError('E_NO_TARGETS', 'this batch has no failed or expired jobs to re-run')
    }

    const paramsSchema = paramsSchemaFor(db, row.scriptId, deps.scriptRegistry)
    const reconciliation = reconcileParams(paramsSchema as JsonSchemaNode | null, row.params)
    if (reconciliation.blocking) {
      const blocking = reconciliation.findings.filter((f) => f.kind === 'invalid' || f.kind === 'missing')
      throw new EnkakuError(
        'params_incompatible',
        `this batch's stored parameters no longer satisfy its script's current schema: ${blocking.map((f) => `${f.path} (${f.detail})`).join('; ')}`,
        undefined,
        blocking.map((f) => ({ path: f.path, message: f.detail })),
      )
    }

    // F30, acceptance criterion 19 — `carryForwardShape` is the ONE place
    // this (and `/:id/rerun` below) reads priority/queue-timeout/pacing
    // from; see its own doc comment for why `expiresAt` is a re-applied
    // DURATION rather than the raw stored instant, and why pacing carries
    // the original batch's FULL shape onto the failed devices rather than
    // "however many repetitions each one still owed".
    const shape = carryForwardShape(row, jobRows, new Date())

    const { batch } = createBatch(
      // Same gates as the plain create route above — a rerun-failed batch
      // member is bound by the SAME role/ownership checks and the SAME
      // farm-wide cap a freshly dispatched one would get.
      dispatchDepsFor(c.get('user')),
      {
        scriptId: row.scriptId,
        params: reconciliation.value,
        target: { deviceIds: failedDeviceIds },
        concurrency: row.concurrency,
        order: row.order as BatchOrder,
        priority: shape.priority,
        expiresAt: shape.expiresAt,
        pacing: shape.pacing,
        createdBy: c.get('user')?.id ?? null,
      },
    )
    return typedJson(c, BatchResponseSchema, { batch: rowToBatchInfo(deps, batch) }, 201)
  })

  /**
   * Plan 93 §3.12, §4.4, §4.6, step 93.8, closing F11's other half —
   * `?only=failed` is `POST /:id/rerun-failed` under a second name (kept as
   * an additive sibling, not a replacement: `/rerun-failed` is a stable,
   * documented route this step's file-scope does not touch); `?only=skipped`
   * is the NEW capability — retargets exactly the devices `batches.skipped`
   * named (an offline phone that came back, say), never the whole original
   * target, so "why didn't these six run?" has a one-click answer that
   * dispatches ONLY those six. Same reconciliation, same gate order
   * (`job.run` + the executor's declared `requires`, via `validateScriptFor`)
   * as every other dispatch route in this file — no second door.
   */
  app.post('/:id/rerun', requirePermission('job.run'), (c) => {
    const row = mustGet(c.req.param('id'))
    const only = c.req.query('only')
    if (only !== 'failed' && only !== 'skipped') {
      throw new EnkakuError('E_BAD_REQUEST', 'query param "only" must be "failed" or "skipped"')
    }

    const jobRows = deps.jobStore.listByBatch(row.id)
    // F30's fix applies here too (this step's own §5.11 "fix the class, not
    // the reported instance" — `?only=failed` is the exact sibling call site
    // named by trap (a)): the SAME `failedOrExpiredDeviceIds` helper
    // `/rerun-failed` uses, so an expired member is never invisible to this
    // route just because it arrived under a different name.
    const targetDeviceIds = only === 'failed' ? failedOrExpiredDeviceIds(jobRows) : skippedOf(row).map((s) => s.deviceId)
    if (targetDeviceIds.length === 0) {
      throw new EnkakuError(
        'E_NO_TARGETS',
        only === 'failed' ? 'this batch has no failed or expired jobs to re-run' : 'this batch skipped no devices to re-run',
      )
    }

    const paramsSchema = paramsSchemaFor(db, row.scriptId, deps.scriptRegistry)
    const reconciliation = reconcileParams(paramsSchema as JsonSchemaNode | null, row.params)
    if (reconciliation.blocking) {
      const blocking = reconciliation.findings.filter((f) => f.kind === 'invalid' || f.kind === 'missing')
      throw new EnkakuError(
        'params_incompatible',
        `this batch's stored parameters no longer satisfy its script's current schema: ${blocking.map((f) => `${f.path} (${f.detail})`).join('; ')}`,
        undefined,
        blocking.map((f) => ({ path: f.path, message: f.detail })),
      )
    }

    // Same carry-forward this file's `/rerun-failed` route uses — see
    // `carryForwardShape`'s own doc comment. Applied to BOTH `only=failed`
    // and `only=skipped`: a skipped-device retarget is exactly as much "the
    // same run, over a subset of devices" as a failed-device rerun is, and
    // this is the one function either branch reads from, so they cannot
    // drift from each other or from `/rerun-failed` later.
    const shape = carryForwardShape(row, jobRows, new Date())

    const { batch } = createBatch(
      dispatchDepsFor(c.get('user')),
      {
        scriptId: row.scriptId,
        params: reconciliation.value,
        target: { deviceIds: targetDeviceIds },
        concurrency: row.concurrency,
        order: row.order as BatchOrder,
        priority: shape.priority,
        expiresAt: shape.expiresAt,
        pacing: shape.pacing,
        createdBy: c.get('user')?.id ?? null,
      },
    )
    return typedJson(c, BatchResponseSchema, { batch: rowToBatchInfo(deps, batch) }, 201)
  })

  /**
   * The collected-files listing (plan 93 §3.13, §4.4, step 93.10) —
   * `job.view`, the same gate `GET /:id` itself uses (batch-scoped read, not
   * a mutation). One row per device-scoped pull artifact the batch's member
   * jobs produced; `contentUrl` reuses `GET /api/artifacts/:id/content`
   * unchanged, so a single-file download needs no new endpoint.
   */
  app.get('/:id/artifacts', requirePermission('job.view'), (c) => {
    const row = mustGet(c.req.param('id'))
    const collected = collectBatchArtifacts(db, deps.jobStore, row.id)
    // `path` and `rawDeviceLabel` are internal to `CollectedArtifact` (see its
    // own comment) — destructured off here so neither can reach the wire.
    const items: BatchArtifactInfo[] = collected.map(({ path: _path, rawDeviceLabel: _rawDeviceLabel, ...rest }) => rest)
    return typedJson(c, BatchArtifactsResponseSchema, { items })
  })

  /**
   * One stored (uncompressed) zip of every file the batch's own pulls
   * collected (plan 93 §3.13, §4.7, step 93.10) — entries named
   * `<device-label-slug>-<stableId>/<original-filename>`: the label first
   * because that is how an operator thinks, the FULL `stableId` appended
   * (never shortened — two phones sharing a label is exactly the case this
   * exists for) because that is what keeps two same-labelled, same-filename
   * pulls from landing in the same directory.
   *
   * The label slugged into those names is `rawDeviceLabel` — `devices.label`
   * verbatim — NEVER the wire `deviceLabel`, which since plan 124 §3.7
   * carries the composed `#7 Pixel 6` form. That section names this exact
   * site as the one place in the plan to leave alone: the number belongs in
   * every surface that NAMES a device to a human, and in no filename. Slugging
   * it here would rewrite every archive path as soon as a farm allocated
   * numbers (`pixel-6-…` → `7-pixel-6-…`), breaking whatever an operator or a
   * downstream script already unpacks by name, and buying nothing — the FULL
   * `stableId` already sits in the same path and is exact where a number is
   * merely short. Keep these two `slugLabel(...)` calls on `rawDeviceLabel`.
   *
   * The `maxArchiveBytes` refusal happens INSIDE `createZipStream`, before
   * this handler writes a single byte of the response — `zip-stream.ts`'s
   * own module doc explains why that ordering is load-bearing: once a
   * status line has been sent there is no way to turn it into a 413.
   */
  app.get('/:id/artifacts.zip', requirePermission('job.view'), (c) => {
    const row = mustGet(c.req.param('id'))
    const collected = collectBatchArtifacts(db, deps.jobStore, row.id)
    const dataDir = deps.dataDir
    const maxTotalBytes = deps.archiveSettings?.().maxArchiveBytes ?? defaultFarmSettings().transfer.maxArchiveBytes

    const entries: ZipEntryInput[] = collected.map((item) => {
      // Defence in depth against a stored path escaping app-data, mirroring
      // `api/artifacts.ts`'s own `/:id/content` check — the DB row is
      // trusted today (only `registerDeviceArtifact` ever writes it), but a
      // download route is exactly where a future regression there would
      // first become exploitable.
      const rel = normalize(item.path)
      if (!dataDir || rel.startsWith('..')) {
        return { name: `${slugLabel(item.rawDeviceLabel)}-${item.stableId}/${item.filename}`, size: 0, open: () => new ReadableStream({ start: (c2) => c2.close() }) }
      }
      return {
        name: `${slugLabel(item.rawDeviceLabel)}-${item.stableId}/${item.filename}`,
        size: item.sizeBytes ?? 0,
        open: () => Bun.file(join(dataDir, rel)).stream(),
      }
    })

    let stream: ReadableStream<Uint8Array>
    try {
      stream = createZipStream(entries, { maxTotalBytes })
    } catch (err) {
      if (err instanceof ZipTooLargeError) throw new EnkakuError('E_TRANSFER_TOO_LARGE', err.message)
      throw err
    }
    return new Response(stream, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="batch-${row.id}-artifacts.zip"`,
      },
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
