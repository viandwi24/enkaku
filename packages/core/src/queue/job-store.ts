import type { JobDetail, JobInfo, JobNodeInfo, JobStatus, ParamIssue, ResultStatus, RuntimeEnvelope } from '@enkaku/protocol'
import { RuntimeEnvelopeSchema } from '@enkaku/protocol'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { changedRows, type Db } from '../db'
import { devices, jobNodes, jobResumes, jobs, scripts, type JobNodeRow, type JobRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { keysetWhere } from '../api/pagination'

export interface JobCursor {
  sortValue: number
  id: string
}

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

/**
 * Plan 98 §3.8, §4.4, step 98.7 — reads `jobs.runtime_override` back the same
 * defensive way `scripts/service.ts`'s `parseScriptRuntime` reads
 * `scripts.runtime`: Zod-validated, never an `as`-cast, degrading to `null`
 * on a parse failure (a hand-edited row, a future shape this build does not
 * know) rather than a 500. Exported so `jobs/executors/script.ts` (the one
 * place a `JobRow` becomes the `JobSpec` the runner actually reads) and
 * `services/job-service.ts`'s `resume()` (which carries the ORIGINAL job's
 * own override forward) share this one implementation.
 */
export function parseJobRuntimeOverride(value: unknown): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(value ?? null)
  return parsed.success ? parsed.data : null
}

export function rowToJobInfo(
  row: JobRow,
  script?: { name: string; version: string; resultSchema?: unknown | null } | null,
): JobInfo {
  return {
    jobId: row.id,
    deviceId: row.deviceId,
    scriptId: row.scriptId,
    // Plan 82 §3.4 — the row's OWN denormalised name/version wins when
    // present (set at enqueue time; survives the `scripts` row it pointed
    // at disappearing, including a dropped dev slot, criterion 13); a
    // pre-existing row has neither and falls back to the table lookup
    // exactly as before this plan.
    scriptName: row.scriptName ?? script?.name ?? null,
    scriptVersion: row.scriptVersion ?? script?.version ?? null,
    status: (row.status ?? 'queued') as JobStatus,
    error: row.error,
    failureClass: row.failureClass,
    priority: row.priority ?? 0,
    createdAt: toSec(row.createdAt) ?? 0,
    startedAt: toSec(row.startedAt),
    finishedAt: toSec(row.finishedAt),
    batchId: row.batchId,
    batchSeq: row.batchSeq,
    // Plan 21 §4.1 — a plain integer column (unix seconds), like heartbeatExpiresAt,
    // not a Drizzle `timestamp` column, so no Date conversion here.
    expiresAt: row.expiresAt ?? null,
    /** Plan 60 §3.4 — where a failure happened, so Summary can say it. */
    errorPhase: row.errorPhase ?? null,
    // Plan 81 §4.1 — lineage. Null `triggeredByJobId`/`rootJobId` means "not
    // part of a trigger chain", the common case; `depth` defaults to 0, not
    // null (see JobInfoSchema's own comment).
    triggeredByJobId: row.triggeredByJobId ?? null,
    rootJobId: row.rootJobId ?? null,
    depth: row.depth ?? 0,
    /** Plan 98 §4.4, H1 — always whatever the row has, whether or not a limit is configured. */
    peakRssBytes: row.peakRssBytes ?? null,
    // Plan 94 §3.7, §3.8, §4.8, step 94.7 — straight from the row; the
    // pacer (`groups/pacer.ts`) is the only writer of any of these three.
    notBefore: row.notBefore ?? null,
    batchRepeat: row.batchRepeat ?? null,
    pacedDelayMs: row.pacedDelayMs ?? null,
    // Plan 97 §4.6 — `result` itself stays off the list (F18); only the
    // verdict and the pre-built summary line ride along.
    resultStatus: (row.resultStatus ?? null) as ResultStatus | null,
    resultSummary: row.resultSummary ?? null,
  }
}

/**
 * One job in full, for the detail endpoint only (plan 60 §4.3): the same
 * fields plus the script's own return value. `result` is a JSON column, so
 * Drizzle hands it back already parsed — it is whatever the script returned
 * and is deliberately not narrowed further.
 */
