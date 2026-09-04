import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo, type Db } from './index'
import { devices, jobs, jobEvents, jobRuns } from './schema'
import { migrateJobsToRuns } from './migrations/jobs-to-runs'

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog } as unknown as Parameters<typeof migrateJobsToRuns>[1]['log']

/**
 * `runMigrations` alone only applies the SQL migrations (`0070`'s own DDL);
 * `migrateJobsToRuns` is a SEPARATE step (`daemon.ts` calls both, in that
 * order, on boot — plan 211 §4.10) that re-keys pre-211 data into `job_runs`
 * and drops the shadow tables. A test that seeds pre-migration rows and
 * wants to read the resulting `job_runs`/`job_events.run_id` shape must call
 * both, exactly like production does.
 */
function migrateAll(db: Db, sqlite: Parameters<typeof runMigrations>[1]): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'status-migration-'))
  runMigrations(db, sqlite)
  migrateJobsToRuns(db, { log: noopLog, dataDir })
  rmSync(dataDir, { recursive: true, force: true })
}

/**
 * Migration 0065, run through the REAL migrator over a database seeded with
 * PRE-migration rows (plan 205 §0 G4, §5 step 205.3) — not a copy of the SQL
 * re-executed in isolation, which would only prove the paste. `devices` and
 * `jobs` are seeded at the schema shape 0064 left behind (raw SQL, since the
 * Drizzle schema object in this file already describes the POST-migration
 * columns), then `runMigrations` applies 0065 and everything after it.
 */
function seededPre0065() {
  const { db, sqlite } = openDb(':memory:')
  runMigrationsUpTo(db, '0065_public_multiple_man')
  return { db, sqlite }
}

function addDevice(sqlite: { exec: (sql: string) => void }, id: string, status: string) {
  sqlite.exec(
    `INSERT INTO devices (id, stable_id, serial, label, status) VALUES ('${id}', 'stable-${id}', 'ser-${id}', '${id}', '${status}')`,
  )
}

describe('0065 — device status shrinks to offline/online/quarantined, jobs.lease_expires_at renames to heartbeat_expires_at (plan 205 §4.6)', () => {
  test('idle, manual, busy all become online; offline and quarantined are untouched', () => {
    const { db, sqlite } = seededPre0065()
    addDevice(sqlite, 'd-offline', 'offline')
    addDevice(sqlite, 'd-idle', 'idle')
    addDevice(sqlite, 'd-manual', 'manual')
    addDevice(sqlite, 'd-busy', 'busy')
    addDevice(sqlite, 'd-quarantined', 'quarantined')

    runMigrations(db, sqlite)

    const rows = db.select().from(devices).all()
    const statusOf = (id: string) => rows.find((r) => r.id === id)?.status
    expect(statusOf('d-offline')).toBe('offline')
    expect(statusOf('d-idle')).toBe('online')
    expect(statusOf('d-manual')).toBe('online')
    expect(statusOf('d-busy')).toBe('online')
    expect(statusOf('d-quarantined')).toBe('quarantined')
  })

  test('a running job with lease_expires_at survives as heartbeat_expires_at, with the same value', () => {
    const { db, sqlite } = seededPre0065()
    addDevice(sqlite, 'd1', 'busy')
    sqlite.exec(
      `INSERT INTO jobs (id, script_id, device_id, status, lease_expires_at) VALUES ('j1', 'internal:sleep', 'd1', 'running', 1234)`,
    )

    migrateAll(db, sqlite)

    // Plan 211 §3.2 decision 1 — `heartbeat_expires_at` moved from `jobs` to
    // `job_runs` (a run's own liveness, not the job's); the pre-211 job
    // migrates to exactly one run at `seq 1` (`jobs-to-runs.ts`).
    const run = db.select().from(jobRuns).where(eq(jobRuns.jobId, 'j1')).get()
    expect(run?.heartbeatExpiresAt).toBe(1234)
  })

  test('jobs.lease_expires_at and jobs.assist_count no longer exist as columns; heartbeat_expires_at lives on job_runs', () => {
    const { db, sqlite } = seededPre0065()
    addDevice(sqlite, 'd1', 'idle')
    sqlite.exec(`INSERT INTO jobs (id, script_id, device_id) VALUES ('j1', 'internal:sleep', 'd1')`)
    runMigrations(db, sqlite)

    const jobColumns = sqlite.query<{ name: string }, []>("PRAGMA table_info('jobs')").all().map((c) => c.name)
    expect(jobColumns).not.toContain('lease_expires_at')
    expect(jobColumns).not.toContain('assist_count')
    expect(jobColumns).not.toContain('heartbeat_expires_at')
    const runColumns = sqlite.query<{ name: string }, []>("PRAGMA table_info('job_runs')").all().map((c) => c.name)
    expect(runColumns).toContain('heartbeat_expires_at')
  })

  test('job_events rows of kind "assist" are deleted; every other kind survives', () => {
    const { db, sqlite } = seededPre0065()
    addDevice(sqlite, 'd1', 'idle')
    sqlite.exec(`INSERT INTO jobs (id, script_id, device_id) VALUES ('j1', 'internal:sleep', 'd1')`)
    sqlite.exec(`INSERT INTO job_events (id, job_id, seq, at_ms, kind, name) VALUES ('e1', 'j1', 1, 1000, 'assist', 'human-tap')`)
    sqlite.exec(`INSERT INTO job_events (id, job_id, seq, at_ms, kind, name) VALUES ('e2', 'j1', 2, 2000, 'log', 'hello')`)

    migrateAll(db, sqlite)

    // Plan 211 §3.2 decision 9 — `job_events.job_id` renamed to `run_id`;
    // the pre-211 job's single execution becomes its one run.
    const run = db.select().from(jobRuns).where(eq(jobRuns.jobId, 'j1')).get()
    const events = db.select().from(jobEvents).where(eq(jobEvents.runId, run!.id)).all()
    expect(events.map((e) => e.id)).toEqual(['e2'])
  })

  test('running it twice changes nothing the second time', () => {
    const { db, sqlite } = seededPre0065()
    addDevice(sqlite, 'd1', 'manual')
    sqlite.exec(`INSERT INTO jobs (id, script_id, device_id, lease_expires_at) VALUES ('j1', 'internal:sleep', 'd1', 999)`)
    runMigrations(db, sqlite)
    const once = db.select().from(devices).where(eq(devices.id, 'd1')).get()?.status
    runMigrations(db, sqlite)
    expect(db.select().from(devices).where(eq(devices.id, 'd1')).get()?.status).toBe(once)
  })
})
