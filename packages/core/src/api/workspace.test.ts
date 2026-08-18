import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations } from '../db'
import { createWorkspaceStore, type WorkspaceQuotas } from '../workspace/store'
import { createWorkspaceFileRoutes } from './workspace'

/**
 * `POST /api/workspace/file` (plan 115 §4.3, step 115.7) — the pattern here
 * is deliberately the same as `./artifacts.test.ts`'s own multipart-upload
 * describe block (this route's own header calls out that it "mirrors `POST
 * /api/artifacts`'s shape"): a fake auth middleware stands in for the real
 * one `http.ts` applies, and the route is exercised with a real in-memory
 * `WorkspaceStore` so quotas/CAS/driver-routing all run for real, exactly as
 * they would through `fs.write`.
 */

const GENEROUS_QUOTAS: WorkspaceQuotas = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024, inlineMaxBytes: 65_536 }

// Every test below uploads at least one binary-ish file, which `store.ts`'s
// write-routing policy (§3.4) sends to the REAL `fs` driver — so `setUp`
// ALWAYS gives it its own tmp `fsContentRoot` rather than letting
// `WorkspaceStoreOptions.fsContentRoot`'s relative fallback default write
// into the repo's own working directory (a real leak this file's first
// draft had: an untracked `.enkaku-workspace-content/` appeared at the repo
// root the first time these tests ran).
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setUp(quotas: WorkspaceQuotas = GENEROUS_QUOTAS) {
  const fsContentRoot = mkdtempSync(join(tmpdir(), 'enkaku-workspace-api-test-'))
  dirs.push(fsContentRoot)
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const store = createWorkspaceStore(opened.db, () => quotas, { fsContentRoot })
  return { db: opened.db, store, fsContentRoot }
}

/** Wraps the routes with a fake auth middleware so `c.get('user')` resolves — the same helper `artifacts.test.ts` uses (the real one is `authMiddleware`, applied one layer up in `http.ts`). */
function withUser(inner: ReturnType<typeof createWorkspaceFileRoutes>, role: 'admin' | 'operator' = 'admin'): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u1@example.com', role })
    await next()
  })
  app.route('/', inner)
  return app
}

function uploadForm(content: Uint8Array, filename: string, path: string): FormData {
  const form = new FormData()
  form.set('file', new File([content], filename))
  form.set('path', path)
  return form
}

