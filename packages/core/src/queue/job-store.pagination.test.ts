import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs } from '../db/schema'
import { createRunStore } from '../jobs/runs/store'
import { createJobStore } from './job-store'

/**
 * `JobStore.list` keyset pagination (plan 30 §4.2, §7) — `/api/jobs` is a
 * thin wrapper around this, so the paging correctness is tested here where a
 * seeded DB is cheap to build. Lists JOBS, not runs (plan 211 §3.2 decision
 * 12 — a job's row never disappears when it re-runs), so a bare job with no
 * run is enough to exercise the pagination itself.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'online' }).run()
}

function seedJob(db: Db, deviceId: string, createdAt: Date) {
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
  // `createJob` stamps its own `createdAt` (now); the pagination test needs
  // an explicit, spread-out or same-second value instead.
  db.update(jobs).set({ createdAt }).where(eq(jobs.id, job.id)).run()
  return job.id
}

describe('JobStore.list keyset pagination', () => {
  test('pages through 5 rows with limit=2: the union is exactly the 5, no duplicates', () => {
    const db = setUp()
    seedDevice(db, 'dev-1')
    const base = 1_700_000_000
    const ids = Array.from({ length: 5 }, (_, i) => seedJob(db, 'dev-1', new Date((base + i) * 1000)))
    const store = createJobStore(db)

    const seen = new Set<string>()
    let cursor: { sortValue: number; id: string } | null = null
    let pages = 0
    for (;;) {
      const { rows, nextCursor } = store.list({ limit: 2, cursor })
      for (const r of rows) {
        expect(seen.has(r.id)).toBe(false)
        seen.add(r.id)
      }
      pages++
      if (nextCursor === null) break
      cursor = nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a job inserted mid-paging (newer than everything already loaded) is never skipped or repeated', () => {
    const db = setUp()
    seedDevice(db, 'dev-1')
    const base = 1_700_000_000
    for (let i = 0; i < 4; i++) seedJob(db, 'dev-1', new Date((base + i) * 1000))
    const store = createJobStore(db)

    const page1 = store.list({ limit: 2, cursor: null })
    expect(page1.rows).toHaveLength(2)
    const page1Ids = page1.rows.map((r) => r.id)

    // Simulates an operator sitting on page 1 while a new job is enqueued —
    // it is newer than everything, so it must never appear on page 2, and
    // page 1's rows must not shift under the cursor.
    const newId = seedJob(db, 'dev-1', new Date((base + 100) * 1000))

    const page2 = store.list({ limit: 2, cursor: page1.nextCursor })
    const page2Ids = page2.rows.map((r) => r.id)
    expect(page2Ids).not.toContain(newId)
    expect(page2Ids.some((id) => page1Ids.includes(id))).toBe(false)
    expect(page2.nextCursor).toBeNull()
  })

  test('same-second timestamps (a batch stamps one `now` across every job) still page correctly via the id tiebreaker', () => {
    const db = setUp()
    seedDevice(db, 'dev-1')
    const sameInstant = new Date(1_700_000_000 * 1000)
    const ids = Array.from({ length: 6 }, () => seedJob(db, 'dev-1', sameInstant))
    const store = createJobStore(db)

    const seen: string[] = []
    let cursor: { sortValue: number; id: string } | null = null
    for (;;) {
      const { rows, nextCursor } = store.list({ limit: 2, cursor })
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.id))
      if (nextCursor === null) break
      cursor = nextCursor
    }
    expect(new Set(seen).size).toBe(6)
    expect([...seen].sort()).toEqual([...ids].sort())
  })
})
