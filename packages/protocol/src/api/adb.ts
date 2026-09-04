import { z } from 'zod'
import { WallTransportSchema } from '../settings'
import { QualitySchema } from '../messages/stream'

/** One live scrcpy forward this process currently owns (plan 223 §4.2, §4.3) — `SessionManager.forwards()` verbatim. */
export const ForwardRecordSchema = z.object({
  deviceId: z.string(),
  quality: QualitySchema,
  port: z.number().int(),
  scid: z.string(),
  openedAt: z.number().int(),
})
export type ForwardRecord = z.infer<typeof ForwardRecordSchema>

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
    /** Session-lifetime streams (plan 208 §3.6, the ui-server instrumentation) — counted, never gated by either cap above. */
    pinned: z.number(),
    perDevice: z.record(z.string(), z.number()),
  }),
  devices: z.array(
    z.object({
      deviceId: z.string(),
      /**
       * The device's human name, already composed with its number — `#7 Pixel
       * 6`, or the bare label when it has no reservation (plan 124 §3.7, via
       * the core's `formatDeviceLabel`).
       *
       * Pre-composed rather than split into `label` + `number` because this
       * is a diagnostics table and nothing else: every consumer
       * (`app/tools/page.tsx`'s adb pool rows, `AdbRestartDialog`'s
       * "devices with queued work" list) renders the name as one string it
       * never takes apart, and none of them holds a `DeviceInfo` to compose
       * a number from. Two fields here would buy a composition nobody
       * performs.
       */
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
   * `ClientMessage` deliberately carries no such signal; the browser's own
   * developer tools are the source of truth for a genuinely watchdog-caused
   * reconnect.
   */
  transport: z.object({
    connections: z.number(),
    bufferedBytesMax: z.number(),
    bufferedBytesP95: z.number(),
    videoBytesPerSec: z.number(),
    controlReplyMsP50: z.number(),
    controlReplyMsP95: z.number(),
    watchdogReconnects: z.number(),
    /** Cumulative since boot (plan 223 §4.7) — every time a viewer's `ws.send()` returned `0` (R8) or a drop-to-keyframe fired under congestion. Never resets except on core restart. `.optional()`, same reason as `hostAdb.installsByRoot`. */
    framesDroppedTotal: z.number().int().optional(),
  }),
  /** `packages/core/src/device/host-adb.ts`'s `HostAdb.stats()`, verbatim (plan 85 §3.4, §4.6). */
  hostAdb: z.object({
    running: z.number(),
    maxConcurrent: z.number(),
    installsRunning: z.number(),
    longLived: z.number(),
    /**
     * Per-USB-root install occupancy (plan 223 §4.3, §4.6/G13) — keyed by
     * `usbRootOf`'s own root string (`@enkaku/session`, plan 206 §4.2;
     * `'network'`/`'unknown'` for a TCP device or one adb has not yet listed
     * with a `usb:` field). `.optional()` for the same reason `input`/`video`
     * are on this schema: a consumer built before this field lands must keep
     * parsing; the real running core always sends it.
     */
    installsByRoot: z.record(z.string(), z.object({ running: z.number().int(), queued: z.number().int() })).optional(),
  }),
  /** "Is adb stuck?" (plan 88 §3.9, §4.7) — see `AdbServerHealthSchema` above. */
  adbHealth: AdbServerHealthSchema,
  /**
   * Input-lane observability — `packages/core/src/server/ws-handlers.ts`'s
   * `inputStats()`, wired into this route through the same forward-ref
   * pattern `transport`/`hostAdb`/`adbHealth` above already use. Narrowed by
   * plan 205 (MVP 04) to `lanes` only: the subordinate-grant and multi-client
   * spread observability fields this block used to carry had no producer
   * once the activity model replaced their source subsystems (plan 205 §3.2).
   *
   * `.optional()`, unlike `transport`/`hostAdb`/`adbHealth` right above —
   * deliberately, and ONLY for this field: this step's own file-ownership
   * boundary excludes `packages/studio/**`, and Studio's `AdbServerCard`
   * already parses this exact schema (`AdbServerCard.tsx`) against a test
   * fixture (`AdbServerCard.test.tsx`'s `statsBody()`) that this step
   * cannot update in the same commit. Making the block required would fail
   * that fixture's `AdbStatsResponseSchema.parse()` the instant this line
   * landed, for a card that renders none of this block's data. The real
   * running core still ALWAYS sends it, zero-filled the same way
   * `transport`/`hostAdb`/`adbHealth` are (`adb-stats.ts`'s own
   * `ZERO_INPUT`) — `.optional()` only widens what a CONSUMER may validate,
   * it changes nothing about what the server produces.
   */
  input: z
    .object({
      /** Per-lane depth/wait percentiles/refusals, aggregated across every currently-open local `DeviceSession`'s own arbiter (there is no farm-wide arbiter) — `depth`/`refusals` summed, `waitMsP50`/`waitMsP95` the WORST value observed among live devices for that lane (`ws-handlers.ts`'s `inputStats()` doc comment has the full reasoning). Keyed by `InputLane` (`pointer`/`keys`/`text`), reported as `z.record` rather than three named fields so an older/newer core adding a fourth lane never breaks this schema. */
      lanes: z.record(z.string(), z.object({ depth: z.number(), waitMsP50: z.number(), waitMsP95: z.number(), refusals: z.number() })),
    })
    .optional(),
  /**
   * The always-on builder's own occupancy plus live streams by quality
   * (plan 92 §3.3, §4.3, §4.5, §5 step 92.3, tests H1; reworked by plan 206
   * §4.10) — `packages/session/src/manager.ts`'s `SessionManager.encoders()`
   * joined with `@enkaku/session`'s `AlwaysOn.stats()`, wired into this
   * route through the same forward-ref pattern `transport`/`hostAdb`/
   * `adbHealth`/`input` above already use. `maxTiles`/
   * `maxTilesAuto` report `wall.maxTiles` AS IT IS ACTUALLY BEING APPLIED —
   * the derived number when the setting is `0` (auto, §3.7), never the raw
   * stored `0` itself — so the Wall's status strip and the settings
   * projection (§3.9) can both read one number and agree with each other.
   *
   * `.optional()` for the exact reason `input` above is: this step's own
   * file-ownership boundary excludes `packages/studio/**`, and
   * `AdbServerCard.test.tsx`'s `statsBody()` fixture predates this field.
   * The real running core still ALWAYS sends it, zero-filled the same way
   * `transport`/`hostAdb`/`adbHealth`/`input` are — `.optional()` only
   * widens what a CONSUMER may validate, it changes nothing about what the
   * server produces.
   */
  video: z
    .object({
      controlStreams: z.number().int(),
      wallStreams: z.number().int(),
      buildsRunning: z.number().int(),
      buildQueueDepth: z.number().int(),
      /** The one remaining session build knob (plan 206 §4.5) and the farm-wide ceiling constant (`SESSION_BUILD_FARM_CEILING`, overridable by `ENKAKU_SESSION_BUILD_CEILING`). */
      buildsPerUsbRoot: z.number().int(),
      farmCeiling: z.number().int(),
      maxTiles: z.number().int(),
      maxTilesAuto: z.boolean(),
      /**
       * Plan 100 §3.1, §4.1, step 100.3 — how the `maxTilesAuto` count above
       * was actually resolved: `'wan'` means the bandwidth bound is the
       * pre-plan-100 hard-pinned 20 Mbit/s constant (§3.6, byte-identical to
       * cloud's old behaviour); `'loopback'`/`'lan'` mean it is the farm's own
       * generous `wall.bandwidthBps` (default 200 Mbit/s), which essentially
       * never binds — the decode bound is what actually governs a local wall.
       * Lets the settings projection say WHY a number is what it is
       * ("auto (decode-bound, loopback)") instead of showing one unlabelled
       * integer.
       */
      transport: WallTransportSchema,
    })
    .optional(),
  /** Every live forward this process holds (plan 223 §4.2). `.optional()` for the same reason as `input`/`video` above. */
  forwards: z.array(ForwardRecordSchema).optional(),
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
  /** Live control/command activities that will end. */
  controlled: z.number(),
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
  controlsEnded: z.number(),
  jobsFailed: z.array(z.string()),
  devicesBefore: z.number(),
  devicesAfter: z.number(),
  /** How many `stableId`s with a remembered network address were re-dialled after the server came back up. */
  reattachAttempted: z.number(),
  reattachSucceeded: z.number(),
  /**
   * Named, not just counted (plan 88 §3.10's report obligation: "the report names anything that did not come back").
   *
   * `number` rides alongside `label` rather than being baked into it (plan
   * 124 §3.1, §3.7) — a farm of identical models reports three rows reading
   * `SM-F721U1` otherwise, which names nothing. It is a SEPARATE field, not a
   * pre-composed string, for the same reason plan 124 §10 gave for a
   * different payload's per-member rows: the renderer composes once, so a
   * caller that also holds a `DeviceInfo` cannot end up rendering
   * `#7 #7 SM-F721U1`. `null` for a device whose reservation was explicitly released.
   *
   * Note this is a DIFFERENT payload from the adb pool stats
   * (`AdbStatsResponseSchema` above), whose `label` plan 124 step 124.5 did
   * pre-compose server-side. The two were conflated once during that step;
   * they are not the same object and do not follow the same rule.
   */
  reattachFailed: z.array(z.object({ stableId: z.string(), label: z.string(), number: z.number().int().nullable() })),
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
