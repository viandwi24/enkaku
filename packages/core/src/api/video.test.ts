import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { SessionManager } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import { createVideoRoutes } from './video'

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

/**
 * `POST /api/video/reprofile` (plan 92 §3.8, §4.5, §5 step 92.2) — the
 * manual "apply now" the Video settings section's own button calls.
 * `SessionManager.reprofile` itself (the five rules) is proven exhaustively
 * in `packages/session/src/manager.test.ts`; this route's own job is
 * narrower — the permission gate, calling the SAME function the automatic
 * debounced path in `daemon.ts` calls, and the orchestrator-mode refusal.
 */
describe('POST /api/video/reprofile (plan 92 §3.8, §4.5, §5 step 92.2)', () => {
  test('requires settings.manage — an operator is refused', async () => {
    const app = withUser(
      'operator',
      createVideoRoutes({ sessions: () => ({ reprofile: async () => ({ restarted: [], skippedBusy: [], unchanged: 0 }) }) }),
    )
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an unauthenticated request is refused', async () => {
    const app = withUser(
      null,
      createVideoRoutes({ sessions: () => ({ reprofile: async () => ({ restarted: [], skippedBusy: [], unchanged: 0 }) }) }),
    )
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an admin calling it reaches SessionManager.reprofile and the response round-trips its exact shape', async () => {
    const calls: string[] = []
    const sessions: Pick<SessionManager, 'reprofile'> = {
      reprofile: async (reason) => {
        calls.push(reason)
        return { restarted: ['dev-1', 'dev-2'], skippedBusy: ['dev-3'], unchanged: 4 }
      },
    }
    const app = withUser('admin', createVideoRoutes({ sessions: () => sessions }))
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { restarted: string[]; skippedBusy: string[]; unchanged: number }
    expect(body).toEqual({ restarted: ['dev-1', 'dev-2'], skippedBusy: ['dev-3'], unchanged: 4 })
    expect(calls).toEqual(['applied manually from Settings'])
  })

  test('with no sessions available (orchestrator mode, or the adb subsystem is not up yet), refuses E_NOT_SUPPORTED rather than pretending to have restarted anything', async () => {
    const app = withUser('admin', createVideoRoutes({ sessions: () => null }))
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('with a sessions accessor whose reprofile is itself absent (a SessionManager fixture with no video wiring), refuses E_NOT_SUPPORTED the same way', async () => {
    const app = withUser('admin', createVideoRoutes({ sessions: () => ({}) }))
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(501)
  })
})
