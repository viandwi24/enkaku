import { z } from 'zod'

/**
 * "Is adb stuck?" (plan 88 §3.9, §4.7, fixes F21/F23) — five distinct
 * symptoms, because "stuck" is not one condition and each has its own
 * restart verdict. See `packages/core/src/device/adb-health.ts`'s own
 * header for what detects each one and whether restarting adb would help.
 */
export const AdbStuckSymptomSchema = z.enum([
  'server-unreachable',
  'server-unresponsive',
  'transports-wedged',
  'reconnect-ineffective',
  'timeout-storm',
])
export type AdbStuckSymptom = z.infer<typeof AdbStuckSymptomSchema>

/**
 * The adb server health verdict (plan 88 §3.9, §4.7) — computed
 * continuously in the core (`device/adb-health.ts`), exposed on
 * `GET /api/adb/stats`'s `adbHealth` block, and broadcast on `adb.health`
 * whenever `status` transitions. Read-only by construction: nothing that
 * produces or carries this type may also stop or start the adb server
 * (that line is spec §10.4, and plan 88 §5 step 88.8 keeps it in a
 * different file entirely).
 */
export const AdbServerHealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'stuck']),
  /** `null` whenever the most recent probe did not get a timely reply. */
  versionRttMs: z.number().nullable(),
  lastCheckedAt: z.number(),
  /** Farm-wide, not per-device — "is adb itself timing out" is a server-wide question (plan 88 §3.9's `timeout-storm`). */
  window: z.object({
    seconds: z.number(),
    execs: z.number(),
    timeouts: z.number(),
    /** `0` when `execs` is `0` — never `NaN`. */
    timeoutRate: z.number(),
  }),
  /** Serials adb currently lists as `device` whose last several execs all timed out — one is a phone, several at once is the server. */
  wedged: z.array(z.object({ serial: z.string(), consecutiveTimeouts: z.number(), adbState: z.string() })),
  /** Every serial currently offline, with how long and how many automatic reconnect nudges it has had. */
  stuckOffline: z.array(z.object({ serial: z.string(), state: z.string(), sinceSec: z.number(), nudges: z.number() })),
  symptoms: z.array(z.object({ symptom: AdbStuckSymptomSchema, detail: z.string(), since: z.number() })),
  /**
   * Whether a restart is the recommended action for the CURRENT symptom
   * set. `false` is not the same as "healthy" — it can also mean
   * "restarting adb will not fix this" (e.g. `server-unreachable`, which
   * self-heals on its own, or a single unresponsive device holding a slot).
   */
  restartAdvised: z.boolean(),
})
export type AdbServerHealth = z.infer<typeof AdbServerHealthSchema>

/** `GET /api/adb/stats` (`packages/core/src/api/adb-stats.ts`). */
export const AdbStatsResponseSchema = z.object({
  global: z.object({
    maxConcurrent: z.number(),
    auto: z.boolean(),
    inFlight: z.number(),
    waiting: z.number(),
  }),
  streams: z.object({
    maxStreams: z.number(),
    maxStreamsPerDevice: z.number(),
    active: z.number(),
    perDevice: z.record(z.string(), z.number()),
  }),
  idleSessions: z.array(z.unknown()),
  devices: z.array(
    z.object({
      deviceId: z.string(),
      label: z.string(),
      queueDepth: z.number(),
      execMsP50: z.number().nullable(),
      execMsP95: z.number().nullable(),
      counts: z.object({ ok: z.number(), timeout: z.number(), busy: z.number(), error: z.number() }),
      consecutiveFailures: z.number(),
    }),
  ),
  /**
   * The shared `/ws` transport's own health (plan 85 §3.6, §4.6) — measures,
   * rather than picks between, H1 (control replies queued behind video on
   * the shared socket) and H2 (a silent-but-open socket the client cannot
   * detect on its own). `watchdogReconnects` counts connection churn the
   * SERVER can observe (opens beyond peak concurrency) — it can never be
   * attributed to the client's silence watchdog specifically, since
   * `ClientMessage` deliberately carries no such signal; the browser console
   * is the source of truth for a genuinely watchdog-caused reconnect.
   */
  transport: z.object({
    connections: z.number(),
    bufferedBytesMax: z.number(),
    bufferedBytesP95: z.number(),
    videoBytesPerSec: z.number(),
    controlReplyMsP50: z.number(),
    controlReplyMsP95: z.number(),
    watchdogReconnects: z.number(),
  }),
  /** `packages/core/src/device/host-adb.ts`'s `HostAdb.stats()`, verbatim (plan 85 §3.4, §4.6). */
  hostAdb: z.object({
    running: z.number(),
    maxConcurrent: z.number(),
    installsRunning: z.number(),
    longLived: z.number(),
  }),
  /** "Is adb stuck?" (plan 88 §3.9, §4.7) — see `AdbServerHealthSchema` above. */
  adbHealth: AdbServerHealthSchema,
})

/**
 * `GET /api/tools/adb/restart-preview` (plan 88 §3.10, §5 step 88.8) — live
 * counts fetched fresh right before the confirmation dialog renders, so its
 * copy states THIS farm's numbers rather than a generic warning ("all 20
 * devices disconnect... Control is released on 2 devices... 1 running job
 * fails..."). Never cached.
 */
export const AdbRestartPreviewSchema = z.object({
  devicesTotal: z.number(),
  /** Live sessions (wall tiles / control) that will stop and resume. */
  sessionsActive: z.number(),
  /** Manual leases that will be released. */
  leasesHeld: z.number(),
  /** Jobs that will fail unless the restart is cancelled. */
  jobsRunning: z.number(),
  /** How many devices have a remembered network address and will be dialled again after the restart (plan 88 §3.2, §3.10). */
  networkDevicesWithEndpoint: z.number(),
  restartCooldownSec: z.number(),
})
export type AdbRestartPreview = z.infer<typeof AdbRestartPreviewSchema>

/**
 * `POST /api/tools/adb/restart` (plan 88 §3.10, §4.8, §5 step 88.8) — the
 * operator-triggered restart's report, the wire shape of
 * `packages/core/src/tools/adb-server-control.ts`'s `AdbCycleReport`. Also
 * the shape of a version swap's report, since both share the one `cycle()`
 * implementation — `reason` says which.
 */
export const AdbRestartReportSchema = z.object({
  reason: z.enum(['swap', 'restart']),
  durationMs: z.number(),
  sessionsClosed: z.number(),
  leasesReleased: z.number(),
  jobsFailed: z.array(z.string()),
  devicesBefore: z.number(),
  devicesAfter: z.number(),
  /** How many `stableId`s with a remembered network address were re-dialled after the server came back up. */
  reattachAttempted: z.number(),
  reattachSucceeded: z.number(),
  /** Named, not just counted (plan 88 §3.10's report obligation: "the report names anything that did not come back"). */
  reattachFailed: z.array(z.object({ stableId: z.string(), label: z.string() })),
  serverVersion: z.string().nullable(),
})
export type AdbRestartReport = z.infer<typeof AdbRestartReportSchema>

/** `GET/POST /api/devices/:id/adb-endpoint`. */
export const AdbEndpointStateSchema = z.object({
  host: z.string(),
  port: z.number(),
  connections: z.number(),
  openedAt: z.number(),
  expiresAt: z.number(),
})
export const AdbEndpointResponseSchema = z.object({ endpoint: AdbEndpointStateSchema.nullable() })

/** `POST /api/devices/:id/adb-endpoint`. */
export const AdbEndpointCreateResponseSchema = z.object({
  host: z.string(),
  port: z.number(),
  expiresAt: z.number(),
  command: z.string(),
})
