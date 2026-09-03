import { Hono } from 'hono'
import { VideoLatencyResponseSchema, VideoReprofileResponseSchema, type Quality } from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = { E_NOT_SUPPORTED: 501, E_BAD_REQUEST: 400 }

/**
 * `POST /api/video/reprofile` (plan 92 §3.8, §4.5, §5 step 92.2) — the
 * manual "apply now" the Video settings section's own button calls, plus
 * anyone with `settings.manage` from curl. `daemon.ts`'s own debounced
 * `settingsStore.onChange` path (§3.8 rule 2) calls the exact same
 * `SessionManager.reprofile()` this route calls — one mechanism, two
 * triggers, never two sources of truth about what "reprofile" means.
 */
export function createVideoRoutes(deps: {
  /**
   * `daemon.ts`'s usual forward-ref pattern (`connection.sessions` in
   * `devices.ts`, `adb-stats.ts`'s `sessions`, ...) — `sessions` is assigned
   * later in boot than this router is built. `null`/absent under the
   * orchestrator or before the adb subsystem is up; `reprofile` itself is
   * optional on `SessionManager` for the same fixture-compatibility reason
   * `videoStats`/`restartAt` already are (`packages/session/src/manager.ts`).
   */
  sessions: () => Pick<SessionManager, 'reprofile' | 'videoLatency'> | null
  /**
   * `ws-handlers.ts`'s `videoStreamStats` (plan 203 §4.6), forward-ref like
   * `adb-stats.ts`'s `transport`. Absent → zero counters.
   */
  streamStats?: (deviceId: string) => Array<{ quality: Quality; keyframeRequests: number; congestionDrops: number }> | null
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.post('/reprofile', requirePermission('settings.manage'), async (c) => {
    const reprofile = deps.sessions()?.reprofile
    if (!reprofile) {
      throw new EnkakuError('E_NOT_SUPPORTED', 'video sessions are not available (orchestrator mode, or the adb subsystem is not ready yet)')
    }
    const result = await reprofile('applied manually from Settings')
    return typedJson(c, VideoReprofileResponseSchema, result)
  })

  /**
   * `GET /api/video/latency?deviceId=<id>` (plan 203 §4.7) — the server-side
   * leg of the latency picture: PTS statistics from `SessionManager` joined
   * with the keyframe/congestion counters `ws-handlers.ts` keeps, per open
   * `(deviceId, quality)` entry.
   */
  app.get('/latency', requirePermission('device.view'), (c) => {
    const deviceId = c.req.query('deviceId')?.trim() ?? ''
    if (!deviceId) throw new EnkakuError('E_BAD_REQUEST', 'deviceId is required')
    const videoLatency = deps.sessions()?.videoLatency
    if (!videoLatency) {
      throw new EnkakuError('E_NOT_SUPPORTED', 'video sessions are not available (orchestrator mode, or the adb subsystem is not ready yet)')
    }
    const counters = deps.streamStats?.(deviceId) ?? []
    const streams = videoLatency(deviceId).map((s) => {
      const c2 = counters.find((x) => x.quality === s.quality)
      return { ...s, keyframeRequests: c2?.keyframeRequests ?? 0, congestionDrops: c2?.congestionDrops ?? 0 }
    })
    return typedJson(c, VideoLatencyResponseSchema, { deviceId, at: Date.now(), streams })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
