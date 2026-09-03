import { and, asc, eq, inArray } from 'drizzle-orm'
import type { JobInfo, JobSettings, RuntimeClamp, RuntimeEnvelope } from '@enkaku/protocol'
import { checkRuntimeMajor, JobSettingsSchema, resolveRuntime, RuntimeEnvelopeSchema } from '@enkaku/protocol'
import type { Db } from '../db'
import { batches, clusters, devices, jobs, type BatchRow, type JobRow } from '../db/schema'
import type { AuditLogger } from '../auth/audit'
import { rowToJobInfo } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import { resolveCluster, resolveTarget, type ResolvedCluster } from './resolve'
import type { BatchPacer } from './pacer'

/**
 * Plan 98 §3.7, §4.1, §4.6, step 98.5 — mirrors `services/job-service.ts`'s
 * own (module-private, un-importable from here — a second worker owns that
 * file) `DEFAULT_FARM_JOB_SETTINGS` constant exactly: both are
 * `JobSettingsSchema.parse({})`, a pure call into the SAME `@enkaku/protocol`
 * schema, so there is nothing for the two to diverge on even though the text
 * is duplicated. Stands in for live `settingsStore.get().job` when
 * `deps.farmJobSettings` is not wired (a test harness, or a host built
 * before this closed).
 */
const DEFAULT_FARM_JOB_SETTINGS: JobSettings = JobSettingsSchema.parse({})

/**
 * Plan 98 §3.7, §4.4, §4.6, step 98.5 (closed here; was left explicitly
 * unbuilt in `toJobRow`'s own comment below, and in
 * `docs/plans/96-m61-hotfixes.md`) — the SAME resolution
 * `services/job-service.ts`'s own (private) `resolveJobRuntime` applies to a
 * standalone `enqueue()`/`resume()`, reimplemented here rather than imported
 * (a second worker owned that file when this was written) but NOT a second
 * ALGORITHM: both do nothing but forward into `resolveRuntime` from
 * `@enkaku/protocol` — the one place `maxConcurrent`'s precedence
 * (`override ?? script ?? 0`) actually lives.
 *
 * Widened for the gap closed by this same commit (docs/plans/96-m61-hotfixes.md,
 * continuing that document's numbering): a batch now carries its own
 * per-batch `runtimeOverride`, shared by every member job exactly like
 * `scriptId`/`params` already are (one operator instruction for the whole
 * dispatch, not per-device) — so this now returns `overrideClamps` too,
 * mirroring `resolveJobRuntime`'s own contract exactly: the caller refuses
 * with `E_RUNTIME_OVER_CEILING` on a non-empty result rather than clamping,
 * the SAME asymmetric §3.8 rule a standalone enqueue already applies. If
 * `resolveRuntime` ever grows a farm layer for `maxConcurrent` (it has none
 * today — see that function's own doc), both call sites pick it up
 * identically with no further change needed here, because both go through
 * the same shared function.
 */
function resolveBatchRuntime(
  deps: { farmJobSettings?: () => JobSettings },
  scriptRuntime: RuntimeEnvelope | null,
  override: RuntimeEnvelope | null,
): { maxConcurrent: number; overrideClamps: RuntimeClamp[] } {
  const farm = deps.farmJobSettings?.() ?? DEFAULT_FARM_JOB_SETTINGS
  const { resolved, clamps } = resolveRuntime({ farm, script: scriptRuntime, override })
  return { maxConcurrent: resolved.maxConcurrent, overrideClamps: clamps.filter((c) => c.from === 'override') }
}

/**
 * Shape-validates the batch's own per-batch runtime override (plan 98 §3.8,
 * this gap closed per docs/plans/96-m61-hotfixes.md) against the SAME
 * `RuntimeEnvelopeSchema` `services/job-service.ts`'s own (module-private)
 * `parseRuntimeOverrideInput` validates a standalone job's override
 * against — reimplemented rather than imported for the identical
 * file-ownership reason `resolveBatchRuntime` above states. `raw` is
 * `unknown` for the same reason `CreateBatchInput.runtimeOverride` is: it
 * crosses the same external boundary `params` does, validated HERE rather
 * than trusted from whatever built the input. Unlike the job-service
 * sibling, an unknown key here is silently stripped rather than logged with
 * a `warn` — this file carries no `log` dependency (§3.3 S3's tolerance
 * still applies: an unknown field never refuses).
 */
