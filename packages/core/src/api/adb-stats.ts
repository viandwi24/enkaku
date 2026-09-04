import { Hono } from 'hono'
import { z } from 'zod'
import type { AdbClient } from '@enkaku/adb'
import { AdbStatsResponseSchema } from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import { can } from '../auth/acl'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { formatDeviceLabel, loadDeviceNumbers } from '../registry/device-number'
import type { AdbMetricsStore } from '../device/adb-metrics'
import type { DeviceHealth } from '../device/health'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = { 'auth.forbidden': 403 }

type AdbStatsResponse = z.infer<typeof AdbStatsResponseSchema>
type TransportStats = AdbStatsResponse['transport']
type HostAdbStats = AdbStatsResponse['hostAdb']
type AdbHealthStats = AdbStatsResponse['adbHealth']
type InputStats = AdbStatsResponse['input']
type VideoStats = AdbStatsResponse['video']

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
/** Same zero-fill contract (plan 88 §3.9, §4.7) — reported before the health monitor exists, e.g. the brief window before `daemon.ts` constructs it once adb is up. `status: 'ok'` is deliberate: a monitor that has never run is not KNOWN to be unhealthy. */
const ZERO_ADB_HEALTH: AdbHealthStats = {
  status: 'ok',
  versionRttMs: null,
  lastCheckedAt: 0,
  window: { seconds: 0, execs: 0, timeouts: 0, timeoutRate: 0 },
  wedged: [],
  stuckOffline: [],
  symptoms: [],
  restartAdvised: false,
}
/** Same zero-fill contract (plan 91 §4.10, §5 step 91.10) — reported before the WS router (`input`, `ws-handlers.ts`'s `inputStats()`) exists. Narrowed to `lanes` only by plan 205 (MVP 04) — the subordinate-grant and per-client fan-out fields this used to carry had no producer once the activity model replaced their source subsystems. */
const ZERO_INPUT: InputStats = {
  lanes: {
    pointer: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
    keys: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
    text: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
  },
}
/** Same zero-fill contract (plan 92 §3.3, §4.5, §5 step 92.3) — reported before `sessions()` returns a manager (e.g. under the orchestrator, or the brief window before `daemon.ts` constructs one) or before `deps.video` is wired at all. */
const ZERO_VIDEO: VideoStats = {
  controlStreams: 0,
  wallStreams: 0,
  buildsRunning: 0,
  buildQueueDepth: 0,
  maxConcurrentBuilds: 0,
  maxTiles: 0,
  maxTilesAuto: false,
  // Plan 100 §3.1, §4.1, step 100.3 — a harmless default for the same brief
  // window every other zero-fill above covers; `daemon.ts` always supplies
  // the real classification once `deps.video` is wired.
  transport: 'loopback',
}
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
  /** `packages/core/src/device/adb-health.ts`'s `AdbServerHealthMonitor.current()` (plan 88 §3.9, §4.7) — same optional/zero-default contract as `transport`/`hostAdb` above. */
  adbHealth?: () => AdbHealthStats | null
  /** `packages/core/src/server/ws-handlers.ts`'s `inputStats()` (plan 91 §4.10, §5 step 91.10) — same optional/zero-default contract as `transport`/`hostAdb`/`adbHealth` above. */
  input?: () => InputStats | null
  /**
   * The build lane's farm-wide settings (plan 92 §3.3, §3.7, §4.5, §5 step
   * 92.3) — `session.maxConcurrentBuilds` plus `wall.maxTiles` AS ACTUALLY
   * APPLIED (the derived number when the stored setting is `0`, never the
   * raw `0` itself) and whether it is currently being derived. Read fresh
   * from `settingsStore` at request time by `daemon.ts`'s wiring. The
   * stream counts and build-lane occupancy come from `sessions()`'s own
   * `videoStats()` instead — this accessor carries only the settings half,
   * mirroring `auto` above (`adb.maxConcurrent`'s own settings/live split).
   * Same optional/zero-default contract as `transport`/`hostAdb`/`adbHealth`
   * above.
   */
  video?: () => { maxConcurrentBuilds: number; maxTiles: number; maxTilesAuto: boolean; transport: NonNullable<VideoStats>['transport'] } | null
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
    // stableId → number for the whole fleet, in ONE statement (plan 124 §3.7,
    // plan 19 §4.3's no-N+1 rule). This route already reads EVERY device row
    // to build its per-device queue table, and Studio's Tools page polls it —
    // a per-row `lookupDeviceNumber` here would be the textbook N+1 on the
    // one endpoint an operator watches while the farm is under load.
    const numbers = loadDeviceNumbers(deps.db)
    // Idle session TTL (plan 42 §4.4) — every session currently held open
    // with no subscriber, oldest first, so the setting's effect is
    // measurable rather than assumed.
    const idle = deps.sessions()?.idleSessions() ?? []
    // The build lane's own occupancy (plan 92 §3.3, §4.3, §4.5, §5 step
    // 92.3, tests H1) — `videoStats()` reads the SAME semaphore
    // `createEntry` queues behind, so `buildsRunning`/`buildQueueDepth`
    // reflect the lane's actual state, never an estimate.
    const videoBuild = deps.sessions()?.videoStats?.()
    const videoSettings = deps.video?.()
    const video: VideoStats = videoBuild
      ? {
          controlStreams: videoBuild.streams.control,
          wallStreams: videoBuild.streams.wall,
          buildsRunning: videoBuild.buildsRunning,
          buildQueueDepth: videoBuild.buildQueueDepth,
          maxConcurrentBuilds: videoSettings?.maxConcurrentBuilds ?? 0,
          maxTiles: videoSettings?.maxTiles ?? 0,
          maxTilesAuto: videoSettings?.maxTilesAuto ?? false,
          transport: videoSettings?.transport ?? 'loopback',
        }
      : ZERO_VIDEO

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
          // Composed server-side (plan 124 §3.7) rather than shipped as
          // `label` + `number` for the caller to compose: every consumer of
          // this row — the Tools page's adb pool table, `AdbRestartDialog`'s
          // "devices with queued work" list — renders the name as one opaque
          // string beside a queue depth, and none of them holds a
          // `DeviceInfo` to compose a number from. `#7 Pixel 6` is the whole
          // point on a rack of identically-named phones: an operator reading
          // "3 commands queued" needs to know WHICH phone that is.
          label: formatDeviceLabel(numbers.get(row.stableId) ?? null, row.label),
          queueDepth: client?.pending(row.serial) ?? 0,
          execMsP50: m.execMsP50,
          execMsP95: m.execMsP95,
          counts: m.counts,
          consecutiveFailures: health?.consecutiveFailures(row.id) ?? 0,
        }
      }),
      transport: deps.transport?.() ?? ZERO_TRANSPORT,
      hostAdb: deps.hostAdb?.() ?? ZERO_HOST_ADB,
      adbHealth: deps.adbHealth?.() ?? ZERO_ADB_HEALTH,
      input: deps.input?.() ?? ZERO_INPUT,
      video,
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
