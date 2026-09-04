import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, jobEvents, jobRuns, jobs } from '../db/schema'
import { createRunStore } from './runs/store'
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

/**
 * A settled job with one run, one trace event, one artifact (row plus
 * file), and one trace frame on disk — re-keyed from `job_nodes` to
 * `job_runs`/`workflow_steps` by plan 211 (§4.5 lists the cascade: a
 * standalone script job's `workflow_steps` count is always 0, so it is not
 * separately asserted here).
 */
function seedJob(db: Db, dataDir: string, jobId: string, deviceId = 'd1'): { runId: string; artifactPath: string; traceDir: string } {
  const runs = createRunStore(db)
  const job = runs.createJob({
    kind: 'script',
    scriptId: 'internal:sleep',
    deviceId,
    params: null,
    scriptName: null,
    scriptVersion: null,
    batchId: null,
    batchSeq: null,
  })
  // The seed must land at the CALLER's chosen job id (every assertion below
  // keys off it), so the job row is renamed right after `createJob` mints
  // its own uuid — the one field `RunStore` has no "choose your own id" for.
  db.update(jobs).set({ id: jobId }).where(eq(jobs.id, job.id)).run()
  const run = runs.addRun(jobId, { trigger: 'manual' })
  db.update(jobRuns).set({ status: 'success', finishedAt: new Date() }).where(eq(jobRuns.id, run.id)).run()

  db.insert(jobEvents)
    .values({ id: `${jobId}-ev1`, runId: run.id, seq: 1, atMs: Date.now(), attempt: 1, kind: 'action', name: 'tap' })
    .run()

  const relPath = join('artifacts', run.id, 'shot.png')
  const abs = join(dataDir, relPath)
  mkdirSync(join(dataDir, 'artifacts', run.id), { recursive: true })
  writeFileSync(abs, 'png-bytes')
  db.insert(artifacts).values({ id: `${jobId}-a1`, runId: run.id, kind: 'screenshot', path: relPath, createdAt: new Date() }).run()

  const traceDir = join(dataDir, 'traces', run.id)
  mkdirSync(traceDir, { recursive: true })
  writeFileSync(join(traceDir, `${'a'.repeat(64)}.png`), 'frame-bytes')
  return { runId: run.id, artifactPath: abs, traceDir }
}