function parseBatchRuntimeOverride(raw: unknown): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(raw ?? null)
  if (!parsed.success) {
    throw new EnkakuError(
      'E_RUNTIME_ENVELOPE_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    )
  }
  return parsed.data
}

/** `E_RUNTIME_OVER_CEILING` (plan 98 §3.8) — naming every offending field, its requested value and the ceiling it exceeded, mirroring `services/job-service.ts`'s own `overCeilingError`. */
function overBatchCeilingError(clamps: RuntimeClamp[]): EnkakuError {
  return new EnkakuError(
    'E_RUNTIME_OVER_CEILING',
    clamps.map((c) => `runtimeOverride.${c.field} (${c.requested}) exceeds the farm ceiling of ${c.ceiling}`).join('; '),
  )
}

export interface CreateBatchInput {
  scriptId: string
  params: unknown
  target: { clusterId: string } | { deviceIds: string[] }
  concurrency: number
  order: 'as-listed' | 'random'
  priority?: number
  createdBy?: string | null
  /**
   * Plan 98 §3.8, step 98.7 — the operator's own per-BATCH runtime layer,
   * shared by every member job exactly like `scriptId`/`params` above (one
   * instruction for the whole dispatch, not resolved per device). `unknown`
   * for the same reason `services/job-service.ts`'s own `enqueue()` input
   * carries it as `unknown`: it crosses the same external boundary `params`
   * does, validated inside `createBatch()` against `RuntimeEnvelopeSchema`
   * (`parseBatchRuntimeOverride` below), never trusted from the caller.
   * Omitted/`null`/`undefined` all mean "no override for this batch",
   * identical to a batch dispatched before this field existed. This gap
   * closed per docs/plans/96-m61-hotfixes.md, continuing that document's
   * numbering.
   */
  runtimeOverride?: unknown
  /**
   * Plan 21 §3.3, §4.2 — unix seconds; the queue-timeout reaper expires a
   * `queued` job past this deadline. Null/omitted means "wait forever". This
   * lives on the job, not the batch, because the same question applies to any
   * job regardless of what created it — a schedule just happens to be the
   * first caller that sets it (`now + queueTimeoutSec`).
   */
  expiresAt?: number | null
  /**
   * Plan 94 §3.7, §4.8, §4.9, step 94.7 — the batch's own repeat/stagger
   * config. `null`/omitted (every caller before this plan, and every caller
   * that never sends `pacing` on `POST /api/batches`) is written as
   * `repeatCount: 1`, every interval `0` — today's behaviour exactly, and
   * `deps.pacer?.planFirst` below is then a deliberate no-op (`isPaced`,
   * `clusters/pacer.ts`).
   */
  pacing?: { count: number; intervalMs: [number, number]; deviceIntervalMs: number } | null
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
  /**
   * Plan 82 §3.4, plan 98 §3.7, §4.4, §4.6, step 98.5 (closed here,
   * docs/plans/96-m61-hotfixes.md) — the SAME `ScriptRegistry`-backed lookup
   * `daemon.ts` already wires into `services/job-service.ts`'s own
   * `scriptNameOf` (`scriptRegistry.get(scriptId)`, an identical return
   * shape: `{ name, version, runtime }`), now reachable from batch dispatch
   * too. Closes TWO gaps `toJobRow`'s own comment used to document
   * separately, because they share one root cause — this file had no
   * `ScriptRegistry` in its dependency graph at all:
   *
   *   1. `scriptName`/`scriptVersion` on a batch member's row, denormalised
   *      exactly like a standalone job's (plan 82 §3.4) — previously always
   *      `null` here, falling back to the "old way"
   *      (`scriptNames()`'s `scripts` table lookup).
   *   2. `runtime.maxConcurrent`'s claim-time gate (`queue/job-store.ts`'s
   *      `claimNext`) correlates running siblings with
   *      `r.script_name = j.script_name` — SQL's `=` never matches
   *      `NULL = NULL`, so with (1) left unfixed a batch member's
   *      `script_name` stays NULL forever and the correlated `COUNT(*)`
   *      would silently count ZERO running siblings no matter how many
   *      actually are, regardless of what `maxConcurrent` says. Resolving
   *      `maxConcurrent` correctly while leaving (1) broken would be worse
   *      than leaving both null — a cap that LOOKS configured but the claim
   *      gate can never see, the same "the fix makes the inconsistency
   *      worse, not better" shape this repo's `workflow.maxTotalMs` gap hit
   *      on the very same day (`jobs/executors/workflow.ts`'s own doc).
   *
   * Optional so every pre-existing test/caller keeps compiling unedited;
   * omitted, a batch member resolves to `scriptName: null`,
   * `maxConcurrent: 0` — both still read as "unlimited" (`0`/`NULL` are
   * equivalent to `claimNext`'s gate, `queue/job-store.ts`'s own comment),
   * so this is not a behaviour change from the pre-fix `null`.
   */
  scriptNameOf?: (scriptId: string) => { name: string; version: string; runtime?: RuntimeEnvelope | null } | null
  /**
   * Live `job` farm settings, read fresh on every call — the same
   * freshness contract `services/job-service.ts`'s own `farmJobSettings`
   * promises (F25). `maxConcurrent` itself has no farm layer to read yet
   * (see `resolveBatchMemberMaxConcurrent`'s own comment above), so
   * omitting this resolves identically to a live farm at every `job.*`
   * default — kept for parity with `job-service.ts`'s call shape, and so a
   * future farm ceiling on `maxConcurrent` needs no further change here.
   */
  farmJobSettings?: () => JobSettings
  /**
   * Plan 94 §3.7, §3.8, §4.8, step 94.7 — optional, like every other
   * accessor above: unwired (every pre-94.7 test, and any caller with no
   * interest in pacing), `createBatch` writes the batch's pacing columns
   * exactly as `input.pacing` describes them but never calls `planFirst`,
   * so repetition 0's `notBefore`/`batchRepeat`/`pacedDelayMs` stay at
   * today's values (null/null/null) — the same fallback shape every other
   * optional dependency in this file already has.
   */
  pacer?: BatchPacer
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
  /** Plan 82 §3.4 — denormalised exactly like a standalone job's, resolved once per batch (see `createBatch` below), not per member. `null` when `deps.scriptNameOf` is not wired (a test harness with no interest in this — falls back to the pre-fix behaviour: resolved the "old way" through `scriptNames()`'s `scripts` table lookup). */
  scriptName: string | null
  scriptVersion: string | null
  /** Plan 98 §3.7, §4.4, §4.6, step 98.5 (closed here) — resolved once per batch via `resolveBatchRuntime`, same as `scriptName`/`scriptVersion` above. `0` ("unlimited" — `queue/job-store.ts`'s own "0/NULL = unlimited" comment) when no script declares a cap OR `deps.scriptNameOf` is not wired — the exact same fallback shape `services/job-service.ts`'s `enqueue()` already has when ITS `scriptNameOf` is unwired. */
  maxConcurrent: number
  /** Plan 98 §3.8, step 98.7 (closed here) — the validated, resolved per-batch override, pinned onto every member row exactly like `params` above: a later change to the farm's ceiling must never reach an already-queued batch member (spec §11.6). `null` when the batch carried none. */
  runtimeOverride: RuntimeEnvelope | null
}): JobRow {
  return {
    id: crypto.randomUUID(),
    scriptId: input.scriptId,
    deviceId: input.deviceId,
    params: input.params ?? null,
    priority: input.priority,
    status: 'queued',
    heartbeatExpiresAt: null,
    result: null,
    error: null,
    createdAt: input.now,
    startedAt: null,
    finishedAt: null,
    batchId: input.batchId,
    batchSeq: input.batchSeq,
    expiresAt: input.expiresAt,
    failureClass: null,
    errorPhase: null,
    infraAttempts: 0,
    scriptName: input.scriptName,
    scriptVersion: input.scriptVersion,
    // Plan 81 §4.1 — a batch member is created directly, never via
    // `ctx.jobs.trigger()`, so it has no lineage: it is its own root, at
    // depth 0, with no trigger key.
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    triggerKey: null,
    peakRssBytes: null,
    maxConcurrent: input.maxConcurrent,
    // Plan 98 §3.8, §4.4, step 98.7 (closed here) — the SAME validated
    // override every sibling member gets, pinned at dispatch exactly like
    // `services/job-service.ts`'s own `enqueue()` pins `input.runtimeOverride`.
    runtimeOverride: input.runtimeOverride,
    // Plan 94 §3.8, §4.8, step 94.6 — a freshly dispatched batch member is
    // not paced: nothing writes a non-null value here until 94.7's pacer
    // exists (this step adds only the column and `claimNext`'s predicate).
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    // Plan 97 §3.3, §4.4 — a freshly dispatched batch member has not settled
    // yet, same as an ordinary `enqueue()` (`queue/job-store.ts`): NULL until
    // the settle path writes a real verdict.
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
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

  // Resolved ONCE for the whole batch, not per member — every job row below
  // shares the same `input.scriptId` (plan 82 §3.4, plan 98 §3.7/§4.6 step
  // 98.5, both closed here; see `BatchDispatchDeps.scriptNameOf`'s own
  // comment for why these two are fixed together). `named` mirrors
  // `services/job-service.ts`'s own `enqueue()`/`resume()` local of the same
  // name, resolved through the identical accessor shape.
  const named = deps.scriptNameOf?.(input.scriptId) ?? null

  // Plan 98 §3.3 S1, §4.5, step 98.6 (closed here, audited 2026-08-13) — the
  // version gate, checked the instant `named` resolves, before any target is
  // touched and before a single job row is built: the identical
  // `checkRuntimeMajor(named?.runtime?.sdk)` shape `services/job-service.ts`'s
  // `enqueue()` and `jobs/triggers.ts`'s `trigger()` already apply to the
  // SAME `named` local. `createBatch` is a FOURTH write path onto `jobs` and,
  // until this line, was the one write path this plan's own acceptance
  // criterion 11 ("never claims a device") did not actually reach — recorded
  // as a known gap in this step's own status paragraph, closed here rather
  // than left open now that `named` is resolvable at all (98.5's own
  // `docs/plans/96-m61-hotfixes.md` §96.14 fix). `named` is `null` when
  // `deps.scriptNameOf` is not wired (a test harness, or a caller — see that
  // paragraph's own "hidden dependency" note about `schedules/runner.ts` —
  // built before this accessor existed), and `checkRuntimeMajor(undefined)`
  // never refuses, matching every other write path's "an unwired accessor
  // never turns a farm mid-upgrade into a farm that runs nothing" contract.
  const versionCheck = checkRuntimeMajor(named?.runtime?.sdk)
  if (versionCheck) throw new EnkakuError(versionCheck.code, versionCheck.message)

  // Plan 98 §3.8, step 98.7 (closed here) — shape-validated, then resolved
  // ALONGSIDE `maxConcurrent` through the SAME `resolveRuntime` call, and
  // refused with `E_RUNTIME_OVER_CEILING` before the batch (or a single
  // member row) is ever written, mirroring `services/job-service.ts`'s own
  // `enqueue()` ordering exactly (validated, then resolved, then refused —
  // all before any row is written).
  const runtimeOverride = parseBatchRuntimeOverride(input.runtimeOverride)
  const { maxConcurrent, overrideClamps } = resolveBatchRuntime(deps, named?.runtime ?? null, runtimeOverride)
  if (overrideClamps.length > 0) throw overBatchCeilingError(overrideClamps)

  const expiresAt = input.expiresAt ?? null
  const jobRows = ordered.map((t, i) =>
    toJobRow({
      scriptId: input.scriptId,
      deviceId: t.deviceId,
      params: validatedParams,
      priority,
      batchId,
      batchSeq: i,
      now,
      expiresAt,
      scriptName: named?.name ?? null,
      scriptVersion: named?.version ?? null,
      maxConcurrent,
      runtimeOverride,
    }),
  )

  // Plan 94 §3.7, §4.8, step 94.7 — `null`/omitted `pacing` writes exactly
  // today's values (`repeatCount: 1`, every interval `0`), matching the
  // `batches` table's own column defaults for every pre-94.7 caller.
  const pacing = input.pacing ?? null

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
        repeatCount: pacing?.count ?? 1,
        intervalMinMs: pacing?.intervalMs[0] ?? 0,
        intervalMaxMs: pacing?.intervalMs[1] ?? 0,
        deviceIntervalMs: pacing?.deviceIntervalMs ?? 0,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        finishedAt: null,
        // Plan 93 §3.12, §4.2, §4.6, step 93.8, closing F11 — every device
        // that was in the resolved target but never got a job row, with why.
        // `resolved.skipped` was already computed above (it decides
        // `E_NO_TARGETS` when EVERY match is unusable) and used to be thrown
        // away into the audit `meta` field below — now it is also persisted,
        // so an operator can see "17 of 20 — 3 were offline" on the batch
        // itself, not only in the audit log. `null` (not `[]`) for a target
        // with no skips, matching the column's own "null unless status =
        // 'skipped'"-shaped convention (`db/schema.ts`'s own doc comment).
        skipped: resolved.skipped.length > 0 ? resolved.skipped : null,
      })
      .run()
    for (const row of jobRows) tx.insert(jobs).values(row).run()
  })

  const batch = db.select().from(batches).where(eq(batches.id, batchId)).get()
  if (!batch) throw new EnkakuError('E_DB', 'batch insert did not persist')

  // Plan 94 §3.8, §4.8, step 94.7 — repetition 0's stagger, baked into
  // `notBefore`/`pacedDelayMs`/`batchRepeat` for every member job just
  // inserted above. A deliberate no-op when `deps.pacer` is unwired or the
  // batch carries no pacing at all (`BatchPacer.planFirst`'s own guard).
  deps.pacer?.planFirst(batchId)

  // Re-read: `planFirst` above may have moved `notBefore`/`pacedDelayMs`/
  // `batchRepeat` off the in-memory `jobRows` built before it ran — the
  // caller's response, and the `job.status` broadcast below, must show what
  // was actually written, not the pre-stagger snapshot.
  const finalJobRows = deps.pacer ? db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.batchSeq)).all() : jobRows

  deps.audit.record({
    userId: input.createdBy ?? null,
    action: 'job.run',
    target: batchId,
    meta: { scriptId: input.scriptId, deviceCount: jobRows.length, order: input.order, skipped: resolved.skipped },
  })
  for (const row of finalJobRows) deps.onJobStatus(rowToJobInfo(row))
  deps.scheduler.kick()

  return { batch, jobs: finalJobRows }
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
 * Picks the lowest-`batchSeq` sibling device that is currently `online` with
 * no running job of its own (plan 205 §4.6, §4.7 — "busy" is no longer a
 * stored status; a device is only eligible when neither condition excludes
 * it, the same pair `claimNext`'s SQL checks) and not the device the job
 * just failed on. Returns null when none is available — the caller then
 * requeues the job on its own current device, exactly as plan 36 §3.6
 * describes ("if none is available it retries on the same device after the
 * backoff").
 */
export function pickRebindDevice(db: Db, job: JobRow): string | null {
  if (!job.batchId) return null
  const siblings = db.select({ deviceId: jobs.deviceId }).from(jobs).where(eq(jobs.batchId, job.batchId)).orderBy(asc(jobs.batchSeq)).all()
  const candidateIds = [...new Set(siblings.map((s) => s.deviceId))].filter((id) => id !== job.deviceId)
  if (candidateIds.length === 0) return null
  const rows = db.select().from(devices).where(inArray(devices.id, candidateIds)).all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const runningDeviceIds = new Set(
    db
      .select({ deviceId: jobs.deviceId })
      .from(jobs)
      .where(and(inArray(jobs.deviceId, candidateIds), eq(jobs.status, 'running')))
      .all()
      .map((r) => r.deviceId),
  )
  for (const id of candidateIds) {
    if (byId.get(id)?.status === 'online' && !runningDeviceIds.has(id)) return id
  }
  return null
}