export function rowToJobDetail(
  row: JobRow,
  script?: { name: string; version: string; resultSchema?: unknown | null } | null,
): JobDetail {
  // `params` joins `result` here and NOT on `rowToJobInfo`: both are
  // script-authored JSON, and the single-job read a human asked for is the
  // right place for them — not a list, and not `ctx.jobs`' cross-script view.
  return {
    ...rowToJobInfo(row, script),
    result: row.result ?? null,
    params: row.params ?? null,
    // Plan 97 §4.6 — the exact byte count and the real Zod issues, stored
    // once at settle, never recomputed on read.
    resultBytes: row.resultBytes ?? null,
    resultIssues: (row.resultIssues as ParamIssue[] | null) ?? null,
    // The result schema of the script VERSION that ran, inlined from the
    // PINNED script row rather than a second `@latest` fetch (§4.6's
    // reasoning) — `scriptNames()` above now selects `scripts.result_schema`
    // alongside `name`/`version`, so this is real data, not a forward-compat
    // placeholder.
    resultSchema: (script?.resultSchema ?? null) as JobDetail['resultSchema'],
  }
}

/**
 * One `job_nodes` row, for `GET /api/jobs/:id/nodes` (plan 99 §3.5, §4.9,
 * step 99.8). `kind`/`status` are cast rather than re-validated through Zod
 * here — the same convention `rowToJobInfo` above already uses for
 * `jobs.status` — because the only writer of this table is this repo's own
 * workflow executor, drawing `kind` from `WorkflowNode.kind` (already a
 * closed Zod union) and `status` from a small fixed set of literals; the
 * real boundary check is `typedJson`'s compile-time structural match against
 * `JobNodeInfoSchema` at the route.
 *
 * `job_nodes` has exactly one `error`/`error_code` pair, surfaced twice on
 * the wire shape (`attempts.lastError` and `output.error`) — not a
 * duplication bug, matching `JobNodeInfoSchema`'s own doc comment: a UI binds
 * one to the attempts panel and the other to the result panel without
 * cross-referencing.
 */
export function rowToJobNodeInfo(row: JobNodeRow): JobNodeInfo {
  const startedAt = toSec(row.startedAt)
  const finishedAt = toSec(row.finishedAt)
  const lastError = row.status === 'failed' ? { code: row.errorCode, message: row.error ?? 'the node failed' } : null
  return {
    seq: row.seq,
    nodeId: row.nodeId,
    kind: row.kind as JobNodeInfo['kind'],
    scriptId: row.scriptId,
    scriptName: row.scriptName,
    scriptVersion: row.scriptVersion,
    status: row.status as JobNodeInfo['status'],
    duration: {
      startedAt,
      finishedAt,
      elapsedMs: startedAt !== null && finishedAt !== null ? (finishedAt - startedAt) * 1000 : null,
    },
    attempts: {
      current: row.attempts,
      // No column stores the node's retry BUDGET — it lives in the workflow
      // document, not on this row.
      total: null,
      lastError,
    },
    output: {
      value: row.output ?? null,
      truncated: row.outputTruncated,
      error: lastError,
      verdict: row.verdict ?? null,
    },
    resumedFromJobId: row.resumedFromJobId,
    resumedFromNode: row.resumedFromNode,
  }
}

export interface ClaimedJob {
  job: JobRow
  deviceId: string
}

