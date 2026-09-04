import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations } from '../db'
import { artifacts, storageUsage } from '../db/schema'
import { recomputeStorageUsage } from './storage-usage'

function harness() {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-storage-usage-test-'))
  return { db: opened.db, dataDir }
}

describe('recomputeStorageUsage', () => {
  test('writes one row per kind', () => {
    const { db, dataDir } = harness()
    recomputeStorageUsage({ db }, join(dataDir, 'traces'))
    const rows = db.select().from(storageUsage).all()
    expect(rows.map((r) => r.kind).sort()).toEqual(['artifacts', 'audit', 'jobsAndLogs', 'traceFrames'])
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('artifacts bytes matches the exact SUM(sizeBytes)', () => {
    const { db, dataDir } = harness()
    db.insert(artifacts).values({ id: 'a1', runId: null, deviceId: 'd1', kind: 'screenshot', label: null, path: 'a1.png', sizeBytes: 12345, createdAt: new Date() }).run()
    db.insert(artifacts).values({ id: 'a2', runId: null, deviceId: 'd1', kind: 'screenshot', label: null, path: 'a2.png', sizeBytes: 6789, createdAt: new Date() }).run()

    recomputeStorageUsage({ db }, join(dataDir, 'traces'))
    const row = db.select().from(storageUsage).where(eq(storageUsage.kind, 'artifacts')).get()
    expect(row?.bytes).toBe(12345 + 6789)
    expect(row?.rows).toBe(2)
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('a second call overwrites rather than duplicates rows', () => {
    const { db, dataDir } = harness()
    recomputeStorageUsage({ db }, join(dataDir, 'traces'))
    recomputeStorageUsage({ db }, join(dataDir, 'traces'))
    const rows = db.select().from(storageUsage).all()
    expect(rows.length).toBe(4)
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('an empty database still writes four rows, all zero', () => {
    const { db, dataDir } = harness()
    recomputeStorageUsage({ db }, join(dataDir, 'traces'))
    const rows = db.select().from(storageUsage).all()
    expect(rows.length).toBe(4)
    for (const row of rows) {
      expect(row.bytes).toBe(0)
      expect(row.rows).toBe(0)
    }
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('the trace directory walk counts real bytes on disk', () => {
    const { db, dataDir } = harness()
    const traceRoot = join(dataDir, 'traces')
    const runDir = join(traceRoot, 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'frame.png'), Buffer.alloc(2048))
    recomputeStorageUsage({ db }, traceRoot)
    const row = db.select().from(storageUsage).where(eq(storageUsage.kind, 'traceFrames')).get()
    expect(row?.bytes).toBe(2048)
    rmSync(dataDir, { recursive: true, force: true })
  })
})
