import type { JobDetail, JobInfo, ParamIssue, ResultStatus, RuntimeEnvelope } from '@enkaku/protocol'
import { RuntimeEnvelopeSchema } from '@enkaku/protocol'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { changedRows, type Db } from '../db'
import { devices, jobRuns, jobs, scripts, type JobRow, type JobRunRow } from '../db/schema'
import { keysetWhere } from '../api/pagination'
import { parseWorkflowDoc } from '../workflows/store'

export interface JobCursor {
  sortValue: number
  id: string
}

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

/**
 * Plan 98 §3.8, §4.4, step 98.7 — reads a run's `runtime_override` back the
 * same defensive way `scripts/service.ts`'s `parseScriptRuntime` reads
 * `scripts.runtime`: Zod-validated, never an `as`-cast, degrading to `null`
 * on a parse failure (a hand-edited row, a future shape this build does not
 * know) rather than a 500.
 */
export function parseJobRuntimeOverride(value: unknown): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(value ?? null)
  return parsed.success ? parsed.data : null
}

/**
 * A job's displayed status is its latest run's status (plan 211 §3.2
 * decision 12). `run` is null only for a job whose runs were all swept
 * (MVP 14 §5) or that has none yet.
 */
export function rowToJobInfo(
  row: JobRow,
  run: JobRunRow | null,
  script?: { name: string; version: string; resultSchema?: unknown | null } | null,
): JobInfo {
  return {
    jobId: row.id,
    deviceId: row.deviceId,
    scriptId: row.scriptId ?? '',
    kind: row.kind,
    // Plan 82 §3.4 — the row's OWN denormalised name/version wins when
    // present (set at creation; survives the `scripts` row it pointed at
    // disappearing); a pre-existing row has neither and falls back to the
    // table lookup exactly as before this plan.
    scriptName: row.scriptName ?? script?.name ?? null,
    scriptVersion: row.scriptVersion ?? script?.version ?? null,
    status: (run?.status ?? 'queued') as JobInfo['status'],
    error: run?.error ?? null,
    failureClass: run?.failureClass ?? null,
    priority: run?.priority ?? 0,
    createdAt: toSec(row.createdAt) ?? 0,
    startedAt: run ? toSec(run.startedAt) : null,
    finishedAt: run ? toSec(run.finishedAt) : null,
    batchId: row.batchId,
    batchSeq: row.batchSeq,
    expiresAt: run?.expiresAt ?? null,
    errorPhase: run?.errorPhase ?? null,
    triggeredByJobId: row.triggeredByJobId ?? null,
    rootJobId: row.rootJobId ?? null,
    depth: row.depth ?? 0,
    peakRssBytes: run?.peakRssBytes ?? null,
    notBefore: run?.notBefore ?? null,
    batchRepeat: run?.batchRepeat ?? null,
    pacedDelayMs: run?.pacedDelayMs ?? null,
    resultStatus: (run?.resultStatus ?? null) as ResultStatus | null,
    resultSummary: run?.resultSummary ?? null,
    runId: run?.id ?? null,
    runSeq: run?.seq ?? null,
    runCount: row.runCount,
    trigger: run?.trigger ?? null,
    parentWorkflowJobId: row.parentWorkflowJobId,
    stepSeq: row.stepSeq,
  }
}

/**
 * One job in full, for the detail endpoint (plan 60 §4.3, plan 211 §3.2
 * decision 12): the flat job+latest-run projection, plus every run the job
 * still has (newest first).
 */
export function rowToJobDetail(
  row: JobRow,
  run: JobRunRow | null,
  runs: JobRunRow[],
  script?: { name: string; version: string; resultSchema?: unknown | null } | null,
): JobDetail {
  return {
    ...rowToJobInfo(row, run, script),
    result: run?.result ?? null,
    params: row.params ?? null,
    resultBytes: run?.resultBytes ?? null,
    resultIssues: (run?.resultIssues as ParamIssue[] | null) ?? null,
    resultSchema: (script?.resultSchema ?? null) as JobDetail['resultSchema'],
    runs: runs.map((r) => rowToJobRunInfo(r)),
    // Plan 307 §3.2 — the document this job actually ran, for a faithful
    // replay. `parseWorkflowDoc` upgrades a pre-existing v1 snapshot to v2 in
    // memory; it never writes back (same rule `workflows/store.ts` states for
    // the workflow row itself).
    workflowDoc: row.kind === 'workflow' ? parseWorkflowDoc(row.workflowDoc) : null,
  }
}