export interface JobStore {
  enqueue(input: {
    scriptId: string
    deviceId: string
    params: unknown
    priority: number
    /** Plan 20 §4.4 — set when this job is a member of a batch. */
    batchId?: string
    batchSeq?: number
    /** Plan 21 §3.3 — unix seconds; the reaper expires the job if it has not started by then. */
    expiresAt?: number | null
    /**
     * Plan 82 §3.4 — denormalised onto the row at enqueue, from whatever
     * resolved `scriptId` (typically `ScriptRegistry.resolve()`'s entry).
     * Omitted/undefined stores `null`, exactly like a pre-existing row that
     * predates this column — `scriptNames()` below falls back to the
     * `scripts` table lookup whenever it reads null here.
     */
    scriptName?: string | null
    scriptVersion?: string | null
    /**
     * Plan 98 §3.7, §4.4, §4.6, step 98.5 — the caller's job (never this
     * store) is what calls `resolveRuntime`; this parameter is already the
     * resolved integer, ready to sit on the row unresolved by anything else.
     * `undefined`/omitted stores `null` — "unlimited", the same as a
     * pre-plan-98 row and a script that declares no cap — matching every
     * other denormalised-at-enqueue field's own convention above.
     */
    maxConcurrent?: number | null
    /**
     * Plan 98 §3.8, §4.4, §4.6, step 98.7 — the operator's own per-job layer,
     * ALREADY validated against `RuntimeEnvelopeSchema` and checked against
     * the farm's ceiling by the caller (`services/job-service.ts`) — this
     * store pins whatever it is handed, exactly like `maxConcurrent` above.
     * `undefined`/omitted stores `null` — "no override", the same as a
     * pre-plan-98 row and a job enqueued with no override at all.
     */
    runtimeOverride?: RuntimeEnvelope | null
  }): JobRow
  get(jobId: string): JobRow | null
  /**
   * Keyset paging — `(createdAt DESC, id DESC)` (plan 30 §3.2, §4.2).
   * `rootJobId` (plan 81 §4.5) filters to every job sharing a trigger
   * chain's root — the chain's own row is excluded (its `rootJobId` is
   * null, not its own id; see schema.ts's comment), so this is exactly
   * "every OTHER member of this chain". Studio's job detail page uses it to
   * render the lineage tree and to compute which queued descendants a
   * cancel would take with it.
   */
  list(filter: { deviceId?: string; status?: JobStatus; rootJobId?: string; limit: number; cursor?: JobCursor | null }): {
    rows: JobRow[]
    nextCursor: JobCursor | null
    total: number
  }
  /**
   * Script names for a batch of jobs — one query, not one per row.
   * `resultSchema` rides along (plan 97 §4.4, §4.6) so `rowToJobDetail`
   * (above) can inline the PINNED row's own declared schema with no second
   * query of its own — every existing caller already just forwards this
   * map's value straight into that function, so this is a purely additive
   * field on an already-passed-through object.
   */
  scriptNames(scriptIds: string[]): Map<string, { name: string; version: string; resultSchema?: unknown | null }>
  /**
   * Single-writer transaction: claim a queued job for an online device (spec
   * §10.3, plan 20 §4.2, plan 205 §4.7 — the SQL claim itself now reads
   * `d.status = 'online'` plus a `NOT EXISTS` running-job guard, not a
   * separate "idle" status). `excludeDeviceIds` (plan 71 §3.7) skips a
   * device still inside its post-control-use quiet period — the job KEEPS
   * its place; it is simply not eligible to claim THAT device yet.
   */
  claimNext(jobTtlSec: number, excludeDeviceIds?: string[]): ClaimedJob | null
  /** Distinct device ids with at least one `queued` job — the quiet-period wait (plan 71 §3.7) only needs to evaluate these, not the whole fleet. */
  queuedDeviceIds(): string[]
  /** The job that would be claimed next for this device (same ordering `claimNext` uses), or null — for the quiet-period wait's visible state (plan 71 §3.7), not for claiming itself. */
  nextQueuedJobId(deviceId: string): string | null
  /**
   * `failureClass` (plan 36 §4.3) is only meaningful for `status: 'failed'`;
   * omitted/undefined leaves the column untouched. So is `errorPhase` (plan
   * 60 §3.4) — the script phase the failure happened in.
   */
  finish(
    jobId: string,
    status: 'success' | 'failed' | 'cancelled',
    data: {
      result?: unknown
      error?: string
      failureClass?: string | null
      errorPhase?: string | null
      /** Plan 98 §4.4, H1 — the job's own peak RSS, whatever the runner accumulated across every attempt. Omitted leaves the column untouched (never overwrites a real number with undefined). */
      peakRssBytes?: number | null
      /**
       * Plan 97 §3.3, §4.4, §4.5 — the four columns `result-store.ts`'s
       * `recordResult` computes. Omitted leaves every one of the four
       * untouched (the same "never overwrite a real value with undefined"
       * rule `peakRssBytes` above already follows) — true for every
       * `failed`/`cancelled` settle until 97.4's `partial` lands, and for a
       * `success` settle from an executor with nothing to report.
       */
      resultStatus?: string | null
      resultBytes?: number | null
      resultSummary?: string | null
      resultIssues?: ParamIssue[] | null
    },
  ): JobRow | null
  cancelQueued(jobId: string): JobRow | null
  /**
   * Plan 36 §3.6, §4.3 — a batch member's infra failure returns to the
   * queue instead of settling terminally: status back to `queued`, the new
   * (or unchanged) device it should try next, the heartbeat/lifecycle columns
   * cleared as if it had never run, `infraAttempts` incremented — but
   * `priority` and `createdAt` untouched, so plan 21's ordering treats it as
   * the old job it is. Only affects a `running` row, mirroring `finish()`.
   */
  requeueForRebind(jobId: string, newDeviceId: string): JobRow | null
  /** Every job belonging to a batch, ordered by batchSeq (plan 20 §4.5, §4.6). */
  listByBatch(batchId: string): JobRow[]
  /** Cancel every queued job in a batch in one statement — used by the batch cancel endpoint (plan 20 §4.6). */
  cancelQueuedInBatch(batchId: string): number
  /**
   * Cancel every still-`queued` descendant of `jobId` — walked transitively
   * through `triggeredByJobId` (plan 81 §4.4), not merely `rootJobId`, so a
   * non-root job's siblings (and their own descendants) are left alone;
   * "leaves unrelated jobs alone" is a property of the ACTUAL trigger tree,
   * not a same-chain heuristic. Opt-in on the cancel call, never automatic.
   * Returns the number actually cancelled.
   */
  cancelQueuedDescendants(jobId: string): number
  renewHeartbeat(jobId: string, ttlSec: number): boolean
  expiredRunning(): JobRow[]
  /**
   * The expiry reaper (plan 21 §4.3): flip every `queued` job past its
   * `expiresAt` to `expired`, in one statement. Only ever touches `queued`
   * jobs — a `running` job is governed by the job heartbeat, which already has
   * its own reaper (`expiredRunning`/`failOrphanRunning`), never this one.
   * Returns the affected rows so the caller can recompute their batches.
   */
  expireQueued(): JobRow[]
  /** Recovery boot: job 'running' yatim → failed (plan 04 §4.6). */
  failOrphanRunning(): number
  runningByDevice(deviceId: string): JobRow | null
  /**
   * The node timeline for one job (plan 99 §3.5, §4.9, step 99.8) — every
   * `job_nodes` row, in execution order. `[]` for a job that never ran a
   * node (every non-workflow job, and a workflow job that has not started
   * yet) — never a special case; a missing JOB is `JobService.nodes`'s job to
   * 404, not this store's. Deliberately survives `failOrphanRunning` below:
   * this table has NO delete path anywhere in this store, on purpose — a
   * crash-orphaned workflow job's history is exactly what resume reads.
   *
   * Optional (unlike every other method on this interface) so the several
   * hand-written `JobStore` fakes elsewhere in this tree — several of them
   * in files this step does not own (`packages/core/src/jobs/executors/**`,
   * `executor-kind-dispatch.test.ts`, a deliberately-red guard test this
   * step was told to leave alone) — keep compiling unchanged. `job-service.ts`
   * treats an omitted implementation as "no nodes" (`?? []`), never as an error.
   */
  nodes?(jobId: string): JobNodeRow[]
  /**
   * Records what a job created by `POST /api/jobs/:id/resume` continues from
   * (plan 99 §3.5, §4.9, step 99.8) — on `job_resumes` (see that table's own
   * comment in `schema.ts` for why it is a side table rather than two more
   * columns on `jobs`). Called once, right after `enqueue()` creates the new
   * job row. Optional for the same reason `nodes()` above is.
   */
  recordResume?(jobId: string, input: { resumedFromJobId: string; resumedFromNode: string }): void
  /** The `job_resumes` row for a job, or null for a job not created by a resume. Optional for the same reason `nodes()` above is. */
  resumeInfo?(jobId: string): { resumedFromJobId: string; resumedFromNode: string } | null
}

