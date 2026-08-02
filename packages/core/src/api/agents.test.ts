import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { agents } from '../db/schema'
import { queryAgentsPage } from './agents'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

let seq = 0
function seed(db: Db, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `agent-${String(++seq).padStart(4, '0')}`
    ids.push(id)
    db.insert(agents)
      .values({ id, name: `rack-${i}`, status: 'online', createdAt: new Date((base + i) * 1000) })
      .run()
  }
  return ids
}

describe('queryAgentsPage keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', () => {
    const db = setUp()
    const ids = seed(db, 5)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const result = queryAgentsPage(db, { cursor, limit: 2 })
      for (const a of result.items) {
        expect(seen.has(a.id)).toBe(false)
        seen.add(a.id)
      }
      expect(result.total).toBe(5)
      pages++
      if (result.nextCursor === null) break
      cursor = result.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a row inserted mid-paging (newer than everything) is never skipped or repeated', () => {
    const db = setUp()
    seed(db, 4)

    const page1 = queryAgentsPage(db, { cursor: null, limit: 2 })
    expect(page1.items).toHaveLength(2)

    seed(db, 1) // newer than everything already loaded

    const page2 = queryAgentsPage(db, { cursor: page1.nextCursor, limit: 2 })
    const overlap = page2.items.filter((a) => page1.items.some((p) => p.id === a.id))
    expect(overlap).toHaveLength(0)
  })

  test('a malformed cursor is rejected, not silently ignored', () => {
    const db = setUp()
    expect(() => queryAgentsPage(db, { cursor: 'not-valid-base64!!!', limit: 50 })).toThrow()
  })
})
