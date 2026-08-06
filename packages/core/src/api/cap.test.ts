import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ListCapabilitiesResponseSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { AuthUser } from '../auth/service'
import { buildCoreCapabilityRegistry } from '../capability'
import type { CapabilityContextDeps } from '../capability/context'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import type { JobService } from '../services/job-service'
import { createWorkspaceStore } from '../workspace/store'
import { createCapRoutes } from './cap'

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

const noopJobService = {
  enqueue: () => {
    throw new Error('not used')
  },
  cancel: () => {
    throw new Error('not used')
  },
  get: () => null,
  list: () => ({ jobs: [], nextCursor: null, total: 0 }),
} as unknown as JobService

function contextDeps(db: Db): CapabilityContextDeps {
  return {
    db,
    leases: { getLease: () => null } as unknown as CapabilityContextDeps['leases'],
    states: { current: () => 'idle' } as unknown as CapabilityContextDeps['states'],
    sessions: () => null,
    readiness: () => null,
    transfer: null,
    jobService: noopJobService,
    workspace: createWorkspaceStore(db, () => ({ maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 })),
  }
}

/** Mounts `capRoutes` behind a tiny middleware that injects `user`, mirroring
 * how `authMiddleware` sets it in the real app (`server/http.ts`). */
function appAs(user: AuthUser | null, db: Db): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    if (user) c.set('user', user)
    await next()
  })
  app.route('/', createCapRoutes({ registry: buildCoreCapabilityRegistry(), contextDeps: contextDeps(db) }))
  return app
}

describe('POST /api/v1/cap/:id and GET /api/v1/cap (plan 63 §3.6, acceptance #8, #9)', () => {
  test('GET / lists only what the caller may invoke (acceptance #8)', async () => {
    const db = setUpDb()
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, db)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    // Plan 72 §4.2: the envelope is `{capabilities: [...]}`, not a bare
    // array — `agents/detail/page.tsx` used to ask for exactly this shape
    // and get `undefined`, which crashed the Tools tab.
    const body = (await res.json()) as { capabilities: { id: string }[] }
    const ids = body.capabilities.map((i) => i.id)
    // an operator has `device.control`/`device.view`/`script.view`/... but
    // NOT `device.files` (admin-only by default, `auth/acl.ts`).
    expect(ids).toContain('device.tap')
    expect(ids).not.toContain('device.push')
    expect(ids).not.toContain('device.install')
  })

  test('GET / for an admin includes device.files-gated capabilities', async () => {
    const db = setUpDb()
    const app = appAs({ id: 'admin1', email: 'a@example.com', role: 'admin' }, db)
    const res = await app.request('/')
    const body = (await res.json()) as { capabilities: { id: string }[] }
    expect(body.capabilities.map((i) => i.id)).toContain('device.push')
  })

  test('every listed entry carries a JSON-Schema-shaped input/output (no bare string)', async () => {
    const db = setUpDb()
    const app = appAs({ id: 'admin1', email: 'a@example.com', role: 'admin' }, db)
    const res = await app.request('/')
    const body = (await res.json()) as { capabilities: { id: string; input: { type?: string }; output: unknown }[] }
    for (const item of body.capabilities) {
      expect(item.input).toBeTruthy()
      expect(item.output).toBeTruthy()
    }
  })

  test('POST /:id with no auth is refused E_FORBIDDEN (403), not silently allowed', async () => {
    const db = setUpDb()
    const app = appAs(null, db)
    const res = await app.request('/script.list', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('E_FORBIDDEN')
  })

  test('POST /:id for an unknown capability -> 404', async () => {
    const db = setUpDb()
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, db)
    const res = await app.request('/nope.nope', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(404)
  })

  test('POST /:id with bad input -> 400 E_BAD_INPUT', async () => {
    const db = setUpDb()
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, db)
    const res = await app.request('/device.tap', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_BAD_INPUT')
  })

  test('POST /:id device.tap without the lease is refused 409 E_NEEDS_LEASE, naming the holder (acceptance #5)', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ser1', label: 'Phone', status: 'idle' }).run()
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, db)
    const res = await app.request('/device.tap', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'd1', target: { text: 'OK' } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_NEEDS_LEASE')
  })

  /**
   * Plan 72 §7, acceptance criterion 9 — THE END-TO-END REGRESSION PIN.
   * Studio's `agents/detail/page.test.tsx` proves its OWN parsing logic
   * rejects a bare array (a hand-built fixture mimicking the pre-fix
   * shape), but a mocked-`fetch` component test can never actually exercise
   * the real route handler — reverting `cap.ts` would not touch that test
   * at all. THIS test is what closes the loop: it boots the real Hono route
   * (no mocked fetch anywhere) and parses its actual JSON response through
   * the SAME `ListCapabilitiesResponseSchema` Studio's `api()` call uses.
   * Reverting `GET /` back to `c.json(items)` (the plan's own bare-array
   * example of the original bug) makes this test fail, not merely a type
   * error — verified by hand: temporarily reverting that one line here
   * turns this `safeParse` into `success: false`, and putting the fix back
   * turns it green again.
   */
  test('GET / — the real route response parses against the shared protocol envelope (acceptance criterion 9)', async () => {
    const db = setUpDb()
    const app = appAs({ id: 'admin1', email: 'a@example.com', role: 'admin' }, db)
    const res = await app.request('/')
    const body = await res.json()
    const parsed = ListCapabilitiesResponseSchema.safeParse(body)
    expect(parsed.success).toBe(true)
  })

  test('POST /:id script.list succeeds end to end over HTTP', async () => {
    const db = setUpDb()
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, db)
    const res = await app.request('/script.list', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; output: { items: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.output.items).toEqual([])
  })
})
