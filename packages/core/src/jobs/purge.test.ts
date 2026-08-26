import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, jobEvents, jobNodes, jobs } from '../db/schema'
import { deleteJobsWithHistory } from './purge'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function setUp(): { db: Db; dataDir: string } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-purge-'))
  tmpDirs.push(dataDir)
  return { db: opened.db, dataDir }
}

/** A settled job with one trace event, one artifact (row plus file), one node, and one trace frame on disk. */
function seedJob(db: Db, dataDir: string, id: string, deviceId = 'd1'): { artifactPath: string; traceDir: string } {
  db.insert(jobs).values({ id, scriptId: 'internal:sleep', deviceId, status: 'success', createdAt: new Date() }).run()
  db.insert(jobEvents)
    .values({ id: `${id}-ev1`, jobId: id, seq: 1, atMs: Date.now(), attempt: 1, kind: 'action', name: 'tap' })
    .run()
  db.insert(jobNodes).values({ id: `${id}-n1`, jobId: id, seq: 0, nodeId: 'start', kind: 'script', status: 'success' }).run()

  const relPath = join('artifacts', id, 'shot.png')
  const abs = join(dataDir, relPath)
  mkdirSync(join(dataDir, 'artifacts', id), { recursive: true })
  writeFileSync(abs, 'png-bytes')
  db.insert(artifacts).values({ id: `${id}-a1`, jobId: id, kind: 'screenshot', path: relPath, createdAt: new Date() }).run()

  const traceDir = join(dataDir, 'traces', id)
  mkdirSync(traceDir, { recursive: true })
  writeFileSync(join(traceDir, `${'a'.repeat(64)}.png`), 'frame-bytes')
  return { artifactPath: abs, traceDir }
}

