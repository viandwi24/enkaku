import { z } from 'zod'
import { WallTransportSchema } from '../settings'

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
  /**
   * Co-control observability (plan 91 §4.10, §5 step 91.10, tests H2/H4) —
   * `packages/core/src/server/ws-handlers.ts`'s `inputStats()`, wired into
   * this route through the same forward-ref pattern `transport`/`hostAdb`/
   * `adbHealth` above already use. `lanes`/`assistsActive`/`mirrorGroups`/
   * `mirrorMembers`/`mirrorFanoutMsP50`/`mirrorFanoutMsP95` are §4.10's own
   * literal fields; `queueWaitMs`/`uncollectedGrants`/`orphanedMirrorGroups`
   * are this step's own extension — the `co-control` doctor check needs the
   * CONFIGURED wait budget (to compare against the observed `waitMsP95`s
   * below) and the two leak counts (a grant or a mirror group that outlives
   * the connection it was subordinate to), neither of which §4.10's
   * pseudocode names but both of which the step's own brief asks for.
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
      /** Farm-wide count of currently-live co-control (Assist) grants. */
      assistsActive: z.number(),
      /** Farm-wide count of currently-live mirror groups. */
      mirrorGroups: z.number(),
      /** Farm-wide count of live mirror-group members, summed across every group. */
      mirrorMembers: z.number(),
      mirrorFanoutMsP50: z.number(),
      mirrorFanoutMsP95: z.number(),
      /** The farm's currently-configured `coControl.queueWaitMs` (settings §4.5) — the budget the `co-control` doctor check compares each lane's OBSERVED `waitMsP95` against. */
      queueWaitMs: z.number(),
      /** Leak detector: grants whose `expiresAt` is well past due despite the reaper's sweep — see `co-control.ts`'s `rawGrantSnapshot()`. */
      uncollectedGrants: z.number(),
      /** Leak detector: mirror groups whose owner's WS connection is no longer open — see `mirror/group.ts`'s `allGroups()`. */
      orphanedMirrorGroups: z.number(),
    })
    .optional(),
  /**
   * The build lane's own occupancy plus live streams by quality (plan 92
   * §3.3, §4.3, §4.5, §5 step 92.3, tests H1) —
   * `packages/session/src/manager.ts`'s `SessionManager.videoStats()`, wired
   * into this route through the same forward-ref pattern `transport`/
   * `hostAdb`/`adbHealth`/`input` above already use. `maxTiles`/
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
      maxConcurrentBuilds: z.number().int(),
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
  /**
   * The command console's own observability (plan 93 §3.5, §3.8, §7.3, §5
   * step 93.12) — the numbers hypotheses H1, H2 and H4 are settled by. Wired
   * from `packages/core/src/command-console/runner.ts`'s `CommandRunner.stats()`
   * through the same forward-ref pattern `transport`/`hostAdb`/`adbHealth`/
   * `input`/`video` above already use.
   *
   * `.optional()` for the SAME reason `input`/`video` above are: a consumer
   * that predates this field must keep parsing. The real running core
   * always sends it, zero-filled the same way the other forward-ref blocks
   * are, once `daemon.ts` wires the dependency through (tracked separately
   * — see `adb-stats-command-console-wiring.test.ts`).
   */
  commandConsole: z
    .object({
      /** `active.size` in the runner — command runs currently dispatching or awaiting-continue. */
      runsInFlight: z.number().int(),
      /** Members with an exec genuinely outstanding right now, summed across every in-flight run — bounded by `MAX_POOL_CONCURRENCY` (32) per run, not farm-wide. */
      membersInFlight: z.number().int(),
      /** `command.progress` frames actually broadcast per second, averaged over the trailing 60s — the coalescer's own effect, measured (H2: ≤4/s at 100 members is the spec's own ceiling, §3.5). */
      coalescedFramesPerSec: z.number(),
      /** Distinct output hashes ÷ total settled execs, cumulative across every run this core process has driven since it started (not time-windowed, unlike the two rate fields below — a run's own grouping is a property of that run, and the cumulative view is what tells whether H1 holds across many runs, not just the latest one) — H1's own number: near 1.0 means grouping is not helping and the default should flip to a flat table (§7.3's 20-device rung). `0` when nothing has settled yet, never `NaN`. */
      distinctOutputRatio: z.number(),
      /** How many `lease.changed` broadcasts the console's own per-member acquire/release traffic produced in the trailing 60s (H4) — an acquire and its later release each count once, mirroring the two real broadcasts `onManualRevoked`/`lease.acquire` emit in production for the same hold. Only the console's own short-lived `purpose: 'command'` holds are counted; a manual lease already held by the operator before the run contributes nothing, since `admitMember`'s first branch acquires nothing. */
      leaseChangedPerMinute: z.number(),
    })
    .optional(),
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
