import { describe, expect, test } from 'bun:test'
import { and, asc, eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from './index'
import { jobEvents, type JobEventInsert } from './schema'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/** A minimal valid row; callers override whatever the case is about. */
function event(over: Partial<JobEventInsert> & Pick<JobEventInsert, 'id' | 'jobId' | 'seq' | 'atMs'>): JobEventInsert {
  return { kind: 'action', name: 'tap', ...over }
}

describe('job_events table', () => {
  test('inserts and reads back every column', () => {
    const db = setUp()
    db.insert(jobEvents)
      .values(
        event({
          id: 'e1',
          jobId: 'job-1',
          seq: 1,
          atMs: 1_724_600_000_123,
          attempt: 2,
          phase: 'run',
          nodeId: 'node-a',
          kind: 'action',
          name: 'find',
          durationMs: 42,
          ok: false,
          errorCode: 'not-found',
          meta: { args: { sel: { text: 'Post' } } },
          frameHash: 'a'.repeat(64),
          frameStatus: 'ok',
          uiHash: 'b'.repeat(64),
        }),
      )
      .run()

    const rows = db.select().from(jobEvents).all()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.jobId).toBe('job-1')
    expect(row.seq).toBe(1)
    expect(row.atMs).toBe(1_724_600_000_123)
    expect(row.attempt).toBe(2)
    expect(row.phase).toBe('run')
    expect(row.nodeId).toBe('node-a')
    expect(row.kind).toBe('action')
    expect(row.name).toBe('find')
    expect(row.durationMs).toBe(42)
    expect(row.ok).toBe(false)
    expect(row.errorCode).toBe('not-found')
    expect(row.meta).toEqual({ args: { sel: { text: 'Post' } } })
    expect(row.frameHash).toBe('a'.repeat(64))
    expect(row.frameStatus).toBe('ok')
    expect(row.uiHash).toBe('b'.repeat(64))
  })

  test('atMs holds unix MILLISECONDS, so two events inside one second stay distinct', () => {
    // Plan 128 §3.3 and §8 R4: the whole reason `at_ms` is not `{ mode: 'timestamp' }`.
    // Two taps 180 ms apart — a seconds column would collapse them onto one instant.
    const db = setUp()
    const firstTap = 1_724_600_000_020
    const secondTap = 1_724_600_000_200
    expect(Math.floor(firstTap / 1000)).toBe(Math.floor(secondTap / 1000)) // same second
    expect(secondTap - firstTap).toBe(180)

    db.insert(jobEvents)
      .values([
        event({ id: 'e2', jobId: 'job-1', seq: 2, atMs: secondTap, name: 'tap' }),
        event({ id: 'e1', jobId: 'job-1', seq: 1, atMs: firstTap, name: 'tap' }),
      ])
      .run()

    const rows = db.select().from(jobEvents).orderBy(asc(jobEvents.seq)).all()
    expect(rows.map((r) => r.id)).toEqual(['e1', 'e2'])
    // Sub-second resolution survives the round trip — the gap is still readable.
    expect(rows[1]!.atMs - rows[0]!.atMs).toBe(180)
  })

  test('(jobId, seq) orders deterministically even when atMs collides', () => {
    const db = setUp()
    const sameMs = 1_724_600_000_500
    db.insert(jobEvents)
      .values([
        event({ id: 'b', jobId: 'job-1', seq: 3, atMs: sameMs, kind: 'log', name: 'info' }),
        event({ id: 'c', jobId: 'job-2', seq: 1, atMs: sameMs }),
        event({ id: 'a', jobId: 'job-1', seq: 2, atMs: sameMs, kind: 'log', name: 'info' }),
      ])
      .run()

    const job1 = db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, 'job-1'))
      .orderBy(asc(jobEvents.jobId), asc(jobEvents.seq))
      .all()
    expect(job1.map((r) => r.seq)).toEqual([2, 3])
    expect(job1.map((r) => r.id)).toEqual(['a', 'b'])

    // The seq counter is per job, so job-2 may reuse 1 without colliding.
    const job2 = db.select().from(jobEvents).where(and(eq(jobEvents.jobId, 'job-2'), eq(jobEvents.seq, 1))).all()
    expect(job2.map((r) => r.id)).toEqual(['c'])
  })

  test('(jobId, seq) is unique, and `attempt` defaults to 1', () => {
    const db = setUp()
    db.insert(jobEvents).values(event({ id: 'e1', jobId: 'job-1', seq: 1, atMs: 1 })).run()
    expect(db.select().from(jobEvents).all()[0]!.attempt).toBe(1)
    expect(() => db.insert(jobEvents).values(event({ id: 'e2', jobId: 'job-1', seq: 1, atMs: 2 })).run()).toThrow()
    // A different job with the same seq is fine.
    db.insert(jobEvents).values(event({ id: 'e3', jobId: 'job-2', seq: 1, atMs: 3 })).run()
    expect(db.select().from(jobEvents).all()).toHaveLength(2)
  })
})
