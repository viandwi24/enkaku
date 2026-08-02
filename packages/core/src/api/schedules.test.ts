import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { scheduleRuns, schedules } from '../db/schema'
import { queryScheduleRunsRows, querySchedulesRows } from './schedules'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

let seq = 0
function seedSchedule(db: Db, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `sched-${String(++seq).padStart(4, '0')}`
    ids.push(id)
    db.insert(schedules)
      .values({
        id,
        name: `job-${i}`,
        cron: '0 0 * * *',
        timezone: 'UTC',
        scriptId: 'internal:sleep',
        clusterId: null,
        deviceIds: ['d1'],
        createdAt: new Date((base + i) * 1000),
      })
      .run()
  }
  return ids
}

let runSeq = 0
function seedRuns(db: Db, scheduleId: string, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `run-${String(++runSeq).padStart(4, '0')}`
    ids.push(id)
    db.insert(scheduleRuns)
      .values({ id, scheduleId, dueAt: new Date((base + i) * 1000), outcome: 'dispatched', missedCount: 0 })
      .run()
  }
  return ids
}

describe('querySchedulesRows keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', () => {
    const db = setUp()
    const ids = seedSchedule(db, 5)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const { rows, nextCursor, total } = querySchedulesRows(db, { cursor, limit: 2 })
      for (const r of rows) {
        expect(seen.has(r.id)).toBe(false)
        seen.add(r.id)
      }
      expect(total).toBe(5)
      pages++
      if (nextCursor === null) break
      cursor = nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a malformed cursor is rejected', () => {
    const db = setUp()
    expect(() => querySchedulesRows(db, { cursor: 'not-valid-base64!!!', limit: 50 })).toThrow()
  })
})

describe('queryScheduleRunsRows keyset pagination', () => {
  test('pages through 5 runs with limit=2, scoped to one schedule, no duplicates', () => {
    const db = setUp()
    const [schedA] = seedSchedule(db, 1)
    const [schedB] = seedSchedule(db, 1)
    const idsA = seedRuns(db, schedA!, 5)
    seedRuns(db, schedB!, 3) // a different schedule's runs must never leak in

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const { rows, nextCursor, total } = queryScheduleRunsRows(db, schedA!, { cursor, limit: 2 })
      for (const r of rows) {
        expect(seen.has(r.id)).toBe(false)
        seen.add(r.id)
      }
      expect(total).toBe(5)
      pages++
      if (nextCursor === null) break
      cursor = nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...idsA].sort())
  })

  test('a run inserted mid-paging is never skipped or repeated', () => {
    const db = setUp()
    const [schedA] = seedSchedule(db, 1)
    seedRuns(db, schedA!, 4)

    const page1 = queryScheduleRunsRows(db, schedA!, { cursor: null, limit: 2 })
    expect(page1.rows).toHaveLength(2)
    seedRuns(db, schedA!, 1)
    const page2 = queryScheduleRunsRows(db, schedA!, { cursor: page1.nextCursor, limit: 2 })
    const overlap = page2.rows.filter((r) => page1.rows.some((p) => p.id === r.id))
    expect(overlap).toHaveLength(0)
  })
})
