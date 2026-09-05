import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../../db'
import { jobRuns } from '../../db/schema'
import { createRunStore } from './store'
import { createRunRetentionSweeper, NO_OP_RUN_SWEEPER, type RunRetentionPolicy } from './sweeper'

function freshStore() {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  return { db: opened.db, runs: createRunStore(opened.db) }
}

/** Directly ages and settles a run so a test does not have to drive it through `queued -> running -> settle`. */
function settleAged(db: ReturnType<typeof freshStore>['db'], runId: string, daysAgo: number, status: 'success' | 'failed' = 'success') {
  const finishedAt = new Date(Date.now() - daysAgo * 86_400_000)
  db.update(jobRuns).set({ status, finishedAt }).where(eq(jobRuns.id, runId)).run()
}

const POLICY: RunRetentionPolicy = { runDays: 30, keepLatest: true, chunk: 500 }

describe('createRunRetentionSweeper', () => {
  test('deletes only runs older than runDays', () => {
    const { db, runs } = freshStore()
    const job = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const oldRun = runs.addRun(job.id, { trigger: 'manual' })
    settleAged(db, oldRun.id, 40)
    const nextRun = runs.addRun(job.id, { trigger: 'manual' })
    settleAged(db, nextRun.id, 1)

    const sweeper = createRunRetentionSweeper({ db, runs, policy: POLICY })
    const result = sweeper.sweepOnce()

    expect(result.runs).toBe(1)
    expect(runs.getRun(oldRun.id)).toBeNull()
    expect(runs.getRun(nextRun.id)).not.toBeNull()
  })

  test("it never deletes a job's latest run", () => {
    const { db, runs } = freshStore()
    const job = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const onlyRun = runs.addRun(job.id, { trigger: 'manual' })
    settleAged(db, onlyRun.id, 200) // very old, but it is the job's only (and therefore latest) run

    const sweeper = createRunRetentionSweeper({ db, runs, policy: POLICY })
    const result = sweeper.sweepOnce()

    expect(result.runs).toBe(0)
    expect(runs.getRun(onlyRun.id)).not.toBeNull()
  })

  test('it recomputes run_count and latest_run_id after a delete', () => {
    const { db, runs } = freshStore()
    const job = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const r1 = runs.addRun(job.id, { trigger: 'manual' })
    settleAged(db, r1.id, 40)
    const r2 = runs.addRun(job.id, { trigger: 'manual' })
    settleAged(db, r2.id, 40)
    const r3 = runs.addRun(job.id, { trigger: 'manual' })
    settleAged(db, r3.id, 1)

    const sweeper = createRunRetentionSweeper({ db, runs, policy: POLICY })
    sweeper.sweepOnce()

    const reloaded = runs.getJob(job.id)
    expect(reloaded?.runCount).toBe(1)
    expect(reloaded?.latestRunId).toBe(r3.id)
  })

  test('NO_OP_RUN_SWEEPER still returns zero for both counts', () => {
    expect(NO_OP_RUN_SWEEPER.sweepOnce()).toEqual({ runs: 0, jobs: 0 })
  })

  test('a `simulate` run is pruned on its OWN, much shorter horizon — independent of policy.runDays, and even as its job\'s only run (plan 309 §3.4, G4)', () => {
    const { db, runs } = freshStore()
    const job = runs.createJob({ kind: 'workflow', workflowName: 'wf', deviceId: '', params: {}, scriptName: 'wf', scriptVersion: null })
    const simRun = runs.addRun(job.id, { trigger: 'simulate' })
    // Well under `policy.runDays` (30) but past `SIMULATE_RUN_RETENTION_DAYS` (2).
    settleAged(db, simRun.id, 3)

    const sweeper = createRunRetentionSweeper({ db, runs, policy: POLICY })
    const result = sweeper.sweepOnce()

    expect(result.runs).toBe(1)
    expect(runs.getRun(simRun.id)).toBeNull()
    // The job existed for this run alone — it is swept too.
    expect(result.jobs).toBe(1)
    expect(runs.getJob(job.id)).toBeNull()
  })

  test('a fresh `simulate` run, still within its own short horizon, survives a sweep', () => {
    const { db, runs } = freshStore()
    const job = runs.createJob({ kind: 'workflow', workflowName: 'wf', deviceId: '', params: {}, scriptName: 'wf', scriptVersion: null })
    const simRun = runs.addRun(job.id, { trigger: 'simulate' })
    settleAged(db, simRun.id, 1)

    const sweeper = createRunRetentionSweeper({ db, runs, policy: POLICY })
    const result = sweeper.sweepOnce()

    expect(result.runs).toBe(0)
    expect(runs.getRun(simRun.id)).not.toBeNull()
  })
})
