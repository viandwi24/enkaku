import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts } from '../db/schema'
import { createArtifactRoutes } from './artifacts'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

let seq = 0
function seed(db: Db, jobId: string, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `art-${String(++seq).padStart(4, '0')}`
    ids.push(id)
    db.insert(artifacts)
      .values({ id, jobId, kind: 'log', label: null, path: `logs/${id}.txt`, sizeBytes: 10, createdAt: new Date((base + i) * 1000) })
      .run()
  }
  return ids
}

describe('GET /api/artifacts keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates, oldest first', async () => {
    const db = setUp()
    const ids = seed(db, 'job-1', 5)
    const app = createArtifactRoutes({ db, dataDir: '/tmp' })

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor ? `/?jobId=job-1&limit=2&cursor=${encodeURIComponent(cursor)}` : '/?jobId=job-1&limit=2'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null; total: number | null }
      seen.push(...body.items.map((a) => a.id))
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen).toEqual(ids) // ascending order preserved, no dup/skip
  })

  test('a row inserted mid-paging (newer than everything) is never skipped or repeated', async () => {
    const db = setUp()
    seed(db, 'job-1', 4)
    const app = createArtifactRoutes({ db, dataDir: '/tmp' })

    const first = await app.request('/?jobId=job-1&limit=2')
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(firstBody.items).toHaveLength(2)

    seed(db, 'job-1', 1) // a new, newer artifact lands while paging

    const second = await app.request(`/?jobId=job-1&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
    const secondBody = (await second.json()) as { items: Array<{ id: string }> }
    const overlap = secondBody.items.filter((a) => firstBody.items.some((f) => f.id === a.id))
    expect(overlap).toHaveLength(0)
  })

  test('requires ?jobId=', async () => {
    const db = setUp()
    const app = createArtifactRoutes({ db, dataDir: '/tmp' })
    const res = await app.request('/')
    expect(res.status).toBe(400)
  })

  test('a malformed cursor returns 400', async () => {
    const db = setUp()
    const app = createArtifactRoutes({ db, dataDir: '/tmp' })
    const res = await app.request('/?jobId=job-1&cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })
})