/**
 * `createJobStore`'s REAL return shape — `nodes`/`recordResume`/`resumeInfo`
 * narrowed back to required, because the concrete implementation below always
 * has them (only a hand-written `JobStore` FAKE might not, which is the only
 * reason the exported interface above makes them optional). Callers that
 * accept the plain `JobStore` interface (`job-service.ts`, every fake in the
 * tree) are unaffected — this is a narrower, assignable subtype, not a
 * different one. This is what lets `job-store.test.ts` call `store.nodes(id)`
 * directly: a `?.()` there would silently pass even if a future edit dropped
 * the method, which is worse than the type error it would otherwise catch.
 */
export type ConcreteJobStore = JobStore & Required<Pick<JobStore, 'nodes' | 'recordResume' | 'resumeInfo'>>

export function createJobStore(db: Db): ConcreteJobStore {
  return {
    enqueue(input) {
      const device = db.select().from(devices).where(eq(devices.id, input.deviceId)).get()
      if (!device) throw new EnkakuError('device_not_found', `no such device: ${input.deviceId}`)
      if (device.status === 'quarantined') {
        throw new EnkakuError('device_unavailable', `device ${device.label} is quarantined`)
      }
      const row: JobRow = {
        id: crypto.randomUUID(),
        scriptId: input.scriptId,
        deviceId: input.deviceId,
        params: input.params ?? null,
        priority: input.priority,
        status: 'queued',
        heartbeatExpiresAt: null,
        result: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
        batchId: input.batchId ?? null,
        batchSeq: input.batchSeq ?? null,
        expiresAt: input.expiresAt ?? null,
        failureClass: null,
        errorPhase: null,
        infraAttempts: 0,
        scriptName: input.scriptName ?? null,
        scriptVersion: input.scriptVersion ?? null,
        // Plan 81 §4.1 — a job enqueued through this ordinary path (a
        // human, a schedule, a batch) has no lineage: it is its own root,
        // at depth 0, with no trigger key. Only `jobs/triggers.ts`'s own
        // dedicated insert ever writes non-default values here.
        triggeredByJobId: null,
        rootJobId: null,
        depth: 0,
        triggerKey: null,
        // Plan 98 §4.4, H1 — a freshly enqueued job has not run yet, so no
        // child has reported anything. `finish()` above is the only writer.
        peakRssBytes: null,
        // Plan 98 §3.7, §4.4, §4.6, step 98.5 — the one resolved runtime
        // value ever written to a row (see the column's own comment in
        // `db/schema.ts`). Pinned here, at enqueue, alongside `scriptName`/
        // `scriptVersion` above — the caller already resolved it through
        // `resolveRuntime` before this method ever runs.
        maxConcurrent: input.maxConcurrent ?? null,
        // Plan 98 §3.8, §4.4, step 98.7 — the operator's own per-job layer,
        // already validated and ceiling-checked by the caller (see this
        // field's own comment above); never resolved or rewritten here.
        runtimeOverride: input.runtimeOverride ?? null,
        // Plan 94 §3.8, §4.8, step 94.6 — a freshly enqueued job is not
        // paced: nothing writes a non-null value here until 94.7's pacer
        // exists (this step adds only the column and `claimNext`'s
        // predicate — see that column's own comment in `db/schema.ts`).
        notBefore: null,
        batchRepeat: null,
        pacedDelayMs: null,
        // Plan 97 §3.3, §4.4 — a freshly enqueued job has not settled yet.
        // NULL until `finish()` above writes a real verdict.
        resultStatus: null,
        resultBytes: null,
        resultSummary: null,
        resultIssues: null,
      }
      db.insert(jobs).values(row).run()
      return row
    },

    get(jobId) {
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null
    },

    list(filter) {
      const conds = []
      if (filter.deviceId) conds.push(eq(jobs.deviceId, filter.deviceId))
      if (filter.status) conds.push(eq(jobs.status, filter.status))
      if (filter.rootJobId) conds.push(eq(jobs.rootJobId, filter.rootJobId))
      const countWhere = conds.length > 0 ? and(...conds) : undefined
      const total = db.select().from(jobs).where(countWhere).all().length

      const keyset = keysetWhere(
        filter.cursor ? { value: new Date(filter.cursor.sortValue * 1000), id: filter.cursor.id } : null,
        jobs.createdAt,
        jobs.id,
      )
      const pageConds = keyset ? [...conds, keyset] : conds
      const where = pageConds.length > 0 ? and(...pageConds) : undefined
      // Fetch one extra row to know whether there is a next page, without a
      // second COUNT query.
      const page = db
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(filter.limit + 1)
        .all()
      const hasMore = page.length > filter.limit
      const rows = hasMore ? page.slice(0, filter.limit) : page
      const last = rows[rows.length - 1]
      const nextCursor: JobCursor | null =
        hasMore && last ? { sortValue: Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), id: last.id } : null
      return { rows, nextCursor, total }
    },

    scriptNames(scriptIds) {
      const unik = [...new Set(scriptIds)]
      if (unik.length === 0) return new Map()
      const rows = db.select().from(scripts).where(inArray(scripts.id, unik)).all()
      return new Map(rows.map((r) => [r.id, { name: r.name, version: r.version, resultSchema: r.resultSchema ?? null }]))
    },

    claimNext(jobTtlSec, excludeDeviceIds) {
      // BEGIN IMMEDIATE: the write lock is held from the start of the transaction so
      // claim + perubahan status device atomik (spec §10.3).
      //
      // Plan 20 §4.2 adds a batch gate: a job whose batch already has
      // `concurrency` jobs running is not claimable, and — within a batch —
      // lower `batchSeq` is claimed first. Both live inside this ONE
      // statement (the correlated COUNT(*) runs in the same transaction as
      // the status flip), because anything enforced outside it can be raced
      // (plan 20 §3.3, §8 risk table). Do not add a TypeScript pre-filter.
      //
      // Plan 71 §3.7, reworked by plan 205 §4.7, adds a THIRD exclusion,
      // alongside `d.status = 'online'` and the `NOT EXISTS` running-job
      // guard below: a device with a live control marker. Computed by the
      // caller (`queue/scheduler.ts`, which owns the activity registry
      // through `computeControlBlocked`) and passed in as a plain id list —
      // this function stays settings-blind, the same reasoning the batch
      // gate above already follows for `concurrency`.
      //
      // Plan 98 §3.7, §4.6, step 98.5 adds a FOURTH gate, in the identical
      // style and for the identical reason as the batch gate: a script's own
      // farm-wide `maxConcurrent` (0/NULL = unlimited), pinned onto
      // `jobs.max_concurrent` at enqueue (`resolveRuntime`'s one exception —
      // see that column's comment in `db/schema.ts`) because this correlated
      // `COUNT(*)` has to run INSIDE this one transaction, in SQL, exactly
      // like the batch gate's own — a TypeScript pre-filter here would race
      // two callers each reading "0 running" and both admitting (plan 20
      // §3.3, §8 risk table; the very next comment block repeats the same
      // warning for the batch gate and it applies here unchanged). Keyed on
      // `j.script_name`, not `j.script_id`, so a limit is standing intent
      // about a script and survives a version bump (plan 98 §4.6, §9 Q5 —
      // matching `script_param_sets`' own precedent). This clause only ever
      // narrows THIS row's own eligibility — a blocked job is skipped, not a
      // reason the whole query returns nothing, so every other script (and
      // every other device) stays claimable (plan 98's own H3/verifiable
      // result: the device-famine failure mode this step exists to avoid).
      //
      // Plan 94 §3.8, §4.8, step 94.6 adds a FIFTH gate, same style as the
      // two above: `j.not_before` (unix seconds, null = claimable now) must
      // be null or already past. Checked here, in SQL, inside the same
      // transaction — never a TypeScript pre-filter (this file's own
      // opening comment) — because two callers each reading "not yet due"
      // outside the transaction could both race past the instant it becomes
      // due and one would still lose nothing, but a pre-filter here would
      // duplicate a condition the SQL must enforce anyway to be race-safe,
      // which is the actual hazard: a stale in-process read of "now" could
      // admit a job before its floor. `<=` is deliberate, not `<`: a job
      // due exactly now is claimable now. This clause only narrows THIS
      // row's own eligibility, same as the batch and maxConcurrent gates —
      // a paced job is skipped, not a reason the whole query returns
      // nothing, so another queued job for the same device (or any other
      // device) stays claimable.
      //
      // Ordering: `priority DESC, created_at ASC` still decides between
      // different batches and standalone jobs (plan 20 §3.3) — batchSeq is
      // only a tiebreaker for jobs of the same batch, which share the same
      // (integer-second) `created_at` from a single dispatch transaction.
      // SQLite's default ASC ordering sorts NULL first, so a standalone job
      // (batch_seq IS NULL) is never pushed behind a batched one at an
      // equal priority/age tie (verified in job-store.test.ts).
      const excludeClause =
        excludeDeviceIds && excludeDeviceIds.length > 0
          ? sql`AND j.device_id NOT IN (${sql.join(
              excludeDeviceIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      return db.transaction(
        (tx) => {
          const claimed = tx
            .all<JobRow>(sql`
              UPDATE jobs
              SET status = 'running',
                  heartbeat_expires_at = strftime('%s','now') + ${jobTtlSec},
                  started_at = strftime('%s','now')
              WHERE id = (
                SELECT j.id FROM jobs j
                JOIN devices d ON d.id = j.device_id
                LEFT JOIN batches b ON b.id = j.batch_id
                WHERE j.status = 'queued'
                  AND d.status = 'online'
                  AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.device_id = j.device_id AND r.status = 'running')
                  ${excludeClause}
                  AND (
                    j.batch_id IS NULL
                    OR b.concurrency = 0
                    OR (SELECT COUNT(*) FROM jobs r
                        WHERE r.batch_id = j.batch_id AND r.status = 'running') < b.concurrency
                  )
                  AND (
                    j.max_concurrent IS NULL
                    OR j.max_concurrent = 0
                    OR (SELECT COUNT(*) FROM jobs r
                        WHERE r.script_name = j.script_name AND r.status = 'running') < j.max_concurrent
                  )
                  AND (j.not_before IS NULL OR j.not_before <= strftime('%s','now'))
                ORDER BY j.priority DESC, j.created_at ASC, j.batch_seq ASC
                LIMIT 1
              )
              RETURNING *
            `)
            .at(0)
          if (!claimed) return null

          const deviceId = (claimed as unknown as { device_id?: string }).device_id ?? claimed.deviceId
          const row = tx.select().from(jobs).where(eq(jobs.id, claimed.id)).get()
          return row ? { job: row, deviceId } : null
        },
        { behavior: 'immediate' },
      )
    },

    queuedDeviceIds() {
      return db.selectDistinct({ deviceId: jobs.deviceId }).from(jobs).where(eq(jobs.status, 'queued')).all().map((r) => r.deviceId)
    },

    nextQueuedJobId(deviceId) {
      const row = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.deviceId, deviceId), eq(jobs.status, 'queued')))
        .orderBy(desc(jobs.priority), asc(jobs.createdAt))
        .limit(1)
        .get()
      return row?.id ?? null
    },

    finish(jobId, status, data) {
      const changed = changedRows(
        db
          .update(jobs)
          .set({
            status,
            finishedAt: new Date(),
            heartbeatExpiresAt: null,
            ...(data.result !== undefined ? { result: data.result } : {}),
            ...(data.error !== undefined ? { error: data.error } : {}),
            ...(data.failureClass !== undefined ? { failureClass: data.failureClass } : {}),
            ...(data.errorPhase !== undefined ? { errorPhase: data.errorPhase } : {}),
            ...(data.peakRssBytes !== undefined ? { peakRssBytes: data.peakRssBytes } : {}),
            // Plan 97 §3.3, §4.4, §4.5 — written together, from `recordResult`'s
            // one `RecordedResult` (executor-host.ts's `settle`), never
            // independently: a settle either computed all four or none.
            ...(data.resultStatus !== undefined ? { resultStatus: data.resultStatus } : {}),
            ...(data.resultBytes !== undefined ? { resultBytes: data.resultBytes } : {}),
            ...(data.resultSummary !== undefined ? { resultSummary: data.resultSummary } : {}),
            ...(data.resultIssues !== undefined ? { resultIssues: data.resultIssues } : {}),
          })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
          .run(),
      )
      if (changed === 0) return null
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null
    },

    requeueForRebind(jobId, newDeviceId) {
      const changed = changedRows(
        db
          .update(jobs)
          .set({
            status: 'queued',
            deviceId: newDeviceId,
            heartbeatExpiresAt: null,
            startedAt: null,
            infraAttempts: sql`COALESCE(${jobs.infraAttempts}, 0) + 1`,
          })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
          .run(),
      )
      if (changed === 0) return null
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null
    },

    cancelQueued(jobId) {
      const changed = changedRows(
        db
          .update(jobs)
          .set({ status: 'cancelled', finishedAt: new Date() })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
          .run(),
      )
      if (changed === 0) return null
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null
    },

    listByBatch(batchId) {
      return db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.batchSeq)).all()
    },

    cancelQueuedInBatch(batchId) {
      return changedRows(
        db
          .update(jobs)
          .set({ status: 'cancelled', finishedAt: new Date() })
          .where(and(eq(jobs.batchId, batchId), eq(jobs.status, 'queued')))
          .run(),
      )
    },

    cancelQueuedDescendants(jobId) {
      // A level-by-level BFS over `triggeredByJobId` rather than a single
      // recursive query — chain sizes are bounded (`jobs.trigger.maxPerChain`,
      // 200 by default) so this is a handful of small, indexed queries, and
      // each level's UPDATE is its own atomic statement: a descendant
      // claimed by the scheduler between levels simply is not `queued`
      // anymore and is left alone, which is correct, not a race to guard
      // against.
      let cancelled = 0
      let frontier = [jobId]
      const visited = new Set<string>()
      while (frontier.length > 0) {
        const children = db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(inArray(jobs.triggeredByJobId, frontier)).all()
        const nextFrontier: string[] = []
        const queuedIds: string[] = []
        for (const c of children) {
          if (visited.has(c.id)) continue
          visited.add(c.id)
          nextFrontier.push(c.id)
          if (c.status === 'queued') queuedIds.push(c.id)
        }
        if (queuedIds.length > 0) {
          cancelled += changedRows(
            db
              .update(jobs)
              .set({ status: 'cancelled', finishedAt: new Date() })
              .where(and(inArray(jobs.id, queuedIds), eq(jobs.status, 'queued')))
              .run(),
          )
        }
        frontier = nextFrontier
      }
      return cancelled
    },

    renewHeartbeat(jobId, ttlSec) {
      return (
        changedRows(
          db
            .update(jobs)
            .set({ heartbeatExpiresAt: sql`strftime('%s','now') + ${ttlSec}` })
            .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
            .run(),
        ) > 0
      )
    },

    expiredRunning() {
      return db
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'running'), sql`${jobs.heartbeatExpiresAt} < strftime('%s','now')`))
        .all()
    },

    expireQueued() {
      // A single UPDATE...RETURNING is its own implicit transaction in SQLite,
      // so this cannot race claimNext's transaction: whichever commits first
      // wins the `status = 'queued'` guard for the other (plan 21 §4.3).
      return db
        .all<JobRow>(
          sql`
            UPDATE jobs
            SET status = 'expired', finished_at = strftime('%s','now')
            WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
            RETURNING *
          `,
        )
        .map((r) => db.select().from(jobs).where(eq(jobs.id, (r as unknown as { id: string }).id)).get())
        .filter((r): r is JobRow => r != null)
    },

    failOrphanRunning() {
      return changedRows(
        db
          .update(jobs)
          // A restart is unambiguously the farm's problem, not the script's
          // — classified 'infra' directly rather than through
          // `classifyFailure` (plan 36 §3.2, acceptance #8), since this
          // recovery path (plan 04 §4.6) never runs the executor at all.
          .set({ status: 'failed', error: 'core restarted', finishedAt: new Date(), heartbeatExpiresAt: null, failureClass: 'infra' })
          .where(eq(jobs.status, 'running'))
          .run(),
      )
    },

    runningByDevice(deviceId) {
      return (
        db
          .select()
          .from(jobs)
          .where(and(eq(jobs.deviceId, deviceId), eq(jobs.status, 'running')))
          .get() ?? null
      )
    },

    nodes(jobId) {
      return db.select().from(jobNodes).where(eq(jobNodes.jobId, jobId)).orderBy(asc(jobNodes.seq)).all()
    },

    recordResume(jobId, input) {
      db.insert(jobResumes)
        .values({ jobId, resumedFromJobId: input.resumedFromJobId, resumedFromNode: input.resumedFromNode, createdAt: new Date() })
        .run()
    },

    resumeInfo(jobId) {
      const row = db.select().from(jobResumes).where(eq(jobResumes.jobId, jobId)).get()
      return row ? { resumedFromJobId: row.resumedFromJobId, resumedFromNode: row.resumedFromNode } : null
    },
  }
}
