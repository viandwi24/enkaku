import type { JobInfo, JobStatus } from '@enkaku/protocol'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { changedRows, type Db } from '../db'
import { devices, jobs, scripts, type JobRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { keysetWhere } from '../api/pagination'

export interface JobCursor {
  sortValue: number
  id: string
}

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

export function rowToJobInfo(row: JobRow, script?: { name: string; version: string } | null): JobInfo {
  return {
    jobId: row.id,
    deviceId: row.deviceId,
    scriptId: row.scriptId,
    scriptName: script?.name ?? null,
    scriptVersion: script?.version ?? null,
    status: (row.status ?? 'queued') as JobStatus,
    error: row.error,
    failureClass: row.failureClass,
    priority: row.priority ?? 0,
    createdAt: toSec(row.createdAt) ?? 0,
    startedAt: toSec(row.startedAt),
    finishedAt: toSec(row.finishedAt),
    batchId: row.batchId,
    batchSeq: row.batchSeq,
    // Plan 21 §4.1 — a plain integer column (unix seconds), like leaseExpiresAt,
    // not a Drizzle `timestamp` column, so no Date conversion here.
    expiresAt: row.expiresAt ?? null,
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
  }): JobRow
  get(jobId: string): JobRow | null
  /**
   * Keyset by default — `(createdAt DESC, id DESC)` (plan 30 §3.2, §4.2).
   * `offset` is a deprecated legacy alias, kept for one release (plan 30
   * §3.2): when present it takes over paging and `cursor` is ignored.
   */
  list(filter: { deviceId?: string; status?: JobStatus; limit: number; cursor?: JobCursor | null; offset?: number }): {
    rows: JobRow[]
    nextCursor: JobCursor | null
    total: number
  }
  /** Script names for a batch of jobs — one query, not one per row. */
  scriptNames(scriptIds: string[]): Map<string, { name: string; version: string }>
  /** Single-writer transaction: claim a queued job for an idle device (spec §10.3, plan 20 §4.2). */
  claimNext(jobTtlSec: number): ClaimedJob | null
  /** `failureClass` (plan 36 §4.3) is only meaningful for `status: 'failed'`; omitted/undefined leaves the column untouched. */
  finish(jobId: string, status: 'success' | 'failed' | 'cancelled', data: { result?: unknown; error?: string; failureClass?: string | null }): JobRow | null
  cancelQueued(jobId: string): JobRow | null
  /**
   * Plan 36 §3.6, §4.3 — a batch member's infra failure returns to the
   * queue instead of settling terminally: status back to `queued`, the new
   * (or unchanged) device it should try next, the lease/lifecycle columns
   * cleared as if it had never run, `infraAttempts` incremented — but
   * `priority` and `createdAt` untouched, so plan 21's ordering treats it as
   * the old job it is. Only affects a `running` row, mirroring `finish()`.
   */
  requeueForRebind(jobId: string, newDeviceId: string): JobRow | null
  /** Every job belonging to a batch, ordered by batchSeq (plan 20 §4.5, §4.6). */
  listByBatch(batchId: string): JobRow[]
  /** Cancel every queued job in a batch in one statement — used by the batch cancel endpoint (plan 20 §4.6). */
  cancelQueuedInBatch(batchId: string): number
  renewLease(jobId: string, ttlSec: number): boolean
  expiredRunning(): JobRow[]
  /**
   * The expiry reaper (plan 21 §4.3): flip every `queued` job past its
   * `expiresAt` to `expired`, in one statement. Only ever touches `queued`
   * jobs — a `running` job is governed by the job lease, which already has
   * its own reaper (`expiredRunning`/`failOrphanRunning`), never this one.
   * Returns the affected rows so the caller can recompute their batches.
   */
  expireQueued(): JobRow[]
  /** Recovery boot: job 'running' yatim → failed (plan 04 §4.6). */
  failOrphanRunning(): number
  runningByDevice(deviceId: string): JobRow | null
}

