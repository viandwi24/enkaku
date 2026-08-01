import type { JobInfo, JobStatus } from '@enkaku/protocol'
import { and, desc, eq, sql } from 'drizzle-orm'
import { changedRows, type Db } from '../db'
import { devices, jobs, type JobRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

export function rowToJobInfo(row: JobRow): JobInfo {
  return {
    jobId: row.id,
    deviceId: row.deviceId,
    scriptId: row.scriptId,
    status: (row.status ?? 'queued') as JobStatus,
    error: row.error,
    priority: row.priority ?? 0,
    createdAt: toSec(row.createdAt) ?? 0,
    startedAt: toSec(row.startedAt),
    finishedAt: toSec(row.finishedAt),
  }
}

export interface ClaimedJob {
  job: JobRow
  deviceId: string
}

export interface JobStore {
  enqueue(input: { scriptId: string; deviceId: string; params: unknown; priority: number }): JobRow
  get(jobId: string): JobRow | null
  list(filter: { deviceId?: string; status?: JobStatus; limit: number; offset: number }): { rows: JobRow[]; total: number }
  /** Transaksi single-writer: claim job queued untuk device idle (spec §10.3). */
  claimNext(jobTtlSec: number): ClaimedJob | null
  finish(jobId: string, status: 'success' | 'failed' | 'cancelled', data: { result?: unknown; error?: string }): JobRow | null
  cancelQueued(jobId: string): JobRow | null
  renewLease(jobId: string, ttlSec: number): boolean
  expiredRunning(): JobRow[]
  /** Recovery boot: job 'running' yatim → failed (plan 04 §4.6). */
  failOrphanRunning(): number
  runningByDevice(deviceId: string): JobRow | null
}

export function createJobStore(db: Db): JobStore {
  return {
    enqueue(input) {
      const device = db.select().from(devices).where(eq(devices.id, input.deviceId)).get()
      if (!device) throw new EnkakuError('device_not_found', `device tidak ada: ${input.deviceId}`)
      if (device.status === 'quarantined') {
        throw new EnkakuError('device_unavailable', `device ${device.label} sedang quarantined`)
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
      const where = conds.length > 0 ? and(...conds) : undefined
      const rows = db
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.createdAt))
        .limit(filter.limit)
        .offset(filter.offset)
        .all()
      const total = db.select().from(jobs).where(where).all().length
      return { rows, total }
    },

    claimNext(jobTtlSec) {
      // BEGIN IMMEDIATE: write-lock dipegang sejak awal transaksi supaya
      // claim + perubahan status device atomik (spec §10.3).
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
                WHERE j.status = 'queued' AND d.status = 'idle'
                ORDER BY j.priority DESC, j.created_at
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
            // Device keburu diambil manual → batalkan claim.
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

    failOrphanRunning() {
      return changedRows(
        db
          .update(jobs)
          .set({ status: 'failed', error: 'core restarted', finishedAt: new Date(), leaseExpiresAt: null })
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
