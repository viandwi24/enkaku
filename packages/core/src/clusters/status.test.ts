import { describe, expect, test } from 'bun:test'
import type { BatchCounts } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobs } from '../db/schema'
import { createJobStore } from '../queue/job-store'
import { computeBatchStatus, recomputeBatchStatus } from './status'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedBatch(db: Db, id: string, status: 'queued' | 'running' | 'stopping' | 'success' | 'failed' | 'cancelled' = 'queued') {
  db.insert(batches).values({ id, scriptId: 'internal:sleep', status, createdAt: new Date() }).run()
}

let seq = 0
function seedJob(db: Db, batchId: string, status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'expired') {
  const id = `job-${++seq}`
  db.insert(devices)
    .values({ id: `dev-${id}`, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'idle' })
    .run()
  db.insert(jobs)
    .values({ id, scriptId: 'internal:sleep', deviceId: `dev-${id}`, status, createdAt: new Date(), batchId, batchSeq: 0 })
    .run()
  return id
}

describe('computeBatchStatus (plan 20 §3.5; plan 21 §3.3 adds `expired`)', () => {
  test('any job running → running', () => {
    expect(computeBatchStatus({ total: 3, queued: 1, running: 1, success: 1, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 })).toBe(
      'running',
    )
  })

  test('all terminal, none failed → success', () => {
    expect(computeBatchStatus({ total: 2, queued: 0, running: 0, success: 2, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 })).toBe(
      'success',
    )
  })

  test('all terminal, at least one failed → failed', () => {
    expect(computeBatchStatus({ total: 3, queued: 0, running: 0, success: 2, failed: 1, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 })).toBe(
      'failed',
    )
  })

  test('all jobs cancelled → cancelled', () => {
    expect(computeBatchStatus({ total: 2, queued: 0, running: 0, success: 0, failed: 0, cancelled: 2, expired: 0, failedScript: 0, failedInfra: 0 })).toBe(
      'cancelled',
    )
  })

  test('a mix of cancelled and failed (all terminal) → failed, not cancelled', () => {
    expect(computeBatchStatus({ total: 2, queued: 0, running: 0, success: 0, failed: 1, cancelled: 1, expired: 0, failedScript: 0, failedInfra: 0 })).toBe(
      'failed',
    )
  })

  test('nothing has started yet → queued', () => {
    expect(computeBatchStatus({ total: 3, queued: 3, running: 0, success: 0, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 })).toBe(
      'queued',
    )
  })

  test('plan 21 §4.3 — an expired job reaches a terminal batch status (not stuck at queued)', () => {
    expect(computeBatchStatus({ total: 2, queued: 0, running: 0, success: 1, failed: 0, cancelled: 0, expired: 1, failedScript: 0, failedInfra: 0 })).toBe(
      'failed',
    )
  })

  test('all jobs expired → failed, distinct from success', () => {
    expect(computeBatchStatus({ total: 2, queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, expired: 2, failedScript: 0, failedInfra: 0 })).toBe(
      'failed',
    )
  })
})