describe('POST /api/workspace/file — configuration and auth (plan 115 §4.3)', () => {
  test('rejects when upload is not configured', async () => {
    const { store } = setUp()
    const app = withUser(createWorkspaceFileRoutes({ workspace: store }))
    const form = uploadForm(new Uint8Array([1, 2, 3]), 'video.mp4', '/videos/a.mp4')
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(400)
  })

  test('the auth gate (device.files, widened by shell.mode): an operator is refused when shell.mode is "admin" (the default)', async () => {
    const { store, db } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
      'operator',
    )
    const form = uploadForm(new Uint8Array([1, 2, 3]), 'video.mp4', '/videos/a.mp4')
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('the SAME operator upload succeeds once shell.mode is widened to "operator"', async () => {
    const { store, db } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'operator' }) },
      }),
      'operator',
    )
    const form = uploadForm(new Uint8Array([1, 2, 3]), 'video.mp4', '/videos/a.mp4')
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(201)
  })

  test('shell.mode "off" refuses even an admin — the widening switch also narrows', async () => {
    const { store, db } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'off' }) },
      }),
      'admin',
    )
    const form = uploadForm(new Uint8Array([1, 2, 3]), 'video.mp4', '/videos/a.mp4')
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(403)
  })

  test('an admin uploads a file, which lands in the workspace store with its real hash and size', async () => {
    const { store, db } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const content = new Uint8Array(5000).fill(9)
    const form = uploadForm(content, 'video.mp4', '/videos/a.mp4')
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { file: { path: string; size: number; hash: string } }
    expect(body.file.path).toBe('/videos/a.mp4')
    expect(body.file.size).toBe(content.length)
    const read = store.read('/videos/a.mp4')
    expect(read.hash).toBe(body.file.hash)
    expect(new Uint8Array(read.content)).toEqual(content)
  })

  test('rejects a request with no file field', async () => {
    const { store, db } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const form = new FormData()
    form.set('path', '/videos/a.mp4')
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(400)
  })

  test('rejects a request with no path field', async () => {
    const { store, db } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1])], 'x.mp4'))
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/workspace/file — a quota refusal reaches the client with the STORE\'S OWN message (plan 115 §3.5), never a generic one', () => {
  test('over maxFileBytes: the 413 body is the store\'s own E_QUOTA message, naming the setting to raise', async () => {
    const { store, db } = setUp({ ...GENEROUS_QUOTAS, maxFileBytes: 100 })
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const content = new Uint8Array(200).fill(1) // over the 100-byte cap
    const form = uploadForm(content, 'big.mp4', '/videos/big.mp4')
    const res = await app.request('/file', { method: 'POST', body: form })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_QUOTA')
    // The exact wording `WorkspaceStore.write` produces (store.ts) — not a rewritten or generic
    // "quota exceeded" string invented at the API layer.
    expect(body.error.message).toContain('maxFileBytes')
    expect(body.error.message).toContain('raise "workspace.maxFileBytes" in Settings')
    expect(body.error.message).toContain('100')
  })

  test('over maxTotalBytesPerScope: the same store message reaches the client', async () => {
    const { store, db } = setUp({ ...GENEROUS_QUOTAS, maxFileBytes: 1_000_000, maxTotalBytesPerScope: 150 })
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const first = await app.request('/file', { method: 'POST', body: uploadForm(new Uint8Array(100).fill(1), 'a.mp4', '/videos/a.mp4') })
    expect(first.status).toBe(201)
    const second = await app.request('/file', { method: 'POST', body: uploadForm(new Uint8Array(100).fill(1), 'b.mp4', '/videos/b.mp4') })
    expect(second.status).toBe(413)
    const body = (await second.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_QUOTA')
    expect(body.error.message).toContain('workspace.maxTotalBytesPerScope')
  })

  test('uploading to a path that already exists refuses E_EXISTS — there is no CAS token in a multipart upload (route\'s own comment)', async () => {
    const { store, db } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    await app.request('/file', { method: 'POST', body: uploadForm(new Uint8Array([1]), 'a.mp4', '/videos/a.mp4') })
    const res = await app.request('/file', { method: 'POST', body: uploadForm(new Uint8Array([2]), 'a.mp4', '/videos/a.mp4') })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_EXISTS')
  })
})

// A real fs-backed store, to prove the route works end to end with the driver seam too, not just
// the in-memory default. Mirrors `artifacts.test.ts`'s own tmp-dir pattern (every `setUp()` above
// already uses a real, per-test `fsContentRoot` — see its own comment — so this is really the same
// setup as the rest of the file, called out on its own for what it proves).
describe('POST /api/workspace/file — end to end with a real fs content driver', () => {
  test('a large upload routes to the fs driver and is readable back through the store', async () => {
    const { store, db, fsContentRoot } = setUp()
    const app = withUser(
      createWorkspaceFileRoutes({
        workspace: store,
        upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
      }),
    )
    const content = new Uint8Array(200_000).fill(3) // large + non-text -> fs driver
    const res = await app.request('/file', { method: 'POST', body: uploadForm(content, 'video.mp4', '/videos/big.mp4') })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { file: { hash: string } }
    const read = store.read('/videos/big.mp4')
    expect(new Uint8Array(read.content)).toEqual(content)
    // The bytes are actually on disk, under the tmp root — not the repo's own working directory.
    expect(existsSync(join(fsContentRoot, body.file.hash.slice(0, 2), body.file.hash))).toBe(true)
  })
})

/**
 * Plan 116, step 116.4 — the deliberate single testing pass for the presenter
 * plan. §7 names range arithmetic as "the thing most likely to be subtly
 * wrong" and criterion 6 as the security control; both are exercised here
 * against the SAME route the presenters point their `src` at, with a real
 * upload through the store (never a hand-built `WorkspaceFileMeta`).
 */