export function rowToJobRunInfo(run: JobRunRow): JobDetail['runs'][number] {
  return {
    runId: run.id,
    jobId: run.jobId,
    seq: run.seq,
    trigger: run.trigger,
    status: run.status as JobInfo['status'],
    deviceId: run.deviceId,
    priority: run.priority,
    createdAt: toSec(run.createdAt) ?? 0,
    startedAt: toSec(run.startedAt),
    finishedAt: toSec(run.finishedAt),
    expiresAt: run.expiresAt ?? null,
    notBefore: run.notBefore ?? null,
    batchRepeat: run.batchRepeat ?? null,
    pacedDelayMs: run.pacedDelayMs ?? null,
    error: run.error,
    failureClass: run.failureClass,
    errorPhase: run.errorPhase,
    infraAttempts: run.infraAttempts,
    peakRssBytes: run.peakRssBytes,
    resultStatus: (run.resultStatus ?? null) as ResultStatus | null,
    resultSummary: run.resultSummary,
    resumedFromRunId: run.resumedFromRunId,
    resumedFromStep: run.resumedFromStep,
  }
}

export interface ClaimedJob {
  job: JobRow
  run: JobRunRow
  deviceId: string
}

export interface JobStore {
  get(jobId: string): JobRow | null
  /**
   * Keyset paging — `(createdAt DESC, id DESC)` (plan 30 §3.2, §4.2).
   * `status` matches the job's LATEST run (plan 211).
   */
  list(filter: {
    deviceId?: string
    status?: string
    kind?: string
    rootJobId?: string
    parentWorkflowJobId?: string
    scheduleId?: string
    /** A `trigger: 'simulate'` run never touched a device (plan 309 §3.4, G4) — excluded from the list unless this asks for it explicitly. */
    includeSimulate?: boolean
    limit: number
    cursor?: JobCursor | null
  }): {
    rows: JobRow[]
    nextCursor: JobCursor | null
    total: number
  }
  scriptNames(scriptIds: string[]): Map<string, { name: string; version: string; resultSchema?: unknown | null }>
  /**
   * Single-writer transaction: claim a queued RUN for an online device (spec
   * §10.3, plan 20 §4.2, plan 205 §4.7, plan 211 §4.6). `excludeDeviceIds`
   * (plan 71 §3.7) skips a device still inside its post-control-use quiet
   * period — the run KEEPS its place; it is simply not eligible to claim
   * THAT device yet.
   */
  claimNext(jobTtlSec: number, excludeDeviceIds?: string[]): ClaimedJob | null
  /** Distinct device ids with at least one `queued` run — the quiet-period wait (plan 71 §3.7) only needs to evaluate these, not the whole fleet. */
  queuedDeviceIds(): string[]
  /** The run that would be claimed next for this device (same ordering `claimNext` uses), or null. */
  nextQueuedRunId(deviceId: string): string | null
  renewHeartbeat(runId: string, ttlSec: number): boolean
  expiredRunning(): JobRunRow[]
  /** The expiry reaper (plan 21 §4.3): flip every `queued` run past its `expiresAt` to `expired`. */
  expireQueued(): JobRunRow[]
  /** Recovery boot: run 'running' orphan → failed (plan 04 §4.6). */
  failOrphanRunning(): number
  runningByDevice(deviceId: string): JobRunRow | null
  /**
   * Plan 36 §3.6, §4.3, plan 211 §3.2 decision 6 — a batch member's infra
   * failure returns the SAME run to the queue: status back to `queued`, the
   * new device, the heartbeat/lifecycle columns cleared, `infraAttempts`
   * incremented — never a new run number.
   */
  requeueForRebind(runId: string, newDeviceId: string): JobRunRow | null
  /** Every job belonging to a batch, ordered by batchSeq (plan 20 §4.5, §4.6). */
  listByBatch(batchId: string): JobRow[]
}

