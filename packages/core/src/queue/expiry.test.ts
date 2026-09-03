import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobs } from '../db/schema'
import { createLogger } from '../util/logger'
import { createExpiryReaper } from './expiry'
import { createJobStore } from './job-store'

/**
 * The expiry reaper (plan 21 §4.3, §21.4) must only ever flip a `queued` job
 * to `expired` via `expireQueued()` — a `running` job is governed by the job
 * heartbeat, swept separately (`expiredRunning()`, plan 205 §4.7, since the
 * lease manager's own reaper is deleted). These tests seed `expires_at`/
 * `heartbeat_expires_at` directly (a plain past epoch second, never
 * `Date.now()` inside an assertion) so the SQL's own `strftime('%s','now')`
 * is exercised against a real, if artificial, deadline.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online') {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status })
    .run()
}

const PAST = Math.floor(Date.now() / 1000) - 3600
const FUTURE = Math.floor(Date.now() / 1000) + 3600

function seedJob(
  db: Db,
  input: { id: string; deviceId: string; status: 'queued' | 'running'; expiresAt: number | null; batchId?: string; batchSeq?: number; heartbeatExpiresAt?: number },
) {
  db.insert(jobs)
    .values({
      id: input.id,
      scriptId: 'internal:sleep',
      deviceId: input.deviceId,
      params: { durationMs: 1000 },
      priority: 0,
      status: input.status,
      createdAt: new Date(),
      startedAt: input.status === 'running' ? new Date() : null,
      heartbeatExpiresAt: input.status === 'running' ? (input.heartbeatExpiresAt ?? FUTURE) : null,
      expiresAt: input.expiresAt,
      batchId: input.batchId ?? null,
      batchSeq: input.batchSeq ?? null,
    })
    .run()
}

describe('expireQueued / createExpiryReaper — plan 21 §4.3, acceptance #4', () => {
  test('a queued job past its expiresAt becomes expired', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedJob(db, { id: 'j1', deviceId: 'd1', status: 'queued', expiresAt: PAST })
    const store = createJobStore(db)

    const expired = store.expireQueued()
    expect(expired.length).toBe(1)
    expect(expired[0]?.id).toBe('j1')

    const row = db.select().from(jobs).where(eq(jobs.id, 'j1')).get()
    expect(row?.status).toBe('expired')
    expect(row?.finishedAt).not.toBeNull()
  })

  test('a queued job with no expiresAt (wait forever) is never touched', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedJob(db, { id: 'j1', deviceId: 'd1', status: 'queued', expiresAt: null })
    const store = createJobStore(db)

    expect(store.expireQueued().length).toBe(0)
    expect(db.select().from(jobs).where(eq(jobs.id, 'j1')).get()?.status).toBe('queued')
  })

  test('a queued job whose deadline has not arrived yet is left alone', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedJob(db, { id: 'j1', deviceId: 'd1', status: 'queued', expiresAt: FUTURE })
    const store = createJobStore(db)

    expect(store.expireQueued().length).toBe(0)
    expect(db.select().from(jobs).where(eq(jobs.id, 'j1')).get()?.status).toBe('queued')
  })

  test('a RUNNING job past the same expiresAt deadline is never expired by expireQueued — only its own heartbeat governs it', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedJob(db, { id: 'j1', deviceId: 'd1', status: 'running', expiresAt: PAST })
    const store = createJobStore(db)

    expect(store.expireQueued().length).toBe(0)
    const row = db.select().from(jobs).where(eq(jobs.id, 'j1')).get()
    expect(row?.status).toBe('running')
  })

  test('a batch with one expired job reports it distinctly and reaches a terminal batch status', () => {
    const db = setUp()
    db.insert(batches)
      .values({ id: 'b1', scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status: 'queued', createdAt: new Date() })
      .run()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedJob(db, { id: 'j1', deviceId: 'd1', status: 'queued', expiresAt: PAST, batchId: 'b1', batchSeq: 0 })
    seedJob(db, { id: 'j2', deviceId: 'd2', status: 'queued', expiresAt: null, batchId: 'b1', batchSeq: 1 })
    // Finish j2 as success so the batch becomes fully terminal once j1 expires.
    db.update(jobs).set({ status: 'success', finishedAt: new Date() }).where(eq(jobs.id, 'j2')).run()

    const store = createJobStore(db)
    const seen: string[] = []
    const reaper = createExpiryReaper({
      jobStore: store,
      intervalMs: 60_000,
      log: createLogger('test'),
      onJobStatus: () => {},
      onBatchChanged: (batchId) => seen.push(batchId),
      onHeartbeatExpired: () => {},
    })
    const expired = reaper.sweepOnce()
    expect(expired.length).toBe(1)
    expect(seen).toEqual(['b1'])
  })

  /**
   * Plan 205 §4.7 — the reaper that used to belong to the deleted lease
   * manager: a running job whose heartbeat has passed is reported through
   * `onHeartbeatExpired`, not flipped to any terminal status directly by
   * this sweep (that is `host.finishExternally`'s job, wired in `daemon.ts`).
   */
  test('a running job whose heartbeat expired is reported through onHeartbeatExpired', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedJob(db, { id: 'j1', deviceId: 'd1', status: 'running', expiresAt: null, heartbeatExpiresAt: PAST })
    const store = createJobStore(db)
    const expiredIds: string[] = []
    const reaper = createExpiryReaper({
      jobStore: store,
      intervalMs: 60_000,
      log: createLogger('test'),
      onJobStatus: () => {},
      onBatchChanged: () => {},
      onHeartbeatExpired: (jobId) => expiredIds.push(jobId),
    })
    reaper.sweepOnce()
    expect(expiredIds).toEqual(['j1'])
  })

  test('a running job whose heartbeat has not expired yet is left alone', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedJob(db, { id: 'j1', deviceId: 'd1', status: 'running', expiresAt: null, heartbeatExpiresAt: FUTURE })
    const store = createJobStore(db)
    const expiredIds: string[] = []
    const reaper = createExpiryReaper({
      jobStore: store,
      intervalMs: 60_000,
      log: createLogger('test'),
      onJobStatus: () => {},
      onBatchChanged: () => {},
      onHeartbeatExpired: (jobId) => expiredIds.push(jobId),
    })
    reaper.sweepOnce()
    expect(expiredIds).toEqual([])
  })
})
