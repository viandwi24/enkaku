import { Hono } from 'hono'
import type { AdbClient } from '@enkaku/adb'
import type { SessionManager } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import { can } from '../auth/acl'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { AdbMetricsStore } from '../device/adb-metrics'
import type { DeviceHealth } from '../device/health'
import { EnkakuError } from '../util/errors'

const ERROR_STATUS: Record<string, number> = { 'auth.forbidden': 403 }

/**
 * `GET /api/adb/stats` (plan 23 §4.6, permission `device.view`) — the global
 * semaphore's live state plus per-device queue depth, latency percentiles,
 * outcome counts, and the health tracker's failure streak. Read-only; nothing
 * here is persisted (§4.6 — "no new table, no retention policy").
 */
export function createAdbStatsRoutes(deps: {
  db: Db
  client: () => AdbClient | null
  metrics: AdbMetricsStore
  health: () => DeviceHealth | null
  /** Whether the current global cap comes from the autoscaler (true) or a pinned `adb.maxConcurrent` (false). */
  auto: () => boolean
  /** Idle session TTL (plan 42 §4.4) — exposed so the effect is measurable rather than assumed. Null under the orchestrator. */
  sessions: () => SessionManager | null
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/', (c) => {
    const user = c.get('user')
    if (!user || !can(user.role, 'device.view')) {
      throw new EnkakuError('auth.forbidden', 'requires the device.view permission')
    }
    const client = deps.client()
    const globalStats = client?.stats() ?? { maxConcurrent: 0, inFlight: 0, waiting: 0 }
    // The streaming lane's own occupancy (plan 24 §3.2, §8 risks — "shows
    // lane occupancy for verification") — deliberately reported separately
    // from `global` above, since it draws from a completely different budget.
    const streamStats = client?.streamStats() ?? { maxStreams: 0, maxStreamsPerDevice: 0, streams: 0, perDevice: {} }
    const health = deps.health()
    const rows = deps.db.select().from(devices).all()
    // Idle session TTL (plan 42 §4.4) — every session currently held open
    // with no subscriber, oldest first, so the setting's effect is
    // measurable rather than assumed.
    const idle = deps.sessions()?.idleSessions() ?? []

    return c.json({
      global: {
        maxConcurrent: globalStats.maxConcurrent,
        auto: deps.auto(),
        inFlight: globalStats.inFlight,
        waiting: globalStats.waiting,
      },
      streams: {
        maxStreams: streamStats.maxStreams,
        maxStreamsPerDevice: streamStats.maxStreamsPerDevice,
        active: streamStats.streams,
        perDevice: streamStats.perDevice,
      },
      idleSessions: idle,
      devices: rows.map((row) => {
        const m = deps.metrics.forSerial(row.serial)
        return {
          deviceId: row.id,
          label: row.label,
          queueDepth: client?.pending(row.serial) ?? 0,
          execMsP50: m.execMsP50,
          execMsP95: m.execMsP95,
          counts: m.counts,
          consecutiveFailures: health?.consecutiveFailures(row.id) ?? 0,
        }
      }),
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
