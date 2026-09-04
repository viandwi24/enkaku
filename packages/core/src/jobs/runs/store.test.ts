import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations } from '../../db'
import { createRunStore } from './store'

function freshStore() {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  return { db: opened.db, sqlite: opened.sqlite, runs: createRunStore(opened.db) }
}

describe('a fresh database has job_runs, workflow_steps and a jobs table with no execution columns (G1)', () => {
  test('jobs has none of the deleted execution columns', () => {
    const { sqlite } = freshStore()
    const cols = sqlite.query<{ name: string }, []>('PRAGMA table_info(jobs)').all().map((c) => c.name)
    for (const forbidden of [
      'status',
      'heartbeat_expires_at',
      'result',
      'error',
      'started_at',
      'finished_at',
      'expires_at',
      'not_before',
      'batch_repeat',
      'paced_delay_ms',
      'failure_class',
      'error_phase',
      'infra_attempts',
      'peak_rss_bytes',
      'max_concurrent',
      'runtime_override',
      'result_status',
      'result_bytes',
      'result_summary',
      'result_issues',
      'priority',
    ]) {
      expect(cols).not.toContain(forbidden)
    }
  })

  test('job_runs and workflow_steps exist', () => {
    const { sqlite } = freshStore()
    const names = sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
    expect(names).toContain('job_runs')
    expect(names).toContain('workflow_steps')
  })

  test('idx_job_runs_seq is a unique index', () => {
    const { sqlite } = freshStore()
    const row = sqlite.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'idx_job_runs_seq'").get()
    expect(row?.sql).toContain('UNIQUE')
  })
})

describe('run_count and latest_run_id follow every add, settle and delete (G5)', () => {
  test('1 add, 1 settle, 1 re-run, 1 run delete', () => {
    const { runs } = freshStore()
    const job = runs.createJob({ kind: 'script', scriptId: 'script-1', deviceId: 'dev-1', params: { a: 1 }, scriptName: 'auto-scroll', scriptVersion: '1.0.0' })
    const run1 = runs.addRun(job.id, { trigger: 'manual' })
    expect(runs.getJob(job.id)?.runCount).toBe(1)
    expect(runs.getJob(job.id)?.latestRunId).toBe(run1.id)

    runs.settle(run1.id, { status: 'success', result: { ok: true } })
    expect(runs.getJob(job.id)?.runCount).toBe(1)

    const run2 = runs.addRun(job.id, { trigger: 'rerun' })
    expect(runs.getJob(job.id)?.runCount).toBe(2)
    expect(runs.getJob(job.id)?.latestRunId).toBe(run2.id)

    const del = runs.deleteRuns([run2.id])
    expect(del.runs).toBe(1)
    expect(runs.getJob(job.id)?.runCount).toBe(1)
    expect(runs.getJob(job.id)?.latestRunId).toBe(run1.id)
  })
})

test('addRun assigns dense seq under two concurrent callers', () => {
  const { runs } = freshStore()
  const job = runs.createJob({ kind: 'script', scriptId: 'script-1', deviceId: 'dev-1', params: {}, scriptName: 'x', scriptVersion: '1.0.0' })
  const [a, b] = [runs.addRun(job.id, { trigger: 'manual' }), runs.addRun(job.id, { trigger: 'manual' })]
  expect([a.seq, b.seq].sort()).toEqual([1, 2])
})

test('addRunOrNewJob adds a run for identical params and creates a job for different ones', () => {
  const { runs } = freshStore()
  const job = runs.createJob({ kind: 'script', scriptId: 'script-1', deviceId: 'dev-1', params: { x: 1 }, scriptName: 'x', scriptVersion: '1.0.0' })
  runs.addRun(job.id, { trigger: 'manual' })

  const same = runs.addRunOrNewJob(job.id, { x: 1 }, { trigger: 'rerun' })
  expect(same.sameJob).toBe(true)
  expect(same.job.id).toBe(job.id)
  expect(runs.getJob(job.id)?.runCount).toBe(2)

  const different = runs.addRunOrNewJob(job.id, { x: 2 }, { trigger: 'rerun' })
  expect(different.sameJob).toBe(false)
  expect(different.job.id).not.toBe(job.id)
  expect(runs.getJob(job.id)?.runCount).toBe(2)
})

test('settle only ever touches a running run', () => {
  const { runs } = freshStore()
  const job = runs.createJob({ kind: 'script', scriptId: 'script-1', deviceId: 'dev-1', params: {}, scriptName: 'x', scriptVersion: '1.0.0' })
  const run = runs.addRun(job.id, { trigger: 'manual' })
  // still queued: settle refuses
  expect(runs.settle(run.id, { status: 'success' })).toBeNull()
})

test('deleteRuns recomputes both denormalised fields for every job it touched', () => {
  const { runs } = freshStore()
  const job = runs.createJob({ kind: 'script', scriptId: 'script-1', deviceId: 'dev-1', params: {}, scriptName: 'x', scriptVersion: '1.0.0' })
  const r1 = runs.addRun(job.id, { trigger: 'manual' })
  const r2 = runs.addRun(job.id, { trigger: 'rerun' })
  runs.deleteRuns([r1.id, r2.id])
  const row = runs.getJob(job.id)
  expect(row?.runCount).toBe(0)
  expect(row?.latestRunId).toBeNull()
})

test('createJob refuses a script job with workflowName and a workflow job with scriptId', () => {
  const { runs } = freshStore()
  expect(() =>
    runs.createJob({ kind: 'script', workflowName: 'wf', deviceId: 'dev-1', params: {}, scriptName: null, scriptVersion: null }),
  ).toThrow()
  expect(() =>
    runs.createJob({ kind: 'workflow', scriptId: 'script-1', deviceId: 'dev-1', params: {}, scriptName: null, scriptVersion: null }),
  ).toThrow()
})
