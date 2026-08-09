import { Hono } from 'hono'
import { z } from 'zod'
import type { AdbClient } from '@enkaku/adb'
import { AdbStatsResponseSchema } from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import { can } from '../auth/acl'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { AdbMetricsStore } from '../device/adb-metrics'
import type { DeviceHealth } from '../device/health'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = { 'auth.forbidden': 403 }

type AdbStatsResponse = z.infer<typeof AdbStatsResponseSchema>
type TransportStats = AdbStatsResponse['transport']
type HostAdbStats = AdbStatsResponse['hostAdb']

/** Zero-filled defaults (plan 85 §4.6) — reported before the WS router (`transport`) or `host-adb.ts` (`hostAdb`) exist, e.g. the brief window before `attachWsRouter` runs. */
const ZERO_TRANSPORT: TransportStats = {
  connections: 0,
  bufferedBytesMax: 0,
  bufferedBytesP95: 0,
  videoBytesPerSec: 0,
  controlReplyMsP50: 0,
  controlReplyMsP95: 0,
  watchdogReconnects: 0,
}
const ZERO_HOST_ADB: HostAdbStats = { running: 0, maxConcurrent: 0, installsRunning: 0, longLived: 0 }

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
  /**
   * The shared `/ws` transport's own health (plan 85 §3.6, §4.6) — from
   * `ws-handlers.ts`'s `transportStats()`, wired through `daemon.ts`'s usual
   * forward-ref pattern. Optional so existing tests/hosts that predate plan
   * 85 keep compiling; `null`/absent reports the zero-filled defaults, never
   * a missing field (the schema requires them).
   */
  transport?: () => TransportStats | null
  /** `packages/core/src/device/host-adb.ts`'s `HostAdb.stats()` (plan 85 §3.4, §4.6) — same optional/zero-default contract as `transport` above. */
  hostAdb?: () => HostAdbStats | null
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

    return typedJson(c, AdbStatsResponseSchema, {
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
      transport: deps.transport?.() ?? ZERO_TRANSPORT,
      hostAdb: deps.hostAdb?.() ?? ZERO_HOST_ADB,
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