export function createJobStore(db: Db): JobStore {
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
        leaseExpiresAt: null,
        result: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
        batchId: input.batchId ?? null,
        batchSeq: input.batchSeq ?? null,
        expiresAt: input.expiresAt ?? null,
        failureClass: null,
        infraAttempts: 0,
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
      const countWhere = conds.length > 0 ? and(...conds) : undefined
      const total = db.select().from(jobs).where(countWhere).all().length

      if (filter.offset !== undefined) {
        // Deprecated legacy alias (plan 30 §3.2) — OFFSET semantics kept verbatim.
        const rows = db
          .select()
          .from(jobs)
          .where(countWhere)
          .orderBy(desc(jobs.createdAt), desc(jobs.id))
          .limit(filter.limit)
          .offset(filter.offset)
          .all()
        return { rows, nextCursor: null, total }
      }

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
      return new Map(rows.map((r) => [r.id, { name: r.name, version: r.version }]))
    },

    claimNext(jobTtlSec) {
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
      // Ordering: `priority DESC, created_at ASC` still decides between
      // different batches and standalone jobs (plan 20 §3.3) — batchSeq is
      // only a tiebreaker for jobs of the same batch, which share the same
      // (integer-second) `created_at` from a single dispatch transaction.
      // SQLite's default ASC ordering sorts NULL first, so a standalone job
      // (batch_seq IS NULL) is never pushed behind a batched one at an
      // equal priority/age tie (verified in job-store.test.ts).
      return db.transaction(
        (tx) => {
          const claimed = tx
            .all<JobRow>(sql`
              UPDATE jobs
              SET status = 'running',
                  lease_expires_at = strftime('%s','now') + ${jobTtlSec},
                  started_at = strftime('%s','now')
              WHERE id = (
                SELECT j.id FROM jobs j
                JOIN devices d ON d.id = j.device_id
                LEFT JOIN batches b ON b.id = j.batch_id
                WHERE j.status = 'queued'
                  AND d.status = 'idle'
                  AND (
                    j.batch_id IS NULL
                    OR b.concurrency = 0
                    OR (SELECT COUNT(*) FROM jobs r
                        WHERE r.batch_id = j.batch_id AND r.status = 'running') < b.concurrency
                  )
                ORDER BY j.priority DESC, j.created_at ASC, j.batch_seq ASC
                LIMIT 1
              )
              RETURNING *
            `)
            .at(0)
          if (!claimed) return null

          const deviceId = (claimed as unknown as { device_id?: string }).device_id ?? claimed.deviceId
          const deviceUpdated = changedRows(
            tx.run(sql`UPDATE devices SET status = 'busy' WHERE id = ${deviceId} AND status = 'idle'`),
          )
          if (deviceUpdated === 0) {
            // Someone took the device manually first → abandon the claim.
            tx.rollback()
          }
          const row = tx.select().from(jobs).where(eq(jobs.id, claimed.id)).get()
          return row ? { job: row, deviceId } : null
        },
        { behavior: 'immediate' },
      )
    },

    finish(jobId, status, data) {
      const changed = changedRows(
        db
          .update(jobs)
          .set({
            status,
            finishedAt: new Date(),
            leaseExpiresAt: null,
            ...(data.result !== undefined ? { result: data.result } : {}),
            ...(data.error !== undefined ? { error: data.error } : {}),
            ...(data.failureClass !== undefined ? { failureClass: data.failureClass } : {}),
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
            leaseExpiresAt: null,
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

    renewLease(jobId, ttlSec) {
      return (
        changedRows(
          db
            .update(jobs)
            .set({ leaseExpiresAt: sql`strftime('%s','now') + ${ttlSec}` })
            .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
            .run(),
        ) > 0
      )
    },

    expiredRunning() {
      return db
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'running'), sql`${jobs.leaseExpiresAt} < strftime('%s','now')`))
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
          .set({ status: 'failed', error: 'core restarted', finishedAt: new Date(), leaseExpiresAt: null, failureClass: 'infra' })
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
  }
}