describe('recomputeBatchStatus — writes finishedAt exactly once and always broadcasts (plan 20 §4.5)', () => {
  test('flips to success and sets finishedAt when the last job finishes', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1')
    const j1 = seedJob(db, 'b1', 'running')
    seedJob(db, 'b1', 'success')

    const broadcasts: unknown[] = []
    recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')
    let row = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(row?.status).toBe('running')
    expect(row?.finishedAt).toBeNull()

    db.update(jobs).set({ status: 'success' }).where(eq(jobs.id, j1)).run()
    recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')
    row = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(row?.status).toBe('success')
    expect(row?.finishedAt).not.toBeNull()
    expect(broadcasts.length).toBe(2)

    const finishedAtFirst = row?.finishedAt
    // A further recompute must not move finishedAt (set exactly once).
    recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')
    row = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(row?.finishedAt?.getTime()).toBe(finishedAtFirst?.getTime())
  })

  test('always broadcasts, even when the overall status text is unchanged (progress ticking)', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1')
    seedJob(db, 'b1', 'running')
    seedJob(db, 'b1', 'queued')
    seedJob(db, 'b1', 'queued')

    const broadcasts: { payload: { counts: BatchCounts } }[] = []
    recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')
    expect(broadcasts[0]?.payload.counts).toEqual({
      total: 3,
      queued: 2,
      running: 1,
      success: 0,
      failed: 0,
      cancelled: 0,
      expired: 0,
      failedScript: 0,
      failedInfra: 0,
    })
  })

  test('all-cancelled batch flips to cancelled with finishedAt set', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1')
    seedJob(db, 'b1', 'cancelled')
    seedJob(db, 'b1', 'cancelled')

    recomputeBatchStatus({ db, jobStore, broadcast: () => {} }, 'b1')
    const row = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(row?.status).toBe('cancelled')
    expect(row?.finishedAt).not.toBeNull()
  })

  test('plan 36 §4.4 — failed jobs split into failedScript vs failedInfra by jobs.failureClass', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1')
    const scriptFail = seedJob(db, 'b1', 'failed')
    const infraFail = seedJob(db, 'b1', 'failed')
    const loadFail = seedJob(db, 'b1', 'failed')
    seedJob(db, 'b1', 'success')
    db.update(jobs).set({ failureClass: 'script' }).where(eq(jobs.id, scriptFail)).run()
    db.update(jobs).set({ failureClass: 'infra' }).where(eq(jobs.id, infraFail)).run()
    db.update(jobs).set({ failureClass: 'load' }).where(eq(jobs.id, loadFail)).run()

    const broadcasts: { payload: { counts: BatchCounts } }[] = []
    recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')
    const counts = broadcasts[0]?.payload.counts
    expect(counts?.failed).toBe(3)
    expect(counts?.failedScript).toBe(1)
    // `load` rolls into the infra bucket too — it is still a farm-caused
    // failure from the batch's point of view, not the script's fault.
    expect(counts?.failedInfra).toBe(2)
  })

  test('plan 21 §4.3 — a batch with one expired job (the rest terminal) reaches "failed", not stuck at "queued"', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1')
    seedJob(db, 'b1', 'success')
    seedJob(db, 'b1', 'expired')

    const broadcasts: { payload: { status: string } }[] = []
    recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')
    const row = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(row?.status).toBe('failed')
    expect(row?.finishedAt).not.toBeNull()
    expect(broadcasts[0]?.payload.status).toBe('failed')
  })
})

/**
 * `docs/plans/96-m61-hotfixes.md` §96.30 — the owner's own stuck tray entry,
 * reproduced directly: a batch whose every job row is gone (the real path is
 * `device/lifecycle.ts`'s `forget({ deleteHistory: true })`, simulated here
 * by deleting the job row straight from the DB — the effect on this
 * function is identical either way, since it only ever reads
 * `jobStore.listByBatch`) must reach a TERMINAL status instead of being held
 * at whatever it was — this is the write-time half of the fix; `api/
 * batches.ts`'s `statusOf` (proven in `batches.test.ts`) is the read-time
 * half that heals a row already stuck in the database before this fix
 * shipped, with no migration and no backfill.
 */
describe('recomputeBatchStatus — a batch with zero jobs resolves to a terminal status instead of being held (§96.30)', () => {
  test('`stopping` with no jobs left reaches `cancelled`, not held forever — reproduces the owner\'s stuck tray entry', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1', 'stopping')
    // No jobs at all — mirrors `stopBatch`'s own call site on a batch whose
    // only device was already forgotten before the operator hit Stop.

    const broadcasts: { payload: { status: string } }[] = []
    const result = recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')

    const row = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(row?.status).toBe('cancelled')
    expect(row?.finishedAt).not.toBeNull()
    expect(result?.status).toBe('cancelled')
    expect(broadcasts[0]?.payload.status).toBe('cancelled')
  })

  test('a stale `running`/`queued` row with zero jobs also resolves to `cancelled`, not just `stopping`', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1', 'running')

    recomputeBatchStatus({ db, jobStore, broadcast: () => {} }, 'b1')
    const row = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(row?.status).toBe('cancelled')
    expect(row?.finishedAt).not.toBeNull()
  })

  test('a batch already terminal with zero jobs is left alone — no re-broadcast, no finishedAt disturbed', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    seedBatch(db, 'b1', 'success')
    const before = db.select().from(batches).where(eq(batches.id, 'b1')).get()

    const broadcasts: unknown[] = []
    const result = recomputeBatchStatus({ db, jobStore, broadcast: (m) => broadcasts.push(m) }, 'b1')

    expect(result).toBeNull()
    expect(broadcasts).toHaveLength(0)
    const after = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(after?.status).toBe('success')
    expect(after?.finishedAt?.getTime()).toBe(before?.finishedAt?.getTime())
  })

  test('an unknown batch id still returns null (unaffected by the new branch)', () => {
    const db = setUp()
    const jobStore = createJobStore(db)
    expect(recomputeBatchStatus({ db, jobStore, broadcast: () => {} }, 'no-such-batch')).toBeNull()
  })
})
