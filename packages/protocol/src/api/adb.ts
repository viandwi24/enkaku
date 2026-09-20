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
       * `WALL_RAMP_CONCURRENCY` — how many tiles may newly ask for a stream
       * at the same time while the Screens grid fills in.
       *
       * It was a constant nothing ever sent: `daemon.ts` imported it and
       * never read it, so `ScreensGrid` fell back to a hard-coded 2 and the
       * `ENKAKU_WALL_RAMP_CONCURRENCY` override could not move it. A knob
       * that cannot be turned is worse than no knob, because an operator
       * sets it and believes the farm changed.
       */
      rampConcurrency: z.number().int(),
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

/**
 * One adb command an operator saved by name, farm-wide
 * (`GET /api/adb/shortcuts`).
 *
 * `cmd` is always the NORMALISED command (`normalizeAdbCommand`) — the bare
 * shell line, never `adb shell …` as it was typed — so the same command
 * saved from two different forms is one shortcut, and a surface that runs one
 * sends exactly what the core will run.
 */
export const AdbShortcutSchema = z.object({
  id: z.string(),
  name: z.string(),
  cmd: z.string(),
  /** Ascending; the order every surface draws. */
  position: z.number().int(),
  createdAt: z.number().int(),
})
export type AdbShortcut = z.infer<typeof AdbShortcutSchema>

/** `GET /api/adb/shortcuts` — the whole list, in `position` order. */
export const AdbShortcutsResponseSchema = z.object({ shortcuts: z.array(AdbShortcutSchema) })

/** `POST /api/adb/shortcuts`, `PATCH /api/adb/shortcuts/:id`. */
export const AdbShortcutResponseSchema = z.object({ shortcut: AdbShortcutSchema })

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

/* ------------------------------------------------------------------------ *
 * The raw adb surface (`GET/POST /api/adb/...`, owner 2026-09-20).
 *
 * Everything above this line describes the FARM's view of adb: pool stats,
 * health, saved commands, a lent endpoint. What follows describes ADB's OWN
 * view — `adb devices -l` and the host services beside it — for serials the
 * farm has never admitted and may never admit.
 *
 * The distinction matters because the two lists genuinely disagree, and that
 * disagreement is the whole reason this surface exists: a phone plugged in
 * and `unauthorized` is invisible on the Devices page (it has no row yet),
 * a phone whose adb-tcp link dropped is `offline` here but still a device
 * row there, and a serial the operator blocked is in both with opposite
 * meanings. A raw row therefore carries `farm`, which says which of those
 * it is, rather than leaving the reader to guess from the serial.
 * ------------------------------------------------------------------------ */

/**
 * How the farm sees a serial adb is reporting.
 *
 * - `enrolled`: a `devices` row exists — `deviceId`/`name`/`number` are set.
 * - `discovered`: probed and waiting in the discovery tray, not admitted.
 * - `blocked`: explicitly refused by an operator; the reconciler will not
 *   admit it however often adb re-offers it.
 * - `unknown`: adb has it and the farm has never seen it. Normal for a
 *   phone still `unauthorized` (no `stableId` can be read until the RSA
 *   prompt is accepted, so it cannot be probed, let alone admitted).
 */
export const AdbRawFarmKindSchema = z.enum(['enrolled', 'discovered', 'blocked', 'unknown'])
export type AdbRawFarmKind = z.infer<typeof AdbRawFarmKindSchema>

/** One line of `adb devices -l`, plus what the farm knows about it. */
export const AdbRawDeviceSchema = z.object({
  /** adb's transport address, not an identity — see CLAUDE.md on `stableId`. */
  serial: z.string(),
  /**
   * adb's own word: `device`, `offline`, `unauthorized`, `authorizing`,
   * `bootloader`, `recovery`, `sideload`, `rescue`, `connecting`… A plain
   * string, not an enum: adb adds states, and a farm that refuses to render
   * one it has not heard of is worse than one that prints the word.
   */
  state: z.string(),
  /** The `usb:` path (e.g. `3-1.4.3`); null for a TCP transport. */
  usb: z.string().nullable(),
  transportId: z.number().int().nullable(),
  product: z.string().nullable(),
  model: z.string().nullable(),
  /** adb's `device:` field — the board name, never a device row's id. */
  deviceCode: z.string().nullable(),
  /** Parsed out of `serial` when it is a `host:port` TCP transport, else null. */
  endpoint: z.object({ host: z.string(), port: z.number().int() }).nullable(),
  farm: z.object({
    kind: AdbRawFarmKindSchema,
    deviceId: z.string().nullable(),
    name: z.string().nullable(),
    /** The durable `#` on the phone's own label (`device_numbers.number`). */
    number: z.number().int().nullable(),
    /** The farm's `DeviceInfo.status`, which is NOT adb's `state` above. */
    status: z.string().nullable(),
  }),
  /** Queued adb work for this serial right now (`AdbClient.pending`). */
  pending: z.number().int(),
})
export type AdbRawDevice = z.infer<typeof AdbRawDeviceSchema>

