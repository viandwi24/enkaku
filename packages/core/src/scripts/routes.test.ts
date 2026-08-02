import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createScriptRoutes } from './routes'

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
    const n2 = ++seq
    const id = `script-${String(n2).padStart(4, '0')}`
    ids.push(id)
    db.insert(scripts)
      .values({ id, name: `script-${n2}`, version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date((base + i) * 1000) })
      .run()
  }
  return ids
}

describe('GET /api/scripts keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', async () => {
    const db = setUp()
    const ids = seed(db, 5)
    const app = createScriptRoutes({ db })

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor ? `/?limit=2&cursor=${encodeURIComponent(cursor)}` : '/?limit=2'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null; total: number | null }
      for (const s of body.items) {
        expect(seen.has(s.id)).toBe(false)
        seen.add(s.id)
      }
      expect(body.total).toBe(5)
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a script inserted mid-paging is never skipped or repeated', async () => {
    const db = setUp()
    seed(db, 4)
    const app = createScriptRoutes({ db })

    const first = await app.request('/?limit=2')
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    seed(db, 1)
    const second = await app.request(`/?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
    const secondBody = (await second.json()) as { items: Array<{ id: string }> }
    const overlap = secondBody.items.filter((s) => firstBody.items.some((f) => f.id === s.id))
    expect(overlap).toHaveLength(0)
  })

  test('a malformed cursor returns 400', async () => {
    const db = setUp()
    const app = createScriptRoutes({ db })
    const res = await app.request('/?cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })

  test('a limit above the cap is clamped, not honoured', async () => {
    const db = setUp()
    seed(db, 3)
    const app = createScriptRoutes({ db })
    const res = await app.request('/?limit=99999')
    const body = (await res.json()) as { items: unknown[]; total: number | null }
    expect(body.items).toHaveLength(3)
    expect(body.total).toBe(3)
  })
})