describe('deleteJobsWithHistory — the cascade (plan 128 §4.5, re-keyed to runs by plan 211)', () => {
  test('one job: job_events, the trace directory, artifact files AND rows, job_runs, and the job row all go', () => {
    const { db, dataDir } = setUp()
    const seeded = seedJob(db, dataDir, 'j1')

    const counts = deleteJobsWithHistory(db, ['j1'], { dataDir })

    expect(counts).toEqual({ jobs: 1, runs: 1, events: 1, artifacts: 1, traceDirs: 1 })
    expect(db.select().from(jobs).where(eq(jobs.id, 'j1')).all()).toEqual([])
    expect(db.select().from(jobRuns).where(eq(jobRuns.jobId, 'j1')).all()).toEqual([])
    expect(db.select().from(jobEvents).where(eq(jobEvents.runId, seeded.runId)).all()).toEqual([])
    expect(db.select().from(artifacts).where(eq(artifacts.runId, seeded.runId)).all()).toEqual([])
    expect(existsSync(seeded.artifactPath)).toBe(false)
    expect(existsSync(seeded.traceDir)).toBe(false)
  })

  test('only the named jobs go — a sibling job keeps every one of its row kinds', () => {
    const { db, dataDir } = setUp()
    seedJob(db, dataDir, 'j1')
    const keep = seedJob(db, dataDir, 'j2')

    deleteJobsWithHistory(db, ['j1'], { dataDir })

    expect(db.select().from(jobs).where(eq(jobs.id, 'j2')).all()).toHaveLength(1)
    expect(db.select().from(jobRuns).where(eq(jobRuns.jobId, 'j2')).all()).toHaveLength(1)
    expect(db.select().from(jobEvents).where(eq(jobEvents.runId, keep.runId)).all()).toHaveLength(1)
    expect(db.select().from(artifacts).where(eq(artifacts.runId, keep.runId)).all()).toHaveLength(1)
    expect(existsSync(keep.artifactPath)).toBe(true)
    expect(existsSync(keep.traceDir)).toBe(true)
  })

  test('an empty id list is a no-op, not a "delete everything" query', () => {
    const { db, dataDir } = setUp()
    seedJob(db, dataDir, 'j1')

    expect(deleteJobsWithHistory(db, [], { dataDir })).toEqual({ jobs: 0, runs: 0, events: 0, artifacts: 0, traceDirs: 0 })
    expect(db.select().from(jobs).all()).toHaveLength(1)
    expect(db.select().from(jobEvents).all()).toHaveLength(1)
  })

  test('a job with no runs at all counts everything 0 — nothing to cascade, not an error', () => {
    const { db, dataDir } = setUp()
    const runs = createRunStore(db)
    const job = runs.createJob({ kind: 'script', scriptId: 's', deviceId: 'd1', params: null, scriptName: null, scriptVersion: null, batchId: null, batchSeq: null })
    db.update(jobs).set({ id: 'j1' }).where(eq(jobs.id, job.id)).run()

    expect(deleteJobsWithHistory(db, ['j1'], { dataDir })).toEqual({
      jobs: 1,
      runs: 0,
      events: 0,
      artifacts: 0,
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
    const seeded = seedJob(db, dataDir, 'j1')

    expect(() =>
      db.transaction((tx) => {
        deleteJobsWithHistory(tx, ['j1'], { dataDir })
        throw new Error('caller changed its mind')
      }),
    ).toThrow('caller changed its mind')

    expect(db.select().from(jobs).where(eq(jobs.id, 'j1')).all()).toHaveLength(1)
    expect(db.select().from(jobEvents).where(eq(jobEvents.runId, seeded.runId)).all()).toHaveLength(1)
  })

  test('more ids than one batch: every job goes, and the counts are the sum across batches', () => {
    const { db, dataDir } = setUp()
    const runs = createRunStore(db)
    const ids: string[] = []
    for (let i = 0; i < 1200; i += 1) {
      const id = `job-${i}`
      ids.push(id)
      const job = runs.createJob({ kind: 'script', scriptId: 's', deviceId: 'd1', params: null, scriptName: null, scriptVersion: null, batchId: null, batchSeq: null })
      db.update(jobs).set({ id }).where(eq(jobs.id, job.id)).run()
      const run = runs.addRun(id, { trigger: 'manual' })
      db.insert(jobEvents).values({ id: `${id}-ev`, runId: run.id, seq: 1, atMs: 1, attempt: 1, kind: 'log', name: 'info' }).run()
    }

    const counts = deleteJobsWithHistory(db, ids, { dataDir })

    expect(counts.jobs).toBe(1200)
    expect(counts.runs).toBe(1200)
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

    expect(counts).toEqual({ jobs: 1, runs: 1, events: 1, artifacts: 1, traceDirs: 0 })
    expect(db.select().from(jobs).all()).toEqual([])
    // Honest about the half it could not do, rather than reporting a clean run.
    expect(existsSync(seeded.traceDir)).toBe(true)
    expect(warnings.join(' ')).toContain('left on disk')
  })

  test('a job id with no matching rows is a safe no-op — nothing outside the data dir is ever touched, since only DB-derived run ids ever reach a filesystem path', () => {
    const { db, dataDir } = setUp()

    expect(deleteJobsWithHistory(db, ['../../etc'], { dataDir })).toEqual({ jobs: 0, runs: 0, events: 0, artifacts: 0, traceDirs: 0 })
    expect(existsSync(dataDir)).toBe(true)
  })
})
