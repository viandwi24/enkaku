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

/**
 * `GET /api/video/latency?deviceId=<id>` (plan 203 §4.7, §5 step 203.6) —
 * the server-side leg of the latency picture: `SessionManager.videoLatency`
 * joined with `ws-handlers.ts`'s keyframe/congestion counters.
 */
describe('GET /api/video/latency (plan 203 §4.7, §5 step 203.6)', () => {
  test('without deviceId is 400 E_BAD_REQUEST', async () => {
    const app = withUser('operator', createVideoRoutes({ sessions: () => ({ videoLatency: () => [] }) }))
    const res = await app.request('/latency')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_BAD_REQUEST')
  })

  test('with no sessions is 501 E_NOT_SUPPORTED', async () => {
    const app = withUser('operator', createVideoRoutes({ sessions: () => null }))
    const res = await app.request('/latency?deviceId=dev-1')
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('joins the session snapshot with the stream counters per quality', async () => {
    const sessions: Pick<SessionManager, 'videoLatency'> = {
      videoLatency: (deviceId) => {
        expect(deviceId).toBe('dev-1')
        return [
          {
            quality: 'control',
            viewers: 1,
            frames: 10,
            firstFrameMs: 120,
            ptsIntervalMsP50: 33,
            ptsIntervalMsP95: 40,
            arrivalJitterMsP95: 3,
            lastFrameAgeMs: 12,
          },
        ]
      },
    }
    const app = withUser(
      'operator',
      createVideoRoutes({
        sessions: () => sessions,
        streamStats: () => [{ quality: 'control', keyframeRequests: 2, congestionDrops: 5 }],
      }),
    )
    const res = await app.request('/latency?deviceId=dev-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      deviceId: string
      at: number
      streams: Array<{ quality: string; keyframeRequests: number; congestionDrops: number }>
    }
    expect(body.deviceId).toBe('dev-1')
    expect(body.streams).toHaveLength(1)
    expect(body.streams[0]).toMatchObject({
      quality: 'control',
      viewers: 1,
      frames: 10,
      firstFrameMs: 120,
      keyframeRequests: 2,
      congestionDrops: 5,
    })
  })

  test('a stream with no matching counters reads zero, never undefined', async () => {
    const sessions: Pick<SessionManager, 'videoLatency'> = {
      videoLatency: () => [
        {
          quality: 'wall',
          viewers: 0,
          frames: 0,
          firstFrameMs: null,
          ptsIntervalMsP50: 0,
          ptsIntervalMsP95: 0,
          arrivalJitterMsP95: 0,
          lastFrameAgeMs: null,
        },
      ],
    }
    const app = withUser('operator', createVideoRoutes({ sessions: () => sessions }))
    const res = await app.request('/latency?deviceId=dev-2')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { streams: Array<{ keyframeRequests: number; congestionDrops: number }> }
    expect(body.streams[0]).toMatchObject({ keyframeRequests: 0, congestionDrops: 0 })
  })

  test('an operator may read it (device.view); unauthenticated is 403', async () => {
    const sessions: Pick<SessionManager, 'videoLatency'> = { videoLatency: () => [] }
    const authed = withUser('operator', createVideoRoutes({ sessions: () => sessions }))
    const authedRes = await authed.request('/latency?deviceId=dev-1')
    expect(authedRes.status).toBe(200)

    const anon = withUser(null, createVideoRoutes({ sessions: () => sessions }))
    const anonRes = await anon.request('/latency?deviceId=dev-1')
    expect(anonRes.status).toBe(403)
  })
})