describe('deleteJobsWithHistory — the five-step cascade (plan 128 §4.5)', () => {
  test('one job: job_events, the trace directory, artifact files AND rows, job_nodes, and the job row all go', () => {
    const { db, dataDir } = setUp()
    const seeded = seedJob(db, dataDir, 'j1')

    const counts = deleteJobsWithHistory(db, ['j1'], { dataDir })

    expect(counts).toEqual({ jobs: 1, events: 1, artifacts: 1, nodes: 1, traceDirs: 1 })
    expect(db.select().from(jobs).where(eq(jobs.id, 'j1')).all()).toEqual([])
    expect(db.select().from(jobEvents).where(eq(jobEvents.jobId, 'j1')).all()).toEqual([])
    expect(db.select().from(jobNodes).where(eq(jobNodes.jobId, 'j1')).all()).toEqual([])
    expect(db.select().from(artifacts).where(eq(artifacts.jobId, 'j1')).all()).toEqual([])
    expect(existsSync(seeded.artifactPath)).toBe(false)
    expect(existsSync(seeded.traceDir)).toBe(false)
  })

  test('only the named jobs go — a sibling job keeps every one of its five row kinds', () => {
    const { db, dataDir } = setUp()
    seedJob(db, dataDir, 'j1')
    const keep = seedJob(db, dataDir, 'j2')

    deleteJobsWithHistory(db, ['j1'], { dataDir })

    expect(db.select().from(jobs).where(eq(jobs.id, 'j2')).all()).toHaveLength(1)
    expect(db.select().from(jobEvents).where(eq(jobEvents.jobId, 'j2')).all()).toHaveLength(1)
    expect(db.select().from(jobNodes).where(eq(jobNodes.jobId, 'j2')).all()).toHaveLength(1)
    expect(db.select().from(artifacts).where(eq(artifacts.jobId, 'j2')).all()).toHaveLength(1)
    expect(existsSync(keep.artifactPath)).toBe(true)
    expect(existsSync(keep.traceDir)).toBe(true)
  })

  test('an empty id list is a no-op, not a "delete everything" query', () => {
    const { db, dataDir } = setUp()
    seedJob(db, dataDir, 'j1')

    expect(deleteJobsWithHistory(db, [], { dataDir })).toEqual({ jobs: 0, events: 0, artifacts: 0, nodes: 0, traceDirs: 0 })
    expect(db.select().from(jobs).all()).toHaveLength(1)
    expect(db.select().from(jobEvents).all()).toHaveLength(1)
  })

  test('a job that never captured a frame counts traceDirs 0 — the directory is absent, not an error', () => {
    const { db, dataDir } = setUp()
    db.insert(jobs).values({ id: 'j1', scriptId: 's', deviceId: 'd1', status: 'failed', createdAt: new Date() }).run()

    expect(deleteJobsWithHistory(db, ['j1'], { dataDir })).toEqual({
      jobs: 1,
      events: 0,
      artifacts: 0,
      nodes: 0,
      traceDirs: 0,
    })
  })

  test('composes with a caller that is ALREADY in a transaction (device/lifecycle.ts) — nested as a savepoint', () => {
    const { db, dataDir } = setUp()
    const seeded = seedJob(db, dataDir, 'j1')

    const counts = db.transaction((tx) => deleteJobsWithHistory(tx, ['j1'], { dataDir }))

    expect(counts.jobs).toBe(1)
    expect(db.select().from(jobs).all()).toEqual([])
    expect(existsSync(seeded.traceDir)).toBe(false)
  })

  test('the outer transaction rolling back takes the ROW half of the cascade with it', () => {
    const { db, dataDir } = setUp()
    seedJob(db, dataDir, 'j1')

    expect(() =>
      db.transaction((tx) => {
        deleteJobsWithHistory(tx, ['j1'], { dataDir })
        throw new Error('caller changed its mind')
      }),
    ).toThrow('caller changed its mind')

    expect(db.select().from(jobs).where(eq(jobs.id, 'j1')).all()).toHaveLength(1)
    expect(db.select().from(jobEvents).where(eq(jobEvents.jobId, 'j1')).all()).toHaveLength(1)
  })

  test('more ids than one batch: every job goes, and the counts are the sum across batches', () => {
    const { db, dataDir } = setUp()
    const ids: string[] = []
    for (let i = 0; i < 1200; i += 1) {
      const id = `job-${i}`
      ids.push(id)
      db.insert(jobs).values({ id, scriptId: 's', deviceId: 'd1', status: 'success', createdAt: new Date() }).run()
      db.insert(jobEvents).values({ id: `${id}-ev`, jobId: id, seq: 1, atMs: 1, attempt: 1, kind: 'log', name: 'info' }).run()
    }

    const counts = deleteJobsWithHistory(db, ids, { dataDir })

    expect(counts.jobs).toBe(1200)
    expect(counts.events).toBe(1200)
    expect(db.select().from(jobs).all()).toEqual([])
    expect(db.select().from(jobEvents).all()).toEqual([])
  })

  test('without a dataDir the ROWS still go — the files are left, and that is what it says it did', () => {
    const { db, dataDir } = setUp()
    const seeded = seedJob(db, dataDir, 'j1')
    const warnings: string[] = []

    const counts = deleteJobsWithHistory(db, ['j1'], {
      log: { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {}, child: () => null as never },
    })

    expect(counts).toEqual({ jobs: 1, events: 1, artifacts: 1, nodes: 1, traceDirs: 0 })
    expect(db.select().from(jobs).all()).toEqual([])
    // Honest about the half it could not do, rather than reporting a clean run.
    expect(existsSync(seeded.traceDir)).toBe(true)
    expect(warnings.join(' ')).toContain('left on disk')
  })

  test('a job id that could never have been written is refused before any path is built', () => {
    const { db, dataDir } = setUp()
    expect(() => deleteJobsWithHistory(db, ['../../etc'], { dataDir })).toThrow(/invalid job id/)
    // And the traversal target is untouched.
    expect(existsSync(dataDir)).toBe(true)
  })
})
