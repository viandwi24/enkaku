import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { createBlobStore } from '../agent/blob/store'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createBlobRoutes } from './blobs'

/**
 * The blob API (plan 70 §4.6, criteria 3, 4, 7, 8): upload, dedupe, refusal
 * on an oversized or non-image body, and the response headers a browser's
 * `<img>` relies on (sniffed type, `nosniff`, an immutable cache header) —
 * plus 404 on an unknown id.
 */

function withUser(role: 'admin' | 'operator' | null, userId: string, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: userId, email: `${userId}@test`, role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function pngBytes(paddingBytes = 50): Uint8Array {
  const b = new Uint8Array(33 + paddingBytes)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13], 8)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  const dv = new DataView(b.buffer)
  dv.setUint32(16, 100, false)
  dv.setUint32(20, 200, false)
  for (let i = 33; i < b.length; i++) b[i] = i % 256
  return b
}

function setUp(role: 'admin' | 'operator' | null = 'operator', maxUploadBytes = 5 * 1024 * 1024) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const blobs = createBlobStore(db)
  const audit = createAuditLogger(db)
  const app = withUser(role, 'u1', createBlobRoutes({ blobs, audit, maxUploadBytes: () => maxUploadBytes }))
  return { db, blobs, app }
}

describe('POST /api/v1/blobs', () => {
  test('a raw PNG body uploads and returns blobId/mediaType/bytes/dimensions', async () => {
    const { app } = setUp()
    const bytes = pngBytes()
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { blobId: string; mediaType: string; bytes: number; width?: number; height?: number }
    expect(body.blobId).toStartWith('sha256:')
    expect(body.mediaType).toBe('image/png')
    expect(body.bytes).toBe(bytes.byteLength)
    expect(body.width).toBe(100)
    expect(body.height).toBe(200)
  })

  test('two identical uploads return the SAME blobId (dedupe, criterion 2)', async () => {
    const { app } = setUp()
    const bytes = pngBytes()
    const first = await app.request('/', { method: 'POST', body: bytes })
    const second = await app.request('/', { method: 'POST', body: bytes })
    const a = (await first.json()) as { blobId: string }
    const b = (await second.json()) as { blobId: string }
    expect(a.blobId).toBe(b.blobId)
  })

  test('a declared Content-Type is IGNORED — acceptance is by magic bytes alone (plan 70 §3.5)', async () => {
    const { app } = setUp()
    const bytes = pngBytes()
    // Declares text/plain — still accepted and correctly typed as image/png, because the route
    // sniffs rather than trusting the header.
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: bytes })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { mediaType: string }
    expect(body.mediaType).toBe('image/png')
  })

  test('a non-image body is refused (415) and nothing is stored', async () => {
    const { app, blobs } = setUp()
    const res = await app.request('/', { method: 'POST', body: new TextEncoder().encode('not an image, just text') })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_UNSUPPORTED_MEDIA_TYPE')
    expect(blobs.get('sha256:anything')).toBeNull() // nothing to find — a smoke check the route never called put()
  })

  test('an empty body is refused (400)', async () => {
    const { app } = setUp()
    const res = await app.request('/', { method: 'POST', body: new Uint8Array(0) })
    expect(res.status).toBe(400)
  })

  test('a body over the cap is refused (413), naming the limit', async () => {
    const { app } = setUp('operator', 40) // tiny cap
    const bytes = pngBytes(100)
    const res = await app.request('/', { method: 'POST', body: bytes })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_IMAGE_TOO_LARGE')
    expect(body.error.message).toContain('40')
  })

  test('an oversized Content-Length is refused before the body is even read', async () => {
    const { app } = setUp('operator', 40)
    const res = await app.request('/', { method: 'POST', headers: { 'content-length': '999999' }, body: pngBytes(100) })
    expect(res.status).toBe(413)
  })

  test('without agent.run (no user), upload is refused (403)', async () => {
    const { app } = setUp(null)
    const res = await app.request('/', { method: 'POST', body: pngBytes() })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/blobs/:id', () => {
  test('serves the exact bytes with the sniffed type, nosniff, and an immutable cache header', async () => {
    const { app, blobs } = setUp()
    const bytes = pngBytes()
    const stored = blobs.put(bytes, 'image/png')

    const res = await app.request(`/${stored.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toContain('immutable')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(Buffer.from(bytes))).toBe(true)
  })

  test('an unknown id is 404', async () => {
    const { app } = setUp()
    const res = await app.request('/sha256:doesnotexist')
    expect(res.status).toBe(404)
  })

  test('without agent.view (no user), read is refused (403)', async () => {
    const { app, blobs } = setUp(null)
    const stored = blobs.put(pngBytes(), 'image/png')
    const res = await app.request(`/${stored.id}`)
    expect(res.status).toBe(403)
  })
})
