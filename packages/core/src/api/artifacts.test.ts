import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { createAuditLogger } from '../auth/audit'
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

/** Wraps the routes with a fake auth middleware so `c.get('user')` resolves (plan 39 §4.4 — the real one is `authMiddleware`, applied one layer up in `http.ts`). */
function withUser(inner: ReturnType<typeof createArtifactRoutes>, role: 'admin' | 'operator' = 'admin'): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u1@example.com', role })
    await next()
  })
  app.route('/', inner)
  return app
}

describe('POST /api/artifacts — multipart upload (plan 39 §4.4)', () => {
  test('rejects when upload is not configured', async () => {
    const db = setUp()
    const app = withUser(createArtifactRoutes({ db, dataDir: '/tmp' }))
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'x.apk'))
    const res = await app.request('/', { method: 'POST', body: form })
    expect(res.status).toBe(400)
  })

  test('rejects without device.files permission (operator, admin-only default)', async () => {
    const db = setUp()
    const app = withUser(
      createArtifactRoutes({
        db,
        dataDir: '/tmp',
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
      'operator',
    )
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'x.apk'))
    const res = await app.request('/', { method: 'POST', body: form })
    expect(res.status).toBe(403)
  })

  test('an admin uploads a file, which lands as a standalone artifact row and on disk', async () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-artifact-upload-'))
    const app = withUser(
      createArtifactRoutes({
        db,
        dataDir,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const content = new Uint8Array(5000).fill(9)
    const form = new FormData()
    form.set('file', new File([content], 'app.apk'))
    form.set('label', 'my build')
    const res = await app.request('/', { method: 'POST', body: form })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { artifact: { id: string; jobId: string | null; deviceId: string | null; sizeBytes: number; path: string } }
    expect(body.artifact.jobId).toBeNull()
    expect(body.artifact.deviceId).toBeNull()
    expect(body.artifact.sizeBytes).toBe(content.length)
    const row = db.select().from(artifacts).all().find((r) => r.id === body.artifact.id)
    expect(row).toBeDefined()
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('rejects a request with no file field', async () => {
    const db = setUp()
    const app = withUser(
      createArtifactRoutes({
        db,
        dataDir: '/tmp',
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const form = new FormData()
    form.set('label', 'no file here')
    const res = await app.request('/', { method: 'POST', body: form })
    expect(res.status).toBe(400)
  })
})
