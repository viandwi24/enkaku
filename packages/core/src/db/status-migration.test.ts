import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from './index'
import { devices, jobs, jobEvents } from './schema'

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

    runMigrations(db, sqlite)

    const job = db.select().from(jobs).where(eq(jobs.id, 'j1')).get()
    expect(job?.heartbeatExpiresAt).toBe(1234)
  })

  test('jobs.lease_expires_at and jobs.assist_count no longer exist as columns', () => {
    const { db, sqlite } = seededPre0065()
    addDevice(sqlite, 'd1', 'idle')
    sqlite.exec(`INSERT INTO jobs (id, script_id, device_id) VALUES ('j1', 'internal:sleep', 'd1')`)
    runMigrations(db, sqlite)

    const columns = sqlite.query<{ name: string }, []>("PRAGMA table_info('jobs')").all().map((c) => c.name)
    expect(columns).not.toContain('lease_expires_at')
    expect(columns).not.toContain('assist_count')
    expect(columns).toContain('heartbeat_expires_at')
  })

  test('job_events rows of kind "assist" are deleted; every other kind survives', () => {
    const { db, sqlite } = seededPre0065()
    addDevice(sqlite, 'd1', 'idle')
    sqlite.exec(`INSERT INTO jobs (id, script_id, device_id) VALUES ('j1', 'internal:sleep', 'd1')`)
    sqlite.exec(`INSERT INTO job_events (id, job_id, seq, at_ms, kind, name) VALUES ('e1', 'j1', 1, 1000, 'assist', 'human-tap')`)
    sqlite.exec(`INSERT INTO job_events (id, job_id, seq, at_ms, kind, name) VALUES ('e2', 'j1', 2, 2000, 'log', 'hello')`)

    runMigrations(db, sqlite)

    const events = db.select().from(jobEvents).where(eq(jobEvents.jobId, 'j1')).all()
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
