import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts } from '../db/schema'
import { createArtifactRoutes, MAX_REQUEST_BODY_BYTES, MAX_UPLOAD_BYTES } from './artifacts'

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

/**
 * `GET /api/artifacts?kind=upload` (plan 93 §3.13, §4.4, §4.7, step 93.10,
 * closing F14) — before this, an uploaded artifact (`jobId: null,
 * deviceId: null`) could never be listed at all: `?jobId=`/`?deviceId=`
 * both require a non-null value to match against, so the row was invisible
 * to every existing query mode.
 */
describe('GET /api/artifacts?kind=upload (plan 93 §3.13, §4.4, §4.7, step 93.10, closing F14)', () => {
  test('lists exactly the rows with BOTH jobId and deviceId null — an upload — never a job or device artifact', async () => {
    const db = setUp()
    db.insert(artifacts).values({ id: 'upload-1', jobId: null, deviceId: null, kind: 'file', label: 'build.apk', path: 'artifacts/uploads/1-build.apk', sizeBytes: 100, createdAt: new Date(1_700_000_000 * 1000) }).run()
    db.insert(artifacts).values({ id: 'upload-2', jobId: null, deviceId: null, kind: 'file', label: 'other.apk', path: 'artifacts/uploads/2-other.apk', sizeBytes: 200, createdAt: new Date(1_700_000_001 * 1000) }).run()
    seed(db, 'job-1', 2) // job-scoped artifacts — must NOT appear
    db.insert(artifacts).values({ id: 'device-1', jobId: null, deviceId: 'dev-1', kind: 'log', label: 'saved.log', path: 'artifacts/device-dev-1/x.log', sizeBytes: 5, createdAt: new Date() }).run()

    const app = createArtifactRoutes({ db, dataDir: '/tmp' })
    const res = await app.request('/?kind=upload')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ id: string; jobId: string | null; deviceId: string | null }> }
    const ids = body.items.map((a) => a.id).sort()
    expect(ids).toEqual(['upload-1', 'upload-2'])
    for (const item of body.items) {
      expect(item.jobId).toBeNull()
      expect(item.deviceId).toBeNull()
    }
  })

  test('paginates like every other list mode (oldest first, keyset cursor)', async () => {
    const db = setUp()
    for (let i = 0; i < 5; i++) {
      db.insert(artifacts)
        .values({ id: `up-${i}`, jobId: null, deviceId: null, kind: 'file', label: `f${i}`, path: `artifacts/uploads/${i}.bin`, sizeBytes: 1, createdAt: new Date((1_700_000_000 + i) * 1000) })
        .run()
    }
    const app = createArtifactRoutes({ db, dataDir: '/tmp' })
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const url = cursor ? `/?kind=upload&limit=2&cursor=${encodeURIComponent(cursor)}` : '/?kind=upload&limit=2'
      const res = await app.request(url)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
      seen.push(...body.items.map((a) => a.id))
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(seen.length).toBeLessThan(20)
    }
    expect(seen).toEqual(['up-0', 'up-1', 'up-2', 'up-3', 'up-4'])
  })

  test('an empty store returns an empty page, not an error', async () => {
    const db = setUp()
    const app = createArtifactRoutes({ db, dataDir: '/tmp' })
    const res = await app.request('/?kind=upload')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number | null }
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
  })
})

/**
 * Plan-less hotfix, 2026-08-26 — the transport cap, and why it is asserted
 * against `daemon.ts`'s SOURCE rather than through a booted server.
 *
 * `Bun.serve`'s `maxRequestBodySize` cannot be observed from inside the Hono
 * app: by the time a route runs, the request already got past it. The failure
 * this guards is the "registered but not wired" shape this repo has now been
 * bitten by five times — a constant declared in one file, meant for a call in
 * another, and nothing that fails when the two drift.
 *
 * What made this one expensive is that the drift was INVISIBLE: the route's
 * own 1 GB check read as the real limit while Bun silently enforced 128 MB,
 * and the browser got a 413 with an empty body — no message, nothing in
 * DevTools' Response tab, a status easily misread as 403.
 */
describe('the Bun.serve request-body ceiling is actually wired (2026-08-26)', () => {
  test('daemon.ts passes maxRequestBodySize, and passes THIS constant rather than a literal of its own', async () => {
    const source = await Bun.file(new URL('../daemon.ts', import.meta.url)).text()
    expect(source).toContain('maxRequestBodySize: MAX_REQUEST_BODY_BYTES')
  })

  test('the transport cap sits ABOVE the route cap, so the legible refusal always wins', () => {
    // If these were equal, a body at exactly the limit would race between a
    // 413-with-a-message and a 413-with-nothing, and which one an operator saw
    // would depend on multipart overhead. The whole point of the fix is that
    // the message wins whenever both could fire.
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES)
  })

  test('the route cap is still the 1 GB this file has always declared — the fix raises no limit', () => {
    // The bug was never that 1 GB was too small. It was that 1 GB was not the
    // number being enforced. Nothing here should quietly become permissive.
    expect(MAX_UPLOAD_BYTES).toBe(1024 * 1024 * 1024)
  })
})
