import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AlwaysOn, EncoderReport, SessionManager } from '@enkaku/session'
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

/** Neither §4.6's route nor its two siblings need these wired for the reprofile/latency tests below — every call supplies the same harmless defaults. */
const noAlwaysOn = () => null
const noDeviceIds = () => []

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
      createVideoRoutes({
        sessions: () => ({ reprofile: async () => ({ restarted: [], skippedBusy: [], unchanged: 0 }), encoders: () => [] }),
        alwaysOn: noAlwaysOn,
        deviceIds: noDeviceIds,
      }),
    )
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an unauthenticated request is refused', async () => {
    const app = withUser(
      null,
      createVideoRoutes({
        sessions: () => ({ reprofile: async () => ({ restarted: [], skippedBusy: [], unchanged: 0 }), encoders: () => [] }),
        alwaysOn: noAlwaysOn,
        deviceIds: noDeviceIds,
      }),
    )
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an admin calling it reaches SessionManager.reprofile and the response round-trips its exact shape', async () => {
    const calls: string[] = []
    const sessions: Pick<SessionManager, 'reprofile' | 'encoders'> = {
      reprofile: async (reason) => {
        calls.push(reason)
        return { restarted: ['dev-1', 'dev-2'], skippedBusy: ['dev-3'], unchanged: 4 }
      },
      encoders: () => [],
    }
    const app = withUser('admin', createVideoRoutes({ sessions: () => sessions, alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }))
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { restarted: string[]; skippedBusy: string[]; unchanged: number }
    expect(body).toEqual({ restarted: ['dev-1', 'dev-2'], skippedBusy: ['dev-3'], unchanged: 4 })
    expect(calls).toEqual(['applied manually from Settings'])
  })

  test('with no sessions available (orchestrator mode, or the adb subsystem is not up yet), refuses E_NOT_SUPPORTED rather than pretending to have restarted anything', async () => {
    const app = withUser('admin', createVideoRoutes({ sessions: () => null, alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }))
    const res = await app.request('/reprofile', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('with a sessions accessor whose reprofile is itself absent (a SessionManager fixture with no video wiring), refuses E_NOT_SUPPORTED the same way', async () => {
    const app = withUser('admin', createVideoRoutes({ sessions: () => ({ encoders: () => [] }), alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }))
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
    const app = withUser(
      'operator',
      createVideoRoutes({ sessions: () => ({ videoLatency: () => [], encoders: () => [] }), alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }),
    )
    const res = await app.request('/latency')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_BAD_REQUEST')
  })

  test('with no sessions is 501 E_NOT_SUPPORTED', async () => {
    const app = withUser('operator', createVideoRoutes({ sessions: () => null, alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }))
    const res = await app.request('/latency?deviceId=dev-1')
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('joins the session snapshot with the stream counters per quality', async () => {
    const sessions: Pick<SessionManager, 'videoLatency' | 'encoders'> = {
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
      encoders: () => [],
    }
    const app = withUser(
      'operator',
      createVideoRoutes({
        sessions: () => sessions,
        streamStats: () => [{ quality: 'control', keyframeRequests: 2, congestionDrops: 5 }],
        alwaysOn: noAlwaysOn,
        deviceIds: noDeviceIds,
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
    const sessions: Pick<SessionManager, 'videoLatency' | 'encoders'> = {
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
      encoders: () => [],
    }
    const app = withUser('operator', createVideoRoutes({ sessions: () => sessions, alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }))
    const res = await app.request('/latency?deviceId=dev-2')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { streams: Array<{ keyframeRequests: number; congestionDrops: number }> }
    expect(body.streams[0]).toMatchObject({ keyframeRequests: 0, congestionDrops: 0 })
  })

  test('an operator may read it (device.view); unauthenticated is 403', async () => {
    const sessions: Pick<SessionManager, 'videoLatency' | 'encoders'> = { videoLatency: () => [], encoders: () => [] }
    const authed = withUser('operator', createVideoRoutes({ sessions: () => sessions, alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }))
    const authedRes = await authed.request('/latency?deviceId=dev-1')
    expect(authedRes.status).toBe(200)

    const anon = withUser(null, createVideoRoutes({ sessions: () => sessions, alwaysOn: noAlwaysOn, deviceIds: noDeviceIds }))
    const anonRes = await anon.request('/latency?deviceId=dev-1')
    expect(anonRes.status).toBe(403)
  })
})

/**
 * `GET /api/video/sessions` (plan 206 §4.6) — the bench harness's
 * `--warmup` mode and operator/owner debugging: every known device's
 * always-on build state joined with its encoder states.
 */
describe('GET /api/video/sessions (plan 206 §4.6)', () => {
  function fakeAlwaysOn(states: Record<string, ReturnType<AlwaysOn['stateOf']>>): Pick<AlwaysOn, 'stateOf' | 'stats'> {
    return {
      stateOf: (deviceId) => states[deviceId] ?? { state: 'none', step: null, attempt: 0, usbRoot: null },
      stats: () => ({ running: 1, queued: 2, perRoot: { '3': { running: 1, queued: 0 } }, buildsPerUsbRoot: 4, farmCeiling: 16 }),
    }
  }

  test('answers the schema with one row per known device', async () => {
    const encoders: EncoderReport[] = [
      {
        deviceId: 'dev-1',
        wall: { engine: 'scrcpy', maxSize: 480, maxFps: 15, bitRate: 1_000_000, viewers: 1, bytesPerSec: 0, framesPerSec: 0, sinceSec: 10, lingerEndsAt: null },
        control: null,
      },
    ]
    const app = withUser(
      'operator',
      createVideoRoutes({
        sessions: () => ({ encoders: () => encoders }),
        alwaysOn: () => fakeAlwaysOn({ 'dev-1': { state: 'ready', step: null, attempt: 0, usbRoot: '3' }, 'dev-2': { state: 'preparing', step: 3, attempt: 0, usbRoot: '3' } }),
        deviceIds: () => [
          { deviceId: 'dev-1', number: 1 },
          { deviceId: 'dev-2', number: 2 },
        ],
      }),
    )
    const res = await app.request('/sessions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      devices: Array<{ deviceId: string; number: number | null; state: string; step: number | null; wall: unknown; control: unknown }>
      builder: { running: number; queued: number; perRoot: Record<string, { running: number; queued: number }>; buildsPerUsbRoot: number; farmCeiling: number }
      rssBytes: number
    }
    expect(body.devices).toHaveLength(2)
    const d1 = body.devices.find((d) => d.deviceId === 'dev-1')
    expect(d1).toMatchObject({ number: 1, state: 'ready', step: null })
    expect(d1?.wall).not.toBeNull()
    expect(d1?.control).toBeNull()
    const d2 = body.devices.find((d) => d.deviceId === 'dev-2')
    expect(d2).toMatchObject({ number: 2, state: 'preparing', step: 3 })
    expect(body.builder).toEqual({ running: 1, queued: 2, perRoot: { '3': { running: 1, queued: 0 } }, buildsPerUsbRoot: 4, farmCeiling: 16 })
    expect(typeof body.rssBytes).toBe('number')
  })

  test('with no session manager answers 501 E_NOT_SUPPORTED', async () => {
    const app = withUser('operator', createVideoRoutes({ sessions: () => null, alwaysOn: () => fakeAlwaysOn({}), deviceIds: () => [] }))
    const res = await app.request('/sessions')
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('with no always-on builder (orchestrator mode) answers 501 E_NOT_SUPPORTED', async () => {
    const app = withUser('operator', createVideoRoutes({ sessions: () => ({ encoders: () => [] }), alwaysOn: noAlwaysOn, deviceIds: () => [] }))
    const res = await app.request('/sessions')
    expect(res.status).toBe(501)
  })
})
