import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, runMigrations, type Db } from '../db'
import { storageUsage } from '../db/schema'
import { createStorageRoutes } from './storage'

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  return opened.db
}

describe('GET /api/storage/usage', () => {
  test('returns the four kinds in a fixed order, computed from the cache table only', async () => {
    const db = setUpDb()
    const now = new Date()
    db.insert(storageUsage).values({ kind: 'jobsAndLogs', bytes: 100, rows: 5, computedAt: now }).run()
    db.insert(storageUsage).values({ kind: 'traceFrames', bytes: 200, rows: 0, computedAt: now }).run()
    db.insert(storageUsage).values({ kind: 'artifacts', bytes: 300, rows: 3, computedAt: now }).run()
    db.insert(storageUsage).values({ kind: 'audit', bytes: 50, rows: 1, computedAt: now }).run()

    const app = createStorageRoutes(db)
    const res = await app.request('/usage')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kinds: Array<{ kind: string; bytes: number; rows: number }>; totalBytes: number }
    expect(body.kinds.map((k) => k.kind).sort()).toEqual(['artifacts', 'audit', 'jobsAndLogs', 'traceFrames'])
    expect(body.totalBytes).toBe(100 + 200 + 300 + 50)
  })

  test('answers from an empty cache with zero kinds, never touching the filesystem', async () => {
    const db = setUpDb()
    const app = createStorageRoutes(db)
    const res = await app.request('/usage')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kinds: unknown[]; totalBytes: number }
    expect(body.kinds).toEqual([])
    expect(body.totalBytes).toBe(0)
  })

  // The mechanical form of G4: the route handler's own source performs no
  // filesystem call on the request path — usage is always a cache read.
  test('the route handler itself contains no readdir/stat/rm call', () => {
    const source = readFileSync(join(import.meta.dir, 'storage.ts'), 'utf8')
    expect(/readdir|statSync|rmSync/i.test(source)).toBe(false)
  })
})