/** One active forward, as `host:list-forward` reports it. */
export const AdbRawForwardSchema = z.object({ serial: z.string(), local: z.string(), remote: z.string() })
export type AdbRawForward = z.infer<typeof AdbRawForwardSchema>

/** `GET /api/adb/devices`. */
export const AdbRawListResponseSchema = z.object({
  /** `host:version`, or null when the server did not answer in time. */
  serverVersion: z.string().nullable(),
  devices: z.array(AdbRawDeviceSchema),
  forwards: z.array(AdbRawForwardSchema),
  /**
   * Whether this caller may run `POST /api/adb/shell`. The route is
   * authoritative; this only lets the page hide a box it would be refused
   * on, exactly as `shell.mode` already does for the device terminal.
   */
  shellAllowed: z.boolean(),
})

/**
 * What every mutating route here answers: adb's own reply text, verbatim.
 *
 * `ok` is NOT read off that text. `host:connect` answers 200 OKAY with a
 * body reading `failed to connect to 10.0.0.4:5555` — the request was
 * accepted, the connection was not — so the route decides `ok` from the
 * wording adb uses for its own failures and hands the sentence through
 * either way. A surface renders `message`; it never re-parses it.
 */
export const AdbRawResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
})
export type AdbRawResult = z.infer<typeof AdbRawResultSchema>

/** `POST /api/adb/connect`. */
export const AdbConnectRequestSchema = z.object({
  host: z.string().min(1),
  /** adb's own default when the operator leaves it blank. */
  port: z.number().int().min(1).max(65535).default(5555),
})

/** `POST /api/adb/disconnect`. An absent `target` disconnects every TCP transport, exactly as bare `adb disconnect` does. */
export const AdbDisconnectRequestSchema = z.object({ target: z.string().min(1).optional() })

/**
 * `POST /api/adb/tcpip` — `adb -s <serial> tcpip <port>`, the first half of
 * a USB→Wi-Fi cutover. `verify` reads `service.adb.tcp.port` back afterwards
 * (spec's "verify by read-back" rule), which is the only thing that
 * distinguishes an accepted request from a working listener.
 */
export const AdbTcpipRequestSchema = z.object({
  serial: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5555),
  verify: z.boolean().default(true),
})

/** `POST /api/adb/tcpip`. */
export const AdbTcpipResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /**
   * `service.adb.tcp.port` as the phone reports it after the switch, or
   * null when `verify` was off or the read-back itself failed. A number
   * that differs from the requested port is a real answer, not an error —
   * it means adbd kept a listener it already had.
   */
  listeningPort: z.number().int().nullable(),
  /** The address to `connect` to, when the device has one adb can see. */
  suggestedEndpoint: z.string().nullable(),
})

/** `POST /api/adb/probe` — a plain TCP dial, no adb involved. */
export const AdbProbeRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5555),
})

/** `POST /api/adb/probe`. `open: false` with no `error` never happens — one of the two always says why. */
export const AdbProbeResponseSchema = z.object({
  open: z.boolean(),
  rttMs: z.number().int().nullable(),
  error: z.string().nullable(),
})

/** `POST /api/adb/shell` — one command on one serial, no device row required. */
export const AdbRawShellRequestSchema = z.object({
  serial: z.string().min(1),
  /** The bare shell line. `adb shell ` and a leading `adb ` are stripped by the route, the way a saved shortcut already is. */
  command: z.string().min(1),
})

/** `POST /api/adb/shell`. */
export const AdbRawShellResponseSchema = z.object({
  /** adbd's exit status. `null` when the shell protocol did not carry one (a very old adbd). */
  code: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int(),
})

/** `POST /api/adb/forwards`. */
export const AdbForwardCreateRequestSchema = z.object({
  serial: z.string().min(1),
  /** adb's own spec strings, e.g. `tcp:9000`. */
  local: z.string().min(1),
  remote: z.string().min(1),
})

/** `DELETE /api/adb/forwards`. */
export const AdbForwardKillRequestSchema = z.object({ serial: z.string().min(1), local: z.string().min(1) })
