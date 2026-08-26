import { describe, expect, test } from 'bun:test'
import type { JobTraceEvent } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../../db'
import { jobEvents } from '../../db/schema'
import { createTraceRecorder } from './recorder'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/** Counts real `db.transaction()` calls so "one transaction per flush" is measured, not assumed. */
function countTransactions(db: Db): { count: () => number } {
  const original = db.transaction.bind(db)
  let calls = 0
  db.transaction = ((fn: Parameters<typeof original>[0]) => {
    calls++
    return original(fn)
  }) as typeof db.transaction

  return { count: () => calls }
}

const action = (jobId: string, name: string): Parameters<ReturnType<typeof createTraceRecorder>['record']>[0] => ({
  jobId,
  kind: 'action',
  name,
  phase: 'run',
  durationMs: 12,
  ok: true,
})

describe('createTraceRecorder', () => {
  test('300 events flush in batches, one transaction each — never one per row', async () => {
    const db = setUp()
    const spy = countTransactions(db)
    const published: JobTraceEvent[] = []
    const recorder = createTraceRecorder({
      db,
      publish: (_jobId, ev) => published.push(ev),
      maxBufferedRows: 50,
      flushIntervalMs: 60_000, // never fires on its own during this test
    })

    for (let i = 0; i < 300; i++) recorder.record(action('job-1', 'tap'))

    // 300 rows at a 50-row ceiling is exactly 6 full-buffer flushes.
    expect(spy.count()).toBe(6)
    expect(published).toHaveLength(300)
    expect(db.select().from(jobEvents).all()).toHaveLength(300)

    await recorder.stop()
  })

  test('publish fires synchronously, before the row exists in the DB', async () => {
    const db = setUp()
    const seenWhilePublishing: number[] = []
    const recorder = createTraceRecorder({
      db,
      // Reading the table from INSIDE publish is the only way to assert the
      // ordering rule rather than the timing (plan 128 §3.6).
      publish: () => seenWhilePublishing.push(db.select().from(jobEvents).all().length),
      maxBufferedRows: 1000,
      flushIntervalMs: 60_000,
    })

    recorder.record(action('job-1', 'tap'))
    recorder.record(action('job-1', 'swipe'))

    expect(seenWhilePublishing).toEqual([0, 0])
    expect(db.select().from(jobEvents).all()).toHaveLength(0)

    await recorder.stop()
    expect(db.select().from(jobEvents).all()).toHaveLength(2)
  })

  test('record() assigns a per-job monotonic seq and returns the stored event', async () => {
    const db = setUp()
    const recorder = createTraceRecorder({ db, publish: () => {}, flushIntervalMs: 60_000 })

    const a = recorder.record(action('job-1', 'tap'))
    const b = recorder.record(action('job-2', 'tap'))
    const c = recorder.record(action('job-1', 'find'))

    expect([a.seq, c.seq]).toEqual([1, 2])
    expect(b.seq).toBe(1) // a different job has its own sequence
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)

    await recorder.stop()
    const rows = db.select().from(jobEvents).all()
    expect(rows.find((r) => r.id === c.id)?.seq).toBe(2)
  })

  test('a second run of the same job continues the sequence instead of colliding with it', async () => {
    const db = setUp()
    const first = createTraceRecorder({ db, publish: () => {}, flushIntervalMs: 60_000 })
    first.record(action('job-1', 'tap'))
    first.record(action('job-1', 'tap'))
    await first.stop()

    // A fresh recorder — a restarted daemon, or a rebound job whose counter
    // was released by `flush(jobId)`. `(job_id, seq)` is UNIQUE: restarting at
    // 1 would fail the whole batch.
    const second = createTraceRecorder({ db, publish: () => {}, flushIntervalMs: 60_000 })
    const next = second.record({ ...action('job-1', 'tap'), attempt: 2 })
    expect(next.seq).toBe(3)

    await second.stop()
    expect(db.select().from(jobEvents).all().map((r) => r.seq).sort()).toEqual([1, 2, 3])
  })

  test('flush(jobId) writes immediately — a settled job\'s timeline is complete at once', () => {
    const db = setUp()
    const recorder = createTraceRecorder({
      db,
      publish: () => {},
      maxBufferedRows: 1000,
      flushIntervalMs: 60_000,
    })

    recorder.record({ jobId: 'job-1', kind: 'phase', name: 'start', phase: 'run' })
    recorder.record(action('job-1', 'tap'))
    expect(db.select().from(jobEvents).all()).toHaveLength(0)

    recorder.flush('job-1')

    expect(db.select().from(jobEvents).all()).toHaveLength(2)
    // The counter was released with the flush; the next event re-seeds from
    // the rows now on disk rather than restarting at 1.
    expect(recorder.record(action('job-1', 'swipe')).seq).toBe(3)
    recorder.flush('job-1')
  })

  test('stop() drains whatever is still buffered, then records nothing more', async () => {
    const db = setUp()
    const published: JobTraceEvent[] = []
    const recorder = createTraceRecorder({
      db,
      publish: (_jobId, ev) => published.push(ev),
      maxBufferedRows: 1000,
      flushIntervalMs: 60_000,
    })

    for (let i = 0; i < 17; i++) recorder.record(action('job-1', 'tap'))
    expect(db.select().from(jobEvents).all()).toHaveLength(0)

    await recorder.stop()
    expect(db.select().from(jobEvents).all()).toHaveLength(17)

    // After shutdown a late event is dropped, not thrown — the tee calling it
    // sits one line from a device call.
    expect(() => recorder.record(action('job-1', 'tap'))).not.toThrow()
    expect(published).toHaveLength(17)
    expect(db.select().from(jobEvents).all()).toHaveLength(17)
  })

  test('sub-second ordering survives the round trip — atMs is milliseconds, not seconds', async () => {
    const db = setUp()
    const recorder = createTraceRecorder({ db, publish: () => {}, flushIntervalMs: 60_000 })

    recorder.record({ ...action('job-1', 'tap'), atMs: 1_756_000_000_000 })
    recorder.record({ ...action('job-1', 'tap'), atMs: 1_756_000_000_180 })
    await recorder.stop()

    const rows = db.select().from(jobEvents).all().sort((x, y) => x.seq - y.seq)
    expect(rows.map((r) => r.atMs)).toEqual([1_756_000_000_000, 1_756_000_000_180])
    expect(rows[1]!.atMs - rows[0]!.atMs).toBe(180)
  })

  test('the timer flushes a partial buffer on its own', async () => {
    const db = setUp()
    const recorder = createTraceRecorder({ db, publish: () => {}, maxBufferedRows: 1000, flushIntervalMs: 5 })

    recorder.record(action('job-1', 'tap'))
    expect(db.select().from(jobEvents).all()).toHaveLength(0)

    await Bun.sleep(40)
    expect(db.select().from(jobEvents).all()).toHaveLength(1)

    await recorder.stop()
  })

  test('meta, outcome and capture status round-trip through the JSON column', async () => {
    const db = setUp()
    const recorder = createTraceRecorder({ db, publish: () => {}, flushIntervalMs: 60_000 })

    const ev = recorder.record({
      jobId: 'job-1',
      kind: 'action',
      name: 'find',
      phase: 'run',
      nodeId: 'scroll-fyp',
      attempt: 2,
      durationMs: 940,
      ok: false,
      errorCode: 'not-found',
      meta: { args: { sel: { text: 'Post' } }, truncated: false },
      frameHash: 'a'.repeat(64),
      frameStatus: 'ok',
      uiHash: 'b'.repeat(64),
    })
    await recorder.stop()

    const row = db.select().from(jobEvents).all()[0]!
    expect(row.id).toBe(ev.id)
    expect(row.ok).toBe(false)
    expect(row.errorCode).toBe('not-found')
    expect(row.nodeId).toBe('scroll-fyp')
    expect(row.attempt).toBe(2)
    expect(row.frameStatus).toBe('ok')
    expect(row.meta).toEqual({ args: { sel: { text: 'Post' } }, truncated: false })
  })

  test('a publish that throws does not travel back into the caller, and the row is still written', async () => {
    const db = setUp()
    const recorder = createTraceRecorder({
      db,
      publish: () => {
        throw new Error('ws broadcast exploded')
      },
      flushIntervalMs: 60_000,
    })

    expect(() => recorder.record(action('job-1', 'tap'))).not.toThrow()

    await recorder.stop()
    expect(db.select().from(jobEvents).all()).toHaveLength(1)
  })

  test('a batch that cannot be written is dropped with a log, never thrown at the caller', async () => {
    const db = setUp()
    const recorder = createTraceRecorder({ db, publish: () => {}, flushIntervalMs: 60_000 })
    const broken = createTraceRecorder({ db, publish: () => {}, flushIntervalMs: 60_000 })

    // Two independent recorders over one DB is the pathological case the
    // unique index exists for: both hand out seq 1 for the same job.
    recorder.record(action('job-1', 'tap'))
    broken.record(action('job-1', 'tap'))
    recorder.flush('job-1')

    // The colliding batch loses its rows; the daemon does not lose its life.
    expect(() => broken.flush('job-1')).not.toThrow()
    expect(db.select().from(jobEvents).all()).toHaveLength(1)

    await recorder.stop()
    await broken.stop()
  })
})
