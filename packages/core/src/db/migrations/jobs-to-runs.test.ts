import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations, runMigrationsUpTo } from '../index'
import { artifacts, jobEvents, jobRuns, jobs, schedules } from '../schema'
import type { Logger } from '../../util/logger'
import { JOBS_TO_RUNS_TAG, migrateJobsToRuns } from './jobs-to-runs'

function collectLogs(): { log: Logger; infos: string[]; warns: string[] } {
  const infos: string[] = []
  const warns: string[] = []
  const log: Logger = { debug: () => {}, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => {}, child: () => log }
  return { log, infos, warns }
}

describe('migrateJobsToRuns (plan 211 §4.10)', () => {
  test('every existing job becomes one run at seq 1 with its history re-keyed', () => {
    const opened = openDb(':memory:')
    const db = opened.db
    runMigrationsUpTo(db, JOBS_TO_RUNS_TAG)

    // A settled job with two trace events and one artifact.
    db.run(
      sql`INSERT INTO jobs (id, script_id, device_id, params, priority, status, result, error, created_at, started_at, finished_at, script_name, script_version)
          VALUES ('job-1', 's1', 'dev-1', '{}', 0, 'success', '{"ok":true}', NULL, 1700000000, 1700000001, 1700000010, 'auto-scroll', '1.0.0')`,
    )
    db.run(sql`INSERT INTO job_events (id, job_id, seq, at_ms, attempt, kind, name, ok) VALUES ('ev-1', 'job-1', 1, 1700000001000, 1, 'phase', 'start', 1)`)
    db.run(sql`INSERT INTO job_events (id, job_id, seq, at_ms, attempt, kind, name, ok) VALUES ('ev-2', 'job-1', 2, 1700000002000, 1, 'phase', 'end', 1)`)
    db.run(sql`INSERT INTO artifacts (id, job_id, kind, path, created_at) VALUES ('art-1', 'job-1', 'screenshot', 'artifacts/job-1/shot.png', 1700000005)`)

    // A queued batch member.
    db.run(sql`INSERT INTO batches (id, script_id, created_at) VALUES ('batch-1', 's1', 1700000000)`)
    db.run(
      sql`INSERT INTO jobs (id, script_id, device_id, priority, status, batch_id, batch_seq, created_at)
          VALUES ('job-2', 's1', 'dev-2', 0, 'queued', 'batch-1', 0, 1700000000)`,
    )

    // A failed job with a resume chain of two: job-3 -> resumed by job-4.
    db.run(
      sql`INSERT INTO jobs (id, script_id, device_id, status, created_at) VALUES ('job-3', 's1', 'dev-3', 'failed', 1700000000)`,
    )
    db.run(
      sql`INSERT INTO jobs (id, script_id, device_id, status, created_at) VALUES ('job-4', 's1', 'dev-3', 'success', 1700000100)`,
    )
    db.run(
      sql`INSERT INTO job_resumes (job_id, resumed_from_job_id, resumed_from_node, created_at) VALUES ('job-4', 'job-3', 'n0', 1700000100)`,
    )

    db.run(sql`INSERT INTO schedule_runs (id, schedule_id, due_at, fired_at, outcome, batch_id, missed_count) VALUES ('sr-1', 'sched-none', 1700000000, 1700000000, 'dispatched', 'batch-1', 0)`)

    runMigrations(db, opened.sqlite)

    const dataDir = mkdtempSync(join(tmpdir(), 'jobs-to-runs-'))
    mkdirSync(join(dataDir, 'traces', 'job-1'), { recursive: true })
    writeFileSync(join(dataDir, 'traces', 'job-1', 'abc.png'), 'x')

    const { log } = collectLogs()
    const report = migrateJobsToRuns(db, { log, dataDir })
    expect(report).not.toBeNull()

    // Second run is a no-op.
    expect(migrateJobsToRuns(db, { log, dataDir })).toBeNull()

    const job1 = db.select().from(jobs).where(eq(jobs.id, 'job-1')).get()
    expect(job1?.runCount).toBe(1)
    expect(job1?.latestRunId).toBeTruthy()
    const run1 = db.select().from(jobRuns).where(eq(jobRuns.jobId, 'job-1')).all()
    expect(run1).toHaveLength(1)
    expect(run1[0]?.seq).toBe(1)
    expect(run1[0]?.status).toBe('success')

    const events = db.select().from(jobEvents).all()
    for (const ev of events) {
      expect(ev.runId).toBe(run1[0]!.id)
    }
    const arts = db.select().from(artifacts).where(eq(artifacts.id, 'art-1')).get()
    expect(arts?.runId).toBe(run1[0]!.id)

    expect(existsSync(join(dataDir, 'traces', run1[0]!.id, 'abc.png'))).toBe(true)
    expect(existsSync(join(dataDir, 'traces', 'job-1'))).toBe(false)

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('a resume chain is folded into the earliest job', () => {
    const opened = openDb(':memory:')
    const db = opened.db
    runMigrationsUpTo(db, JOBS_TO_RUNS_TAG)
    db.run(sql`INSERT INTO jobs (id, script_id, device_id, status, created_at) VALUES ('job-3', 's1', 'dev-3', 'failed', 1700000000)`)
    db.run(sql`INSERT INTO jobs (id, script_id, device_id, status, created_at) VALUES ('job-4', 's1', 'dev-3', 'success', 1700000100)`)
    db.run(sql`INSERT INTO job_resumes (job_id, resumed_from_job_id, resumed_from_node, created_at) VALUES ('job-4', 'job-3', 'n0', 1700000100)`)
    runMigrations(db, opened.sqlite)

    const dataDir = mkdtempSync(join(tmpdir(), 'jobs-to-runs-'))
    const { log } = collectLogs()
    migrateJobsToRuns(db, { log, dataDir })

    expect(db.select().from(jobs).where(eq(jobs.id, 'job-4')).get()).toBeUndefined()
    const root = db.select().from(jobs).where(eq(jobs.id, 'job-3')).get()
    expect(root?.runCount).toBe(2)
    const runsOfRoot = db.select().from(jobRuns).where(eq(jobRuns.jobId, 'job-3')).all()
    expect(runsOfRoot).toHaveLength(2)
    const resumedRun = runsOfRoot.find((r) => r.seq === 2)
    expect(resumedRun?.trigger).toBe('resume')
    expect(resumedRun?.resumedFromRunId).toBeTruthy()

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('the schedule adopts its batch and its last outcome', () => {
    const opened = openDb(':memory:')
    const db = opened.db
    runMigrationsUpTo(db, JOBS_TO_RUNS_TAG)
    db.run(sql`INSERT INTO batches (id, script_id, created_at) VALUES ('batch-1', 's1', 1700000000)`)
    db.run(
      sql`INSERT INTO schedules (id, name, cron, timezone, script_ref, created_at) VALUES ('sched-1', 'Nightly', '0 0 * * *', 'UTC', 's1@1.0.0', 1700000000)`,
    )
    db.run(sql`INSERT INTO schedule_runs (id, schedule_id, due_at, fired_at, outcome, batch_id, missed_count) VALUES ('sr-1', 'sched-1', 1700000000, 1700000000, 'dispatched', 'batch-1', 0)`)
    runMigrations(db, opened.sqlite)

    const dataDir = mkdtempSync(join(tmpdir(), 'jobs-to-runs-'))
    const { log } = collectLogs()
    migrateJobsToRuns(db, { log, dataDir })

    const sched = db.select().from(schedules).where(eq(schedules.id, 'sched-1')).get()
    expect(sched?.batchId).toBe('batch-1')
    expect(sched?.lastFireOutcome).toBe('dispatched')

    rmSync(dataDir, { recursive: true, force: true })
  })
})