export function createJobStore(db: Db): JobStore {
  return {
    get(jobId) {
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null
    },

    list(filter) {
      const conds = []
      if (filter.deviceId) conds.push(eq(jobs.deviceId, filter.deviceId))
      if (filter.kind) conds.push(eq(jobs.kind, filter.kind as JobRow['kind']))
      if (filter.rootJobId) conds.push(eq(jobs.rootJobId, filter.rootJobId))
      if (filter.parentWorkflowJobId) conds.push(eq(jobs.parentWorkflowJobId, filter.parentWorkflowJobId))
      if (filter.scheduleId) conds.push(eq(jobs.scheduleId, filter.scheduleId))
      /**
       * `status` is the LATEST RUN's status (plan 211), and it belongs in SQL.
       *
       * It used to be applied in JavaScript to the page that had already been
       * fetched, which broke two things at once. `total` was computed without
       * it, so `GET /api/jobs?status=queued` answered `items: []` and
       * `total: 123` on a farm with an empty queue — the status bar read
       * "Jobs 0/123" (owner, 2026-09-04). And paging was worse than wrong: a
       * `limit` of 20 fetched twenty jobs, then discarded the ones that did
       * not match, so a caller looking for queued work had to walk the whole
       * history a page at a time to find it.
       */
      if (filter.status) {
        conds.push(sql`(SELECT ${jobRuns.status} FROM ${jobRuns} WHERE ${jobRuns.id} = ${jobs.latestRunId}) = ${filter.status}`)
      }
      // Plan 309 §3.4, G4 — a simulated run is scratch work, not history: it
      // never counts as real, and stays off the Jobs list unless the filter
      // asks for it (`includeSimulate`). Same correlated-subquery shape
      // `status` already uses, since `trigger` lives on `job_runs`.
      if (!filter.includeSimulate) {
        conds.push(sql`(SELECT ${jobRuns.trigger} FROM ${jobRuns} WHERE ${jobRuns.id} = ${jobs.latestRunId}) IS NOT 'simulate'`)
      }
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
      // BEGIN IMMEDIATE: the write lock is held from the start of the
      // transaction so the claim and the run's status flip are atomic
      // (spec §10.3).
      //
      // The workflow parent exemption (plan 211 §3.2 decision 8): a device
      // held by a workflow job's own run admits that SAME workflow job's own
      // step runs. `x.job_id <> j.parent_workflow_job_id` is false exactly
      // for the parent's own run, so a sibling step, an unrelated job and a
      // second workflow all still block. This is a claim gate and belongs in
      // SQL, for the same race-safety reason every other gate below does.
      //
      // Plan 20 §4.2 batch gate, plan 98 §3.7/§4.6 maxConcurrent gate
      // (now keyed on `job_runs.script_name`, replacing `idx_jobs_script_running`),
      // plan 94 §3.8 pacing gate (`not_before`) — all unchanged in meaning,
      // now reading `job_runs` instead of `jobs`.
      const excludeClause =
        excludeDeviceIds && excludeDeviceIds.length > 0
          ? sql`AND r.device_id NOT IN (${sql.join(
              excludeDeviceIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      return db.transaction(
        (tx) => {
          const claimed = tx
            .all<JobRunRow>(sql`
              UPDATE job_runs
              SET status = 'running',
                  heartbeat_expires_at = strftime('%s','now') + ${jobTtlSec},
                  started_at = strftime('%s','now')
              WHERE id = (
                SELECT r.id FROM job_runs r
                JOIN jobs j ON j.id = r.job_id
                JOIN devices d ON d.id = r.device_id
                LEFT JOIN batches b ON b.id = j.batch_id
                WHERE r.status = 'queued'
                  AND d.status = 'online'
                  AND NOT EXISTS (
                    SELECT 1 FROM job_runs x
                    WHERE x.device_id = r.device_id
                      AND x.status = 'running'
                      AND (j.parent_workflow_job_id IS NULL OR x.job_id <> j.parent_workflow_job_id)
                  )
                  ${excludeClause}
                  AND (
                    j.batch_id IS NULL
                    OR b.concurrency = 0
                    OR (SELECT COUNT(*) FROM job_runs r2
                        JOIN jobs j2 ON j2.id = r2.job_id
                        WHERE j2.batch_id = j.batch_id AND r2.status = 'running') < b.concurrency
                  )
                  AND (
                    r.max_concurrent IS NULL
                    OR r.max_concurrent = 0
                    OR (SELECT COUNT(*) FROM job_runs r3
                        WHERE r3.script_name = r.script_name AND r3.status = 'running') < r.max_concurrent
                  )
                  AND (r.not_before IS NULL OR r.not_before <= strftime('%s','now'))
                ORDER BY r.priority DESC, r.created_at ASC, j.batch_seq ASC
                LIMIT 1
              )
              RETURNING *
            `)
            .at(0)
          if (!claimed) return null

          const deviceId = (claimed as unknown as { device_id?: string }).device_id ?? claimed.deviceId
          const run = tx.select().from(jobRuns).where(eq(jobRuns.id, claimed.id)).get()
          const job = run ? tx.select().from(jobs).where(eq(jobs.id, run.jobId)).get() : undefined
          return run && job ? { job, run, deviceId } : null
        },
        { behavior: 'immediate' },
      )
    },

    queuedDeviceIds() {
      return db.selectDistinct({ deviceId: jobRuns.deviceId }).from(jobRuns).where(eq(jobRuns.status, 'queued')).all().map((r) => r.deviceId)
    },

    nextQueuedRunId(deviceId) {
      const row = db
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(and(eq(jobRuns.deviceId, deviceId), eq(jobRuns.status, 'queued')))
        .orderBy(desc(jobRuns.priority), asc(jobRuns.createdAt))
        .limit(1)
        .get()
      return row?.id ?? null
    },

    requeueForRebind(runId, newDeviceId) {
      return db.transaction((tx) => {
        const before = tx.select().from(jobRuns).where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'running'))).get()
        if (!before) return null
        const changed = changedRows(
          tx
            .update(jobRuns)
            .set({
              status: 'queued',
              deviceId: newDeviceId,
              heartbeatExpiresAt: null,
              startedAt: null,
              infraAttempts: sql`COALESCE(${jobRuns.infraAttempts}, 0) + 1`,
            })
            .where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'running')))
            .run(),
        )
        if (changed === 0) return null
        tx.update(jobs).set({ deviceId: newDeviceId }).where(eq(jobs.id, before.jobId)).run()
        return tx.select().from(jobRuns).where(eq(jobRuns.id, runId)).get() ?? null
      })
    },

    listByBatch(batchId) {
      return db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.batchSeq)).all()
    },

    renewHeartbeat(runId, ttlSec) {
      return (
        changedRows(
          db
            .update(jobRuns)
            .set({ heartbeatExpiresAt: sql`strftime('%s','now') + ${ttlSec}` })
            .where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'running')))
            .run(),
        ) > 0
      )
    },

    expiredRunning() {
      return db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.status, 'running'), sql`${jobRuns.heartbeatExpiresAt} < strftime('%s','now')`))
        .all()
    },

    expireQueued() {
      // A single UPDATE...RETURNING is its own implicit transaction in SQLite,
      // so this cannot race claimNext's transaction: whichever commits first
      // wins the `status = 'queued'` guard for the other (plan 21 §4.3).
      // `RETURNING *` comes back with the DRIVER's own (snake_case) column
      // names, not Drizzle's camelCase mapping — the same gotcha
      // `claimNext` above works around — so only `id` (spelled the same
      // either way) is trusted off the raw result; every other field is a
      // proper re-select through the query builder.
      const ids = db
        .all<{ id: string }>(
          sql`
            UPDATE job_runs
            SET status = 'expired', finished_at = strftime('%s','now')
            WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at <= strftime('%s','now')
            RETURNING id
          `,
        )
        .map((r) => r.id)
      if (ids.length === 0) return []
      return db.select().from(jobRuns).where(inArray(jobRuns.id, ids)).all()
    },

    failOrphanRunning() {
      return changedRows(
        db
          .update(jobRuns)
          // A restart is unambiguously the farm's problem, not the script's
          // — classified 'infra' directly rather than through
          // `classifyFailure` (plan 36 §3.2, acceptance #8), since this
          // recovery path (plan 04 §4.6) never runs the executor at all.
          .set({ status: 'failed', error: 'core restarted', finishedAt: new Date(), heartbeatExpiresAt: null, failureClass: 'infra' })
          .where(eq(jobRuns.status, 'running'))
          .run(),
      )
    },

    runningByDevice(deviceId) {
      return (
        db
          .select()
          .from(jobRuns)
          .where(and(eq(jobRuns.deviceId, deviceId), eq(jobRuns.status, 'running')))
          .get() ?? null
      )
    },
  }
}
