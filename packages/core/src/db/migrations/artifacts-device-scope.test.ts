import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from '../index'
import { artifacts } from '../schema'

/**
 * The migration behind plan 24 §4.6: `artifacts.job_id` becomes nullable and
 * `artifacts.device_id` is added. SQLite has no `ALTER COLUMN`, so
 * drizzle-kit rebuilds the whole table (`CREATE __new_artifacts` → copy →
 * drop → rename) — the risk this test is against is that rebuild silently
 * dropping or corrupting rows that existed under the OLD (job_id NOT NULL,
 * no device_id) shape (plan 24 §8 risks).
 */
const ARTIFACTS_DEVICE_SCOPE_TAG = '0015_acoustic_fabian_cortez'

test('a pre-existing (job-only) artifact row survives the rebuild unchanged', () => {
  const opened = openDb(':memory:')
  // Stop strictly BEFORE this migration, so the table is still in its old
  // (job_id NOT NULL, no device_id) shape when the row below is inserted.
  runMigrationsUpTo(opened.db, ARTIFACTS_DEVICE_SCOPE_TAG)
  const db = opened.db

  db.run(
    sql`INSERT INTO artifacts (id, job_id, kind, label, path, size_bytes, created_at) VALUES ('a1', 'job-1', 'screenshot', 'before', 'artifacts/job-1/001-before.png', 1234, 1700000000)`,
  )

  // Now apply the rest, including the artifacts rebuild.
  runMigrations(db)

  const row = db.select().from(artifacts).where(eq(artifacts.id, 'a1')).get()
  expect(row).toBeDefined()
  expect(row?.jobId).toBe('job-1')
  expect(row?.deviceId).toBeNull() // additive column, no data to fill in for a pre-existing row
  expect(row?.kind).toBe('screenshot')
  expect(row?.label).toBe('before')
  expect(row?.path).toBe('artifacts/job-1/001-before.png')
  expect(row?.sizeBytes).toBe(1234)
})

describe('the resulting schema (plan 24 §4.6)', () => {
  test('a device-scoped row (null jobId, set deviceId) is accepted', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(artifacts)
      .values({ id: 'a2', deviceId: 'dev-1', kind: 'log', label: 'saved', path: 'artifacts/device-dev-1/x.log', sizeBytes: 10, createdAt: new Date() })
      .run()
    const row = db.select().from(artifacts).where(eq(artifacts.id, 'a2')).get()
    expect(row?.jobId).toBeNull()
    expect(row?.deviceId).toBe('dev-1')
  })

  test('an existing jobId-only query keeps working exactly as before (additive change)', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    db.insert(artifacts).values({ id: 'a3', jobId: 'job-2', kind: 'log', path: 'x', createdAt: new Date() }).run()
    db.insert(artifacts).values({ id: 'a4', deviceId: 'dev-2', kind: 'log', path: 'y', createdAt: new Date() }).run()
    const jobRows = db.select().from(artifacts).where(eq(artifacts.jobId, 'job-2')).all()
    expect(jobRows.map((r) => r.id)).toEqual(['a3'])
  })
})