function appWithUpload() {
  const { store, db } = setUp()
  const app = withUser(
    createWorkspaceFileRoutes({
      workspace: store,
      upload: { audit: createAuditLogger(db), shellSettings: () => ({ mode: 'admin' }) },
    }),
  )
  return { store, db, app }
}

/** Uploads `content` at `path` with an explicit content type — `uploadForm`'s plain `new
 * File([content], filename)` leaves `file.type` empty, which is fine for the range tests
 * (byte arithmetic does not care about content type) but not for the allow-list tests, which are
 * ABOUT content type. */
async function uploadTyped(app: Hono<AuthEnv>, content: Uint8Array, filename: string, path: string, type: string): Promise<void> {
  const form = new FormData()
  form.set('file', new File([content], filename, { type }))
  form.set('path', path)
  const res = await app.request('/file', { method: 'POST', body: form })
  expect(res.status).toBe(201)
}

describe('GET /api/workspace/file — Range arithmetic (plan 116 §7, §8: "easy to get subtly wrong")', () => {
  async function setUpWithBlob(size: number) {
    const { app } = appWithUpload()
    const content = new Uint8Array(size)
    for (let i = 0; i < size; i++) content[i] = i % 256
    const res = await app.request('/file', { method: 'POST', body: uploadForm(content, 'blob.bin', '/blob.bin') })
    expect(res.status).toBe(201)
    return { app, content }
  }

  test('a normal, fully-specified range returns exactly that inclusive slice', async () => {
    const { app, content } = await setUpWithBlob(2000)
    const res = await app.request('/file?path=/blob.bin', { headers: { range: 'bytes=10-19' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/2000')
    expect(res.headers.get('content-length')).toBe('10')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(content.subarray(10, 20))
  })

  test('an open-ended range ("bytes=1024-") runs to the last byte', async () => {
    const { app, content } = await setUpWithBlob(2000)
    const res = await app.request('/file?path=/blob.bin', { headers: { range: 'bytes=1024-' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 1024-1999/2000')
    expect(res.headers.get('content-length')).toBe('976')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(content.subarray(1024))
  })

  test('a SUFFIX range ("bytes=-500") returns exactly the last 500 bytes', async () => {
    const { app, content } = await setUpWithBlob(2000)
    const res = await app.request('/file?path=/blob.bin', { headers: { range: 'bytes=-500' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 1500-1999/2000')
    expect(res.headers.get('content-length')).toBe('500')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(content.subarray(1500))
  })

  test('a suffix range LARGER than the file means the whole file, not unsatisfiable (RFC 7233 §2.1)', async () => {
    const { app, content } = await setUpWithBlob(2000)
    const res = await app.request('/file?path=/blob.bin', { headers: { range: 'bytes=-5000' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-1999/2000')
    expect(res.headers.get('content-length')).toBe('2000')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(content)
  })

  test('an unsatisfiable range (starting past the end of the file) answers 416 with Content-Range: bytes */size', async () => {
    const { app } = await setUpWithBlob(2000)
    const res = await app.request('/file?path=/blob.bin', { headers: { range: 'bytes=5000-6000' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */2000')
    const body = await res.arrayBuffer()
    expect(body.byteLength).toBe(0)
  })

  test('the inclusive end is exact: "bytes=0-0" returns exactly ONE byte, not zero and not two', async () => {
    const { app, content } = await setUpWithBlob(2000)
    const res = await app.request('/file?path=/blob.bin', { headers: { range: 'bytes=0-0' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-0/2000')
    expect(res.headers.get('content-length')).toBe('1')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(1)
    expect(body[0]).toBe(content[0])
  })
})

describe('GET /api/workspace/file — the inline/attachment allow-list is the security control (criterion 6, §3.5, P5)', () => {
  test('an uploaded .html is served as an attachment, never inline, and carries nosniff and the sandbox CSP', async () => {
    const { app } = appWithUpload()
    await uploadTyped(app, new TextEncoder().encode('<script>alert(1)</script>'), 'x.html', '/x.html', 'text/html')
    const res = await app.request('/file?path=/x.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  test('an uploaded .svg is served as an attachment too — the "image/*" prefix does not save it (§3.5\'s named exclusion)', async () => {
    const { app } = appWithUpload()
    await uploadTyped(app, new TextEncoder().encode('<svg onload="alert(1)"></svg>'), 'x.svg', '/x.svg', 'image/svg+xml')
    const res = await app.request('/file?path=/x.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  // The other half of the allow-list assertion: it must not refuse EVERYTHING, or the two tests
  // above would pass by accident.
  test('a plain .txt DOES render inline — no Content-Disposition header at all', async () => {
    const { app } = appWithUpload()
    await uploadTyped(app, new TextEncoder().encode('hello workspace'), 'x.txt', '/x.txt', 'text/plain')
    const res = await app.request('/file?path=/x.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  test('a plain .png DOES render inline too', async () => {
    const { app } = appWithUpload()
    await uploadTyped(app, new Uint8Array([1, 2, 3, 4, 5]), 'x.png', '/x.png', 'image/png')
    const res = await app.request('/file?path=/x.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  test('nosniff and the sandbox CSP apply to an ERROR response too — a 404 for a missing path (§3.5: "including errors")', async () => {
    const { app } = appWithUpload()
    const res = await app.request('/file?path=/nope.txt')
    expect(res.status).toBe(404)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })
})

describe('HEAD /api/workspace/file — parity with GET (step 116.6, finding P7)', () => {
  test('HEAD and GET agree on content type, length, and the inline/attachment decision — and HEAD has no body', async () => {
    const { app } = appWithUpload()
    const content = new Uint8Array(12_345).fill(7)
    await uploadTyped(app, content, 'clip.mp4', '/clip.mp4', 'video/mp4')

    const getRes = await app.request('/file?path=/clip.mp4')
    const headRes = await app.request('/file?path=/clip.mp4', { method: 'HEAD' })

    expect(headRes.status).toBe(200)
    expect(headRes.headers.get('content-type')).toBe(getRes.headers.get('content-type'))
    expect(headRes.headers.get('content-length')).toBe(getRes.headers.get('content-length'))
    expect(headRes.headers.get('content-length')).toBe(String(content.length))
    expect(headRes.headers.get('content-disposition')).toBe(getRes.headers.get('content-disposition'))
    expect(headRes.headers.get('content-disposition')).toBeNull() // video/* is inline

    const body = await headRes.arrayBuffer()
    expect(body.byteLength).toBe(0)
  })

  test('the SAME inline/attachment decision holds for a type the allow-list excludes (.html) — HEAD cannot drift from GET', async () => {
    const { app } = appWithUpload()
    await uploadTyped(app, new TextEncoder().encode('<script>alert(1)</script>'), 'x.html', '/x.html', 'text/html')

    const getRes = await app.request('/file?path=/x.html')
    const headRes = await app.request('/file?path=/x.html', { method: 'HEAD' })

    expect(headRes.headers.get('content-disposition')).toContain('attachment')
    expect(headRes.headers.get('content-disposition')).toBe(getRes.headers.get('content-disposition'))
  })

  test('HEAD carries the ETag (the CAS hash) and the X-Enkaku-* metadata headers', async () => {
    const { app } = appWithUpload()
    const content = new Uint8Array([1, 2, 3, 4])
    const form = new FormData()
    form.set('file', new File([content], 'note.txt', { type: 'text/plain' }))
    form.set('path', '/note.txt')
    const postRes = await app.request('/file', { method: 'POST', body: form })
    const posted = (await postRes.json()) as { file: { hash: string; createdBy: string | null; createdAt: number; updatedAt: number } }

    const headRes = await app.request('/file?path=/note.txt', { method: 'HEAD' })
    expect(headRes.headers.get('etag')).toBe(`"${posted.file.hash}"`)
    expect(headRes.headers.get('x-enkaku-created-by')).toBe(posted.file.createdBy)
    expect(headRes.headers.get('x-enkaku-created-at')).toBe(String(posted.file.createdAt))
    expect(headRes.headers.get('x-enkaku-updated-at')).toBe(String(posted.file.updatedAt))
  })
})
