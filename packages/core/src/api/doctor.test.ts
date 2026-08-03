import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { createDoctorRoutes } from './doctor'

/** Mirrors `authMiddleware` well enough for a route test: sets `c.get('user')` before dispatch. */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

describe('GET /api/doctor (plan 41 §4.5)', () => {
  // A full 200 response drives `createRealDoctorContext()` — real adb-socket
  // and egress network probes with their own multi-second timeouts — which
  // does not belong in this package's fast unit suite. The check engine
  // itself (`runChecks` against injected fakes) is covered exhaustively in
  // `doctor/checks.test.ts` and `doctor/render.test.ts`; this route is a
  // thin auth + JSON wrapper around it, and the permission gate below is
  // reached BEFORE any real context is built, so it stays fast.
  test('requires tool.view — an unauthenticated request is rejected with 403 before any check runs', async () => {
    const inner = createDoctorRoutes({ dataDir: '/tmp/does-not-matter', coreProbe: async () => ({ running: false }) })
    const app = withUser(null, inner)
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })
})
