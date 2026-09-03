import { z } from 'zod'
import { AgentStateSchema, ConnectionMediumSchema, DeviceConnectionSchema, DeviceInfoSchema } from '../device'
import { DeviceEventSchema } from '../messages/device-event'
import { DeviceReadinessSchema } from '../readiness'
import { NetworkEngineIdSchema, RouteCheckSchema, tagUntaggedRouteConfig } from '../network'
import { ViewerSchema } from '../messages/presence'
import { KeepAwakeModeSchema, RotationModeSchema, TextInputModeSchema, type DeviceSettings } from '../settings'
import { pageSchema } from './pagination'

/**
 * What `PATCH /api/devices/:id` did to the device's LIVE screen when the
 * patch changed `settings.prep.rotation` (plan 85 §3.7).
 *
 * This exists because the setting used to be apply-once at session creation:
 * an operator watching a wall tile could switch to "Lock portrait", get a
 * success toast, and see nothing move, because the toast was reporting a
 * successful DATABASE WRITE and nothing else. The four states are the four
 * genuinely different things that can now happen, and the UI must word them
 * differently:
 *
 * - `applied`    — the session that is streaming right now re-locked, and the
 *                  device confirmed both settings on read-back.
 * - `no-session` — nothing is streaming, so there was nothing to change live.
 *                  The stored setting still applies to the next session. Not
 *                  a failure.
 * - `busy`       — a job is running on this device. Video keeps running while
 *                  a device is busy (spec §10.1) and a settings save must not
 *                  be the thing that rotates a screen out from under a
 *                  running script, so the change waits for the next session —
 *                  the same rule `PATCH`'s video reprofile already follows.
 * - `failed`     — it was attempted on a live session and the device did not
 *                  end up in the requested orientation. `reason` says what
 *                  read back instead.
 */
export const RotationApplyResultSchema = z.object({
  mode: RotationModeSchema,
  state: z.enum(['applied', 'no-session', 'busy', 'failed']),
  /** Present for `failed` (what the device reported back) and `busy` (why it waited). */
  reason: z.string().optional(),
})
export type RotationApplyResult = z.infer<typeof RotationApplyResultSchema>

/**
 * `GET /api/devices/:id`, `POST /api/devices/discovered/:stableId/admit`,
 * `PATCH /api/devices/:id`.
 *
 * `rotation` is present ONLY on a `PATCH` that actually changed
 * `settings.prep.rotation`, and is the honest answer to "did the screen I am
 * looking at just re-lock?". It must stay declared here: a Zod object strips
 * an undeclared key silently, and this response has exactly the shape of the
 * bug that has bitten this repo three times — the core would emit the field,
 * the parse would drop it, and the UI would go back to reporting a database
 * write as though it were a device change.
 */
export const DeviceResponseSchema = z.object({
  device: DeviceInfoSchema,
  rotation: RotationApplyResultSchema.optional(),
})

/**
 * `GET /api/devices/:id`, as consumed by the device page — the same route as
 * `DeviceResponseSchema` above, but with the four engine-name fields plus
 * `nodeId` the screen card also reads (`DeviceDetailInfo` in
 * `packages/studio/src/components/device/DeviceHeader.tsx`).
 */
export const DeviceDetailSchema = DeviceInfoSchema.extend({
  transport: z.string(),
  display: z.string(),
  /**
   * Plan 100 §4.3, step 100.6 (closes G11/96.22) — the engine ACTUALLY
   * running, sourced live from the open session; `null` when no session is
   * open. Allowed to disagree with `display` above (the CONFIGURED engine):
   * a device on the screencap-loop fallback reports `display: 'scrcpy'`
   * (nothing rewrote the stored setting) while `liveDisplay:
   * 'screencap-loop'` says what is actually being served.
   */
  liveDisplay: z.string().nullable(),
  input: z.string(),
  inspection: z.string(),
  settings: z.unknown(),
  nodeId: z.string().nullable(),
})
export const DeviceDetailResponseSchema = z.object({ device: DeviceDetailSchema })

/** `GET /api/devices/blocked`. */
export const BlockedDeviceSchema = z.object({
  stableId: z.string(),
  label: z.string().nullable(),
  reason: z.string().nullable(),
  blockedAt: z.number(),
  blockedBy: z.string().nullable(),
})
export const DevicesBlockedResponseSchema = z.object({ blocked: z.array(BlockedDeviceSchema) })

/**
 * One resolved device reference — `GET /api/devices/refs?ids=a,b,c` (plan 47
 * §4.5, plan 124 §3.7).
 *
 * A job, batch, schedule or recording keeps a plain `deviceId` long after the
 * device it points at was forgotten (plan 47 §3.4), so any UI rendering one
 * needs something a human can read rather than a bare uuid. `deleted: true`
 * means the row came from `deleted_devices` — the device is gone, but the
 * reference is still legitimate and must still be nameable.
 *
 * `number` (plan 124 §3.7) is the device's reservation from `device_numbers`,
 * or `null` for a device that never had one (or whose number was explicitly
 * released — plan 89 §3.2's "a missing number is a real state, not an
 * error"). It rides here rather than being pre-composed into `label` for the
 * reason plan 124 §3.1 states as the whole rule of that plan: the number
 * COMPOSES with the label at render time and never enters it — nothing
 * writes `#7` into `devices.label`, and nothing parses it back out. Studio's
 * `deviceRefLabel` (`packages/studio/src/lib/api.ts`) calls itself "the one
 * place this formatting rule lives"; it could not obey the rule while the
 * only wire shape it reads carried no number at all.
 *
 * A DELETED device keeps its number here too, deliberately: `device_numbers`
 * is keyed on `stableId` and `forget()` leaves the reservation in place
 * (plan 89 §3.2's sticky guarantee), so `#7 Old Phone` stays `#7 Old Phone`
 * in a job's history rather than losing half its identity the moment the
 * device leaves the farm.
 */
export const DeviceRefSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  stableId: z.string(),
  deleted: z.boolean(),
  number: z.number().int().nullable(),
})
export type DeviceRef = z.infer<typeof DeviceRefSchema>

/** `GET /api/devices/refs?ids=…` — a MAP keyed by the requested id, not an array: an id neither table knows is simply absent (never a null entry, and never an error — a caller resolving twenty references should not lose nineteen to one dangling one). */
export const DeviceRefsResponseSchema = z.object({ refs: z.record(z.string(), DeviceRefSchema) })

/** `GET /api/devices/:id/viewers`. */
export const DeviceViewersResponseSchema = z.object({ viewers: z.array(ViewerSchema) })

/**
 * `POST /api/devices/rescan` (plan 85 §3.3, §4.4, §4.6) — the manual escape
 * hatch for the discovery reconciler (`packages/core/src/registry/reconcile.ts`),
 * whose `DeviceReconciler.runOnce()` returns this exact shape. Declared once
 * here rather than as a separate hand-rolled interface in `reconcile.ts`
 * (00-overview §4.4, plan 72 §3.2) — `reconcile.ts` imports the type from
 * this package instead of redefining it.
 */
export const ReconcileReportSchema = z.object({
  /** How many devices `host:devices-l` reported this pass, in any state. */
  seen: z.number(),
  /** In adb (state `device`) but unknown to the registry → adopted this pass. */
  adopted: z.array(z.string()),
  /** Known to the registry but gone from adb entirely → dropped this pass (the safety net; the live tracker usually gets there first). */
  dropped: z.array(z.string()),
  /** Stuck `offline` longer than `discovery.offlineGraceSec`. */
  offline: z.array(z.string()),
  /** Currently `unauthorized`. */
  unauthorized: z.array(z.string()),
  /** Whether `host:reconnect-offline` was actually issued this pass. */
  reconnectIssued: z.boolean(),
  /** Devices currently mid-backoff on a failed probe (plan 85 §3.3 point 7). */
  retriesPending: z.number(),
})
export type ReconcileReport = z.infer<typeof ReconcileReportSchema>

/**
 * `POST /api/devices/scan` (plan 88 §3.5, §4.5, §4.6, §5 step 88.3) — the
 * bounded subnet sweep's own report.
 * `packages/core/src/registry/sweep.ts`'s `Sweeper.sweep()` returns this
 * exact shape; declared once here rather than as a separate hand-rolled
 * interface there, the same convention `ReconcileReportSchema` above already
 * established for `POST /api/devices/rescan` (00-overview §4.4, plan 72
 * §3.2) — `sweep.ts` imports the type from this package instead of
 * redefining it.
 */
export const SweepReportSchema = z.object({
  /**
   * Every network the sweep actually looked at, how big each one is
   * (`addressCount()` — the full range, including the network/broadcast
   * address), and the port actually probed on it — `net.port` when the
   * range overrides the farm default, otherwise `discovery.tcpPort` itself
   * (plan 88 §9 Q7, resolved). Surfaced so an operator debugging "why didn't
   * it find my device" can see which port was actually used per range,
   * rather than having to cross-reference Settings.
   */
  networks: z.array(z.object({ cidr: z.string(), label: z.string(), addresses: z.number(), port: z.number() })),
  /** Addresses actually pre-probed — already net of `skipped`. */
  scanned: z.number(),
  /** Addresses adb already listed (any state) before the sweep started — never re-probed. */
  skipped: z.number(),
  /** Accepted the cheap TCP pre-probe. */
  answered: z.number(),
  /** `host:connect` succeeded — only ever attempted for an address that answered. */
  connected: z.number(),
  /** Resolved to a `stableId` via the ordinary identity probe. */
  identified: z.number(),
  /** stableIds already admitted (a `devices` row existed) that this sweep reconnected. */
  adopted: z.array(z.string()),
  /** stableIds new to the registry — landed in the Discovered tray (plan 56), never in `devices`. */
  discovered: z.array(z.string()),
  /** An address the address book remembers for ONE stableId answered as a DIFFERENT one — disconnected immediately, never adopted. */
  conflicts: z.array(z.object({ address: z.string(), expected: z.string(), found: z.string() })),
  durationMs: z.number(),
})
export type SweepReport = z.infer<typeof SweepReportSchema>

/**
 * One rung of the reconnect ladder (plan 88 §3.3, §4.4) —
 * `packages/core/src/registry/reconnect.ts`'s own `AttemptTrace`, declared
 * once here (the same convention `ReconcileReportSchema`/`SweepReportSchema`
 * above already established) so that file imports the type rather than
 * redefining it, and `POST /api/devices/:id/connection/reconnect` (§4.6, §5
 * step 88.4) has something for Studio to parse a `not-found` trace against.
 */
export const AttemptTraceSchema = z.object({
  address: z.string(),
  preProbe: z.enum(['accepted', 'refused', 'timeout']),
  connect: z.enum(['ok', 'failed']).optional(),
  probe: z.enum(['match', 'conflict', 'failed']).optional(),
  conflictStableId: z.string().optional(),
  ms: z.number(),
})
export type AttemptTrace = z.infer<typeof AttemptTraceSchema>

/**
 * `POST /api/devices/:id/connection/reconnect` (plan 88 §3.3, §3.8, §4.4,
 * §4.6, §5 step 88.4) — `DeviceReconnector.reconnect()`'s own return shape,
 * same "declared once, imported, never redefined" convention as
 * `AttemptTraceSchema` above.
 */
export const ReconnectOutcomeSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('already-connected'), serial: z.string() }),
  z.object({ result: z.literal('connected'), address: z.string(), viaSweep: z.boolean() }),
  z.object({ result: z.literal('not-found'), tried: z.array(AttemptTraceSchema), sweep: SweepReportSchema.nullable() }),
  z.object({ result: z.literal('refused'), reason: z.enum(['usb-device', 'no-endpoints', 'scan-unavailable']), detail: z.string() }),
])
export type ReconnectOutcome = z.infer<typeof ReconnectOutcomeSchema>

/**
 * `POST /api/devices/:id/connection/disconnect` (plan 88 §3.7, §3.8, §4.6, §5
 * step 88.4) — `DeviceReconnector.disconnect()`'s own return shape. The USB
 * refusal (`E_TRANSPORT_NOT_DETACHABLE`) and the running-job refusal never
 * reach this schema — both are refused BEFORE the ladder ever runs, as coded
 * HTTP errors (§4.6) — so `result: 'refused'` here means only "the ladder
 * tried and adb itself refused", e.g. a transient `host:disconnect` failure.
 */
export const DisconnectOutcomeSchema = z.object({
  result: z.enum(['disconnected', 'not-connected', 'refused']),
  detail: z.string().optional(),
})
export type DisconnectOutcome = z.infer<typeof DisconnectOutcomeSchema>

/** `PATCH /api/devices/:id/connection` (plan 88 §3.1, §4.6, §5 step 88.4) — the declared-medium correction, for a device whose cutover happened outside Enkaku. */
export const DeviceConnectionPatchResponseSchema = z.object({ connection: DeviceConnectionSchema })

/**
 * The USB → network cutover wizard's own server-side state (plan 88 §3.4,
 * §4.6, §5 step 88.5) — `packages/core/src/registry/cutover.ts`'s
 * `CutoverManager`, in-memory and keyed by `stableId`, broadcast over
 * `device.cutover` (`../messages/cutover.ts`) so a second browser tab sees
 * the same progress (no `/ws` snapshot replay, so `GET .../connection/cutover`
 * would be the alternative if one were ever needed — not built, since the
 * wizard is only ever open in one place at a time by design).
 */
export const CutoverStepSchema = z.enum(['enabling-tcp', 'armed', 'connecting', 'done', 'failed'])
export type CutoverStep = z.infer<typeof CutoverStepSchema>

export const CutoverStateSchema = z.object({
  deviceId: z.string(),
  stableId: z.string(),
  step: CutoverStepSchema,
  /** One line, plain language: "swept 10.20.0.0/24 · 21 answered · none matched yet", or the failure's named cause. */
  detail: z.string(),
  port: z.number().int(),
  medium: ConnectionMediumSchema,
  /**
   * H3 (plan 88 §0.2) — whether `persist.adb.tcp.port` read back as the port
   * just set, i.e. whether this phone will still be listening after a
   * reboot with no re-arm. `null` until the enable step's read-back runs.
   */
  persistSurvivesReboot: z.boolean().nullable(),
  /** Addresses the armed window's ladder+sweep polling has tried so far. */
  triedAddresses: z.number().int(),
  /** How many of those answered the cheap pre-probe. */
  answered: z.number().int(),
  /**
   * Epoch MILLISECONDS, deliberately NOT the repo-wide unix-SECONDS DB
   * convention (`docs/plans/00-overview.md` §4) — this is ephemeral,
   * in-memory, never a DB column, and Studio's own countdown needs
   * sub-second precision against `Date.now()`.
   */
  startedAt: z.number(),
  /** Same epoch-milliseconds units as `startedAt`. Set once armed; `null` before arming and once a terminal step (`done`/`failed`) is reached. */
  expiresAt: z.number().nullable(),
  /** Set on `step: 'done'` — the `host:port` the phone was found at. */
  connectedAddress: z.string().nullable(),
})
export type CutoverState = z.infer<typeof CutoverStateSchema>

/** `POST /api/devices/:id/connection/cutover` (plan 88 §3.4, §4.6, §5 step 88.5). `address` is the manual override the Check screen falls back to when no scannable network is configured. */
export const CutoverStartBodySchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  medium: ConnectionMediumSchema,
  address: z.string().min(1).optional(),
})

/** `POST`/`DELETE /api/devices/:id/connection/cutover` share this response envelope. */
export const CutoverResponseSchema = z.object({ cutover: CutoverStateSchema })

/** `GET/PUT /api/devices/:id/readiness`. */
export const DeviceReadinessResponseSchema = z.object({ readiness: DeviceReadinessSchema })

/** `GET /api/devices/:id/history-counts`. */
export const HistoryCountsSchema = z.object({
  jobs: z.number(),
  artifacts: z.number(),
  events: z.number(),
})
export const DeviceHistoryCountsResponseSchema = z.object({ counts: HistoryCountsSchema })

/** `PUT /api/devices/:id/tags`. */
export const DeviceTagsResponseSchema = z.object({ tags: z.array(z.string()) })

/**
 * `GET /api/devices/:id/events` — the keyset envelope, plus legacy
 * `events`/`nextBefore` keys the route still sends alongside it (kept "for
 * one release" per plan 30 §3.3; out of scope for this plan to remove).
 * Extra keys are simply not part of this schema — Zod ignores them.
 */
export const DeviceEventsResponseSchema = pageSchema(DeviceEventSchema).extend({
  /** Older/narrower reads (`CrashesPanel.tsx`) claim only `items`, ignoring `nextCursor`/`total` — a valid subset. */
})

/** `POST /api/clusters/:id/devices` — moving devices into (or out of) a cluster. */
export const ClusterMoveResponseSchema = z.object({
  moved: z.array(z.object({ deviceId: z.string(), from: z.string().nullable() })),
})

// ---- Network route + guest agent (`packages/core/src/api/guest-agent.ts`) ----
// Deliberately NOT the same shape as `NetworkStatusSchema` in `../network`
// (that one is the tunnel/wire shape used between core and node) — the HTTP
// route's `NetworkStatusResult` names its declared config `config`, not
// `declared`, and adds `sessionId`/`failClosed`/`exitHistory`.

/**
 * The VPN arm of `DeviceNetworkConfigSchema` — today's whole shape, now one
 * member of plan 114 §4.1's union.
 *
 * Deliberately NARROWER than `Socks5RouteConfigSchema` in `../network` and it
 * must stay that way: this is a RESPONSE shape, and `username`/`password` are
 * absent from it because the API never returns them (plan 44 §4.5, acceptance
 * criterion 8). Replacing it wholesale with the protocol's own config union
 * would have widened it to permit the two secret fields again and thrown that
 * documentation away, so the union is rebuilt here from response-shaped
 * members instead.
 *
 * `engine` carries `.default('vpn-helper')` for the same reason it does on
 * `Socks5RouteConfigSchema`: a core that predates plan 114 sends this object
 * with no tag at all.
 */
export const DeviceVpnNetworkConfigSchema = z.object({
  engine: z.literal('vpn-helper').default('vpn-helper'),
  host: z.string(),
  port: z.number(),
  credentialRef: z.string().optional(),
  /**
   * The USERNAME half of the credential `credentialRef` names — resolved from
   * `network_credentials` by the core, never stored on the route itself.
   *
   * This is not a relaxation of the paragraph above: the narrowing that must
   * stay is about the **password**, and this field is deliberately named for
   * where it comes from so it can never be mistaken for the `username` a `PUT`
   * body carries (that one is a write field, half of a credential being
   * *replaced*). A username is not a secret — it is the session string an
   * operator reads to tell which upstream identity a phone is on, e.g. a SOAX
   * `package-…-sessionid-…` — and withholding it made the panel's own
   * `credentialRef` an opaque name for an upstream nobody could identify.
   *
   * Absent when the route has no stored credential, or when the referenced
   * credential was saved with no username of its own.
   */
  credentialUsername: z.string().optional(),
  udpMode: z.enum(['udp', 'tcp']),
  expect: z
    .object({
      country: z.string(),
      region: z.string().optional(),
      city: z.string().optional(),
      asn: z.number().optional(),
      isp: z.string().optional(),
    })
    .optional(),
  onGeoFail: z.enum(['report', 'hold']),
})

/**
 * Rung 1's response shape (plan 114 §3.2). No credential fields exist on it
 * because none exist on the engine — Android's system proxy value has nowhere
 * to put one and is world-readable besides (§3.8).
 */
export const DeviceHttpProxyNetworkConfigSchema = z.object({
  engine: z.literal('adb-proxy'),
  host: z.string(),
  port: z.number(),
  exclusions: z.array(z.string()).optional(),
})

/**
 * Rung 2's response shape (plan 114 §3.2, §4.3). `hostPort` is the operator's
 * — where the proxy listens on this farm's machine. `devicePort` is the
 * farm's: the loopback port allocated on the phone by the reverse registry,
 * reported back so an operator can read `127.0.0.1:<devicePort>` off the
 * device and recognise it, and absent until a reverse has actually been
 * established.
 */
export const DeviceReverseProxyNetworkConfigSchema = z.object({
  engine: z.literal('adb-reverse-proxy'),
  hostPort: z.number(),
  /**
   * `.nullable()` as well as `.optional()`, corrected in step 114.8: the core
   * emits this field UNCONDITIONALLY and emits `null` for it until a reverse has
   * actually been established (`NetworkRouteConfigResponse` in
   * `packages/core/src/network/route-service.ts`, whose own arm is typed
   * `devicePort: number | null`). Declared as `z.number().optional()` alone,
   * every `GET /:id/network` for a rung-2 route whose port had not been
   * allocated yet failed Studio's parse outright — the exact window plan 114
   * acceptance criterion 10 says must be *reported*, not made unreadable.
   */
  devicePort: z.number().nullable().optional(),
  exclusions: z.array(z.string()).optional(),
})

/** Plan 114 §4.1 — discriminated on `engine`; see `NetworkRouteConfigSchema`'s own comment for why the discrimination cannot mis-parse the way an ordered `z.union` can. */
export const DeviceNetworkConfigSchema = z.discriminatedUnion('engine', [
  DeviceHttpProxyNetworkConfigSchema,
  DeviceReverseProxyNetworkConfigSchema,
  DeviceVpnNetworkConfigSchema,
])
export type DeviceHttpProxyNetworkConfig = z.infer<typeof DeviceHttpProxyNetworkConfigSchema>
export type DeviceReverseProxyNetworkConfig = z.infer<typeof DeviceReverseProxyNetworkConfigSchema>
export type DeviceVpnNetworkConfig = z.infer<typeof DeviceVpnNetworkConfigSchema>
export type DeviceNetworkConfig = z.infer<typeof DeviceNetworkConfigSchema>

/**
 * The same union behind plan 114 §4.1's read-time migration, reusing
 * `tagUntaggedRouteConfig` from `../network` rather than repeating it — a
 * `/network` response from a core that predates plan 114 carries no `engine`
 * key, and an untagged object matches no arm of a discriminated union.
 */
export const StoredDeviceNetworkConfigSchema = z.preprocess(tagUntaggedRouteConfig, DeviceNetworkConfigSchema)

export const DeviceNetworkObservedSchema = z.object({
  up: z.boolean(),
  state: z.enum(['up', 'held', 'down']).optional(),
  upstream: z.string().optional(),
  stats: z.array(z.number()).optional(),
})

export const DeviceGeoObservationSchema = z.object({
  address: z.string(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  asn: z.number().nullable(),
  isp: z.string().nullable(),
  at: z.number(),
})

/**
 * `NetworkStatusResult.recovery` (plan 90 §3.7 rule 5, fixes F20) —
 * `packages/core/src/api/guest-agent.ts`'s own `NetworkRecoveryStatus`,
 * declared once here (the same "declared once, imported, never redefined"
 * convention `ReconcileReportSchema`/`SweepReportSchema` above already
 * established) so bounded automatic route recovery is legible on the wire
 * instead of only as the static "not routed" sentence the route form showed
 * before this: an attempt count, a bound, a countdown, and how close the
 * device is to tripping the `maxRecoveryCyclesPerHour` breaker.
 */
export const NetworkRecoveryStatusSchema = z.object({
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: z.number().int().nullable(),
  exhausted: z.boolean(),
  reconnectCycles: z.number().int(),
})
export type NetworkRecoveryStatus = z.infer<typeof NetworkRecoveryStatusSchema>

/** `GET/POST /api/devices/:id/network(/enable|/disable|/retry)` — bare, no wrapper. */
export const DeviceNetworkStatusResponseSchema = z.object({
  engine: NetworkEngineIdSchema,
  /**
   * The full union as of step 114.6 (plan 114 §4.1), no longer the VPN arm
   * alone — Studio's `NetworkRouteForm` now switches on `config.engine`
   * instead of reading `config.host`/`config.udpMode` unconditionally, and
   * its hand-written `NetworkConfig` reflection is gone in favour of the types
   * exported above.
   *
   * `Stored…` rather than the bare union on purpose: this is a RESPONSE, and
   * a core that predates plan 114 answers with no `engine` key at all.
   * `tagUntaggedRouteConfig` is what makes such an answer parse — an untagged
   * config is a `vpn-helper` config by construction, because `vpn-helper` was
   * the only engine that could have written one. (A `PUT` BODY still parses
   * through the bare union in the core, where an untagged request from a
   * post-114 client is a client bug rather than a value to guess at.)
   *
   * `.nullable()` on the outside of the preprocess, not inside it: a device
   * with no route answers `config: null`, and `ZodNullable` short-circuits on
   * `null` before the union ever sees it.
   */
  config: StoredDeviceNetworkConfigSchema.nullable(),
  enabled: z.boolean(),
  observed: DeviceNetworkObservedSchema.nullable(),
  drift: z.boolean(),
  sessionId: z.string().nullable(),
  failClosed: z.boolean(),
  health: z.enum(['ok', 'unverified', 'degraded', 'unknown']),
  checks: z.array(RouteCheckSchema),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  exitHistory: z.array(DeviceGeoObservationSchema),
  /**
   * Null when no automatic recovery has ever been needed for this device's
   * current route (plan 90 §3.7 rule 5) — the same "empty until something
   * happened" reading `exitHistory` gives an unconfigured geo provider.
   */
  recovery: NetworkRecoveryStatusSchema.nullable(),
  /**
   * Whether this farm holds the device's own pre-farm proxy settings (plan 114
   * §3.6 rule 4, criterion 6).
   *
   * Only the timestamp crosses the wire. The screen needs to know whether
   * turning the route off will **restore** what was there before or merely
   * **clear** the keys — two different outcomes it is required to word
   * differently — and it does not need the values to say which.
   *
   * Declared late, and the reason is worth keeping: the core has emitted this
   * since step 114.3, but the response schema did not declare it, and a plain
   * `z.object` **strips an undeclared key silently** — no error, no warning.
   * So the field arrived on the wire and vanished at the parse, and the panel
   * hedged in prose about both cases at once instead of telling the operator
   * which one this phone is in. Three separate workers reported it before it
   * was closed; a silent strip is not a loud failure, which is exactly what
   * made it survive that long.
   */
  captured: z.object({ at: z.number().int() }).nullable().optional(),
  /**
   * Who set this route (plan 114 §3.3, step 114.9) — a person, or a plugin.
   *
   * Three answers, and the third is the one this field is really for:
   *
   * - `{ kind: 'user', id }` — an operator, through the device panel or the API.
   * - `{ kind: 'plugin', id }` — a plugin, through `device.network.set` and the
   *   capability broker. `id` is the plugin's own name, already unprefixed, so
   *   the panel renders it without knowing about `plugin:<name>` principals.
   * - `null` — **nobody.** Either the route predates plan 114, or the farm
   *   applied it itself: a reconnect re-apply is not somebody setting a route,
   *   and stamping an actor on it would make the panel claim an operator
   *   touched a device they never opened. A device showing a proxy nobody
   *   remembers setting is exactly the confusion this exists to prevent, so
   *   "the farm put this back" has to be sayable.
   *
   * `.default(null)` rather than a bare `.nullable()`: a core that predates
   * step 114.9 answers with no such key at all, and Studio parses this schema
   * strictly. An absent field reads as "nobody claimed it", which is the honest
   * reading of an older core's silence.
   */
  setBy: z
    .object({ kind: z.enum(['user', 'plugin']), id: z.string(), at: z.number().int() })
    .nullable()
    .default(null),
  /**
   * **A teardown this farm owes this device and has not been able to deliver**
   * — `PersistedNetworkRoute.pendingClear` on the wire.
   *
   * Non-null means the record says off and the PHONE has not been told: it may
   * still be carrying a system proxy, or a fail-closed TUN, that nothing in
   * this farm currently wants. It is cleared automatically the next time the
   * device is admitted, and until then this is the only field that says so.
   * Every other field describes what the farm decided; this one describes what
   * the device is still doing about it.
   *
   * `.default(null)` for the same reason `setBy` has one: a core that predates
   * this field answers with no such key, and "nothing is owed" is the honest
   * reading of that silence.
   *
   * **This is also the whole answer a disarm gives for a phone that was not
   * there to hear it.** `DELETE /:id/network` and `POST /:id/network/disable`
   * accept an offline device (the enable direction still does not), and they
   * answer with the ordinary status object — `enabled: false` and this field
   * non-null. There is no separate "accepted but not delivered" envelope,
   * deliberately: a debt recorded by the door and a debt recorded by a live
   * revert that could not reach the phone are the same fact, and one shape
   * means a client cannot handle one and miss the other.
   */
  pendingClear: z
    .object({
      engine: NetworkEngineIdSchema,
      devicePort: z.number().int().min(1).max(65535).optional(),
      /**
       * The row is being kept ONLY until the phone can be told (`DELETE`), and
       * is erased when the debt settles — as opposed to a `/disable`, whose
       * config is kept on purpose so it can be switched back on.
       *
       * `.default(false)` because a core that predates this key still answers
       * without it, and "the config is being kept" is the safer reading of that
       * silence: it never invites a client to render a route as already gone.
       */
      forget: z.boolean().default(false),
      reason: z.string(),
      since: z.number().int(),
    })
    .nullable()
    .default(null),
})
export type DeviceNetworkStatusResponse = z.infer<typeof DeviceNetworkStatusResponseSchema>

/**
 * `POST /api/devices/network/apply` (plan 114 §3.9, step 114.8) — one route
 * across a selection, synchronously.
 *
 * `route` is deliberately **unparsed here**, and that is the single most
 * load-bearing decision in this envelope. A Zod object strips unknown keys, so
 * declaring `route: DeviceNetworkConfigSchema` would silently drop a `username`
 * or `password` before `assertNoHttpProxyAuth` (`packages/core/src/network/
 * route-service.ts`) ever saw it — and the operator would be told their
 * authenticated proxy had been applied to forty phones when what was actually
 * written was an anonymous one. The core validates the same body twice, on
 * purpose: once up front for the WHOLE request (a malformed route or a
 * credential is a bad request, not forty identical per-device failures), and
 * again inside the one door per device, because the door is the door.
 *
 * `z.record(z.string(), z.unknown())` rather than `z.unknown()`: it still
 * refuses a string, an array or a null — "route must be an object" is a real
 * check — while passing every key through untouched.
 */
export const DeviceNetworkApplyBodySchema = z.object({
  deviceIds: z.array(z.string()).min(1),
  route: z.record(z.string(), z.unknown()),
})
export type DeviceNetworkApplyBody = z.infer<typeof DeviceNetworkApplyBodySchema>

/**
 * One device's outcome. `DeviceLabelsApplyResultSchema`'s three-way split
 * (F19), plus a fourth thing that split did not need: a `skip`.
 *
 * - **applied** — `status` present, `skip` and `error` both null. Note that a
 *   `status.health` of `unverified` is an APPLIED outcome, not a failure: it is
 *   the normal terminal state of both HTTP rungs (§3.5), and counting it as a
 *   failure would tell an operator that thirty-seven working phones were broken.
 * - **skipped** — `skip` present. Nothing was attempted on the device, or it
 *   was deliberately not attempted; the code says which of §3.9's cases, and
 *   `skip.message` carries the per-device reason verbatim so twenty identically
 *   -blocked phones collapse into one row while a twenty-first with a different
 *   reason stays visible.
 * - **failed** — `error` present. Something was attempted and did not work.
 *
 * **`error` is a coded object, not the bare string `DeviceLabelsApplyResult`
 * uses.** This is a correction to plan 114 §3.9, which specifies
 * `error: z.string().nullable()` while its own classification table gives
 * failures codes (`E_SETTING_NOT_ACCEPTED`, `E_REVERSE_FAILED`). A free-text
 * message cannot be classified by a client, so the two halves of §3.9 could not
 * both be honoured as written — and the whole point of the classification is
 * that "the device declined the setting" and "the tunnel to this machine could
 * not be established" are different problems with different next actions. The
 * code is what keeps them apart; `skip` and `error` are symmetric for the same
 * reason.
 */
export const DeviceNetworkApplyResultSchema = z.object({
  deviceId: z.string(),
  /** Null whenever the call did not produce one — every `skip`, and every `error`. */
  status: DeviceNetworkStatusResponseSchema.nullable(),
  skip: z.object({ code: z.string(), message: z.string() }).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type DeviceNetworkApplyResult = z.infer<typeof DeviceNetworkApplyResultSchema>

export const DeviceNetworkApplyResponseSchema = z.object({
  total: z.number().int(),
  results: z.array(DeviceNetworkApplyResultSchema),
})
export type DeviceNetworkApplyResponse = z.infer<typeof DeviceNetworkApplyResponseSchema>

export type DeviceNetworkApplyOutcome = 'applied' | 'skipped' | 'failed'

/**
 * The one rule that turns a result row into an outcome class, declared beside
 * the schema and used by both sides — the same discipline `deriveHealth` in
 * `../network` follows, and for the same reason: two copies of a
 * classification drift, and the moment they do, a count on screen stops
 * matching the list underneath it.
 *
 * Order matters. `skip` is checked first because a skipped device may legally
 * carry neither a status nor an error, and `error` before the applied case
 * because a route that was persisted and then failed to apply produces both.
 */
export function classifyDeviceNetworkApply(result: DeviceNetworkApplyResult): DeviceNetworkApplyOutcome {
  if (result.skip !== null) return 'skipped'
  if (result.error !== null) return 'failed'
  return 'applied'
}

/**
 * `POST /api/devices/:id/network/credential/reveal` — the ONE response in this
 * package that carries a stored secret's plaintext, and the only place in the
 * REST surface where one crosses the wire outward at all.
 *
 * **It is deliberately not part of `DeviceNetworkStatusResponseSchema`.** The
 * device panel polls that endpoint every few seconds; a password on it would
 * mean the plaintext travelled continuously to every browser with the page
 * open, whether anyone asked for it or not, and would be audited either never
 * (unusable) or a hundred times a minute (unreadable). A separate,
 * deliberately-requested route is what makes "who read this, and when" a
 * question with one row per answer.
 *
 * The core gates it on `device.network` **plus the admin role** and writes a
 * `device.network.credential.reveal` audit row before this body is serialised —
 * both the grant and the refusal. See `packages/core/src/network/route-service.ts`.
 *
 * No `credentialRef` is accepted from the caller: the credential is whichever
 * one the named device's own persisted route references. A client therefore
 * cannot enumerate the farm's credential store through this route, only read
 * back the one belonging to a device it already named.
 */
export const DeviceNetworkCredentialRevealResponseSchema = z.object({
  /** The stored credential this route authenticates with — the same name `config.credentialRef` reports. */
  credentialRef: z.string(),
  /** Null when the credential was saved with no username (an upstream that authenticates by password alone). */
  username: z.string().nullable(),
  /** The plaintext. Never logged, never cached, never persisted anywhere by a client. */
  password: z.string(),
  /** Unix seconds the reveal was recorded at — the same instant the audit row carries, so an operator can find their own row. */
  revealedAt: z.number().int(),
})
export type DeviceNetworkCredentialRevealResponse = z.infer<typeof DeviceNetworkCredentialRevealResponseSchema>

/**
 * §3.9's classification, as the codes the core actually raises. Exported so
 * Studio can label each one from the user's side without re-deriving the set
 * (and so a code the UI has no label for is visibly a code, rather than being
 * quietly folded into "something went wrong").
 *
 * Skips — nothing was written to the phone:
 * - `E_DEVICE_OFFLINE`   the phone is not reachable.
 * - `E_DEVICE_CONFLICT`  a conflicting activity is already on the device; bulk never overrides it (§9 Q2, plan 205 §4.9).
 * - `E_AGENT_NOT_READY`  VPN was asked for and this phone's guest agent is not ready.
 * - `E_UNSUPPORTED`      this phone cannot run the agent at all (an old phone is not a broken one).
 *
 * Failures — something was attempted:
 * - `E_SETTING_NOT_ACCEPTED` the write went through and the read-back disagreed.
 * - `E_REVERSE_FAILED`       rung 2's `adb reverse` did not establish.
 * - `E_ROUTE_LOCK_HELD`      an incumbent route could not be turned off first.
 * - anything else, carrying its own code and message.
 */
export const DEVICE_NETWORK_APPLY_SKIP_CODES = ['E_DEVICE_OFFLINE', 'E_DEVICE_CONFLICT', 'E_AGENT_NOT_READY', 'E_UNSUPPORTED'] as const

/**
 * `GET/POST/DELETE /api/devices/:id/guest-agent` — bare, no wrapper.
 *
 * Plan 90 §4.7 names this endpoint's extension in full: `state` widens to
 * the six values `AgentStateSchema` already uses for the provisioner's own
 * persisted record (`packages/protocol/src/device.ts`), plus the four
 * pre-plan-90 values Studio's `NetworkPanel`/`AgentStateBadge` already parse
 * and render branches against — kept rather than replaced, because the
 * handler behind this endpoint (`packages/core/src/api/guest-agent.ts`'s
 * `statusOf`/`installAndProbe`) is NOT wired onto `AgentProvisioner.status()`
 * yet (that wiring is out of this step's file allowlist — see 90.6's own
 * status note), so it still emits ONLY the pre-plan-90 five. Widening here
 * is what makes `outdated`/`failed` — states the provisioner already
 * computes and stores on `devices.agent` — parseable through this endpoint
 * the moment that wiring lands, instead of throwing client-side the first
 * time a real device reports one (F10/F11, the exact regression the
 * deviation note on plan 90's own status line warned about).
 *
 * `versionCode`/`checkedAt`/`attempts`/`nextAttemptAt` are the other half of
 * §4.7's stated extension — declared here, all optional, so the schema is
 * ready the moment that same wiring lands; today's handler sends none of
 * them, and `AgentPanel` renders their absence honestly rather than a
 * placeholder.
 */
export const GuestAgentStatusResponseSchema = z.object({
  /**
   * `consent-required` is the newest member (see `AgentStateSchema`'s own doc
   * comment): the agent is installed and answering, but Android VPN consent
   * is outstanding and adb cannot grant it on this build. Widened here for
   * the same reason `outdated`/`failed` were — a state the provisioner
   * genuinely produces must be parseable through this endpoint rather than
   * throwing client-side the first time a real device reports one.
   */
  state: z.enum(['not-installed', 'installed', 'ready', 'unreachable', 'unsupported', 'outdated', 'failed', 'consent-required']),
  appVersion: z.string().optional(),
  androidSdkInt: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
  reason: z.string().optional(),
  /** Plan 90 §4.7 — no producer yet on this endpoint (see this schema's own doc comment). */
  versionCode: z.number().int().nullable().optional(),
  /** Plan 90 §4.7 — unix epoch seconds; no producer yet on this endpoint. */
  checkedAt: z.number().int().nullable().optional(),
  /** Plan 90 §4.7 — no producer yet on this endpoint. */
  attempts: z.number().int().optional(),
  /** Plan 90 §4.7 — unix epoch seconds; no producer yet on this endpoint. */
  nextAttemptAt: z.number().int().nullable().optional(),
})

/**
 * `POST /api/guest-agent/provision` (plan 90 §3.8, §4.7) —
 * `AgentProvisioner.ensureAll()`'s own return shape
 * (`packages/core/src/device/agent-provisioner.ts`), declared once here
 * rather than as a hand-rolled interface there (00-overview §4.4, the same
 * convention `ReconcileReportSchema` above established).
 */
export const AgentProvisionReportSchema = z.object({
  total: z.number().int(),
  results: z.array(z.object({ deviceId: z.string(), state: AgentStateSchema, reason: z.string().nullable() })),
})
export type AgentProvisionReport = z.infer<typeof AgentProvisionReportSchema>

/**
 * `GET /api/guest-agent/summary` (plan 90 §3.8, §4.7) — the farm-wide answer
 * to "are all my phones on the current agent", counted straight off
 * `devices.agent` (`createAgentProvisionerRoutes`'s `/summary` handler).
 * `byVersion`'s keys are `appVersion` strings, with `'unknown'` standing in
 * for a device whose stored status has none (never provisioned, or a build
 * too old to have reported one).
 */
export const GuestAgentSummaryResponseSchema = z.object({
  total: z.number().int(),
  byState: z.record(z.string(), z.number().int()),
  byVersion: z.record(z.string(), z.number().int()),
})

/**
 * `POST /api/devices/numbers/compact` (plan 89 §3.2 point 5, §4.2, §4.3) —
 * `compactDeviceNumbers`'s own return shape
 * (`packages/core/src/registry/device-number.ts`), wrapped for the wire.
 * `relabelled`/`failed` are declared now, ahead of the labelling service
 * (§4.6, step 89.6, not yet built) — every affected device reads as
 * unrelabelled today (`relabelled: 0`, `failed: []`), which is honest: there
 * is no label to re-push yet, not a silently skipped one. The moment 89.9
 * wires the re-push, this response starts saying something real with no
 * shape change.
 *
 * `released` (plan 96 §96.42) — every `device_numbers` reservation that was
 * deleted because it was orphaned (a `forget()`ed device's number, per §3.2's
 * own comment on `lifecycle.ts`'s `forget()`, with no matching `devices` row)
 * before the dense `1..n` sequence was computed. Compaction deletes every
 * orphan unconditionally, not just the ones whose slot this run happens to
 * need — see `compactDeviceNumbers`'s own doc comment for why — so this is
 * reported explicitly rather than silently folded into `changed`, which
 * only ever describes a still-live device's number moving.
 */
export const DeviceNumberChangeSchema = z.object({
  stableId: z.string(),
  from: z.number().int(),
  to: z.number().int(),
})
export const DeviceNumberReleasedSchema = z.object({
  stableId: z.string(),
  number: z.number().int(),
})
export const DeviceNumberCompactResponseSchema = z.object({
  changed: z.array(DeviceNumberChangeSchema),
  released: z.array(DeviceNumberReleasedSchema),
  relabelled: z.number().int(),
  failed: z.array(z.object({ stableId: z.string(), reason: z.string() })),
})
export type DeviceNumberChange = z.infer<typeof DeviceNumberChangeSchema>
export type DeviceNumberReleased = z.infer<typeof DeviceNumberReleasedSchema>

// ---- POST /api/devices/prep/apply ----

/**
 * The prep settings a bulk apply can carry, as a list — the ONE place that
 * decides which keys `POST /api/devices/prep/apply` accepts, read by the core
 * (to build the merge) and by Studio (to build the form), so the two can never
 * disagree about what a request is allowed to contain.
 *
 * `FarmSettings.defaults` does not cover this and never will: it is
 * copy-on-admission ("Devices already registered keep their own settings" — its
 * own doc), so changing a farm default changes nothing for a device that is
 * already enrolled. Until this route existed, `prep.rotation` and its four
 * siblings could only be set one device at a time through `PATCH
 * /api/devices/:id`, which is twenty requests for one setting on a farm that is
 * about to be twenty phones.
 */
export const DEVICE_PREP_KEYS = ['disableAnimations', 'keepAwake', 'standbyScreenOff', 'rotation', 'textInput'] as const
export type DevicePrepKey = (typeof DEVICE_PREP_KEYS)[number]

/**
 * **A partial patch, and that is the whole safety property of this route.**
 *
 * Every key is optional and the core writes back ONLY the keys that are
 * present. A bulk apply that carried the whole `prep` object would silently
 * overwrite four settings the operator never touched on every selected device
 * — and it would do it invisibly, because `DeviceSettingsSchema.prep` has a
 * default for every field, so an absent key does not read as "leave it alone",
 * it reads as "reset it to the default". That is exactly what `PATCH
 * /api/devices/:id` does (it parses the WHOLE settings object and writes the
 * result), which is correct for a form that renders every field and wrong for
 * a bulk action that renders five checkboxes.
 *
 * So the partiality is enforced in three independent places, on purpose:
 * this schema (optional keys), the core's merge (five explicit
 * `if (patch.x !== undefined)` assignments onto the device's CURRENT prep
 * block, never a spread of a patch whose absent keys are `undefined`), and the
 * body's own refinement below (a patch with no keys at all is a bad request,
 * not a fleet-wide reset to defaults).
 */
export const DevicePrepPatchSchema = z.object({
  disableAnimations: z.boolean().optional(),
  keepAwake: KeepAwakeModeSchema.optional(),
  standbyScreenOff: z.boolean().optional(),
  rotation: RotationModeSchema.optional(),
  textInput: TextInputModeSchema.optional(),
})
export type DevicePrepPatch = z.infer<typeof DevicePrepPatchSchema>

/**
 * Two compile-time guards against the one way this file can rot: `prep` gains
 * a sixth field, or one of these five changes type, and this schema keeps
 * compiling against a shape it no longer matches.
 *
 * The first asserts every key here is assignable to the real `prep` block (a
 * widened enum, a `boolean` that became a mode); the second asserts the
 * reverse, that no key of the real `prep` block is missing from
 * `DEVICE_PREP_KEYS`. A new prep setting therefore fails `bun run typecheck`
 * here, with the choice stated: add it to the list, or say in this file why it
 * is deliberately not bulk-settable.
 */
const _prepPatchIsASubsetOfPrep: (patch: DevicePrepPatch) => Partial<DeviceSettings['prep']> = (patch) => patch
/**
 * **`screenOffTimeoutMs` is deliberately not bulk-settable (yet)** — the guard
 * below offers exactly this choice, and this is the documented half of it.
 *
 * It is a genuinely good candidate for a bulk apply: plan 125's whole subject
 * is a twelve-plus device farm sealed in a box, where doing anything one
 * device at a time is the problem. It is excluded here only because the bulk
 * surface is not just a schema — `BulkPrepDialog` renders one control per key
 * and its `Record<DevicePrepKey, …>` maps make a new key a compile error
 * there, and a numeric/nullable duration is the first key in this list that is
 * not a checkbox or a small enum. Adding it is a Studio change with a real
 * design question in it (what does "leave it alone" look like next to a
 * number field?), not a line in this file, so plan 125 step 125.1/125.2 left
 * it out rather than shipping half of it.
 *
 * Nothing is blocked by the omission: `PATCH /api/devices/:id` sets it per
 * device today, and the farm-wide default (`DeviceSettingsSchema.prep`) is
 * what every newly admitted device picks up.
 */
type _EveryPrepKeyIsCovered = Exclude<keyof DeviceSettings['prep'], DevicePrepKey | 'screenOffTimeoutMs'> extends never
  ? true
  : 'a prep setting is missing from DEVICE_PREP_KEYS — add it, or document why it is not bulk-settable'
const _everyPrepKeyIsCovered: _EveryPrepKeyIsCovered = true
void _prepPatchIsASubsetOfPrep
void _everyPrepKeyIsCovered

export const DevicePrepApplyBodySchema = z.object({
  deviceIds: z.array(z.string()).min(1),
  /** At least one key — an empty patch is a request that means nothing, and must never be read as "apply the defaults". */
  prep: DevicePrepPatchSchema.refine((patch) => DEVICE_PREP_KEYS.some((key) => patch[key] !== undefined), {
    message: 'choose at least one prep setting to apply',
  }),
})
export type DevicePrepApplyBody = z.infer<typeof DevicePrepApplyBodySchema>

/**
 * One device's outcome, and it has to carry two separate facts because this
 * action has two separate halves:
 *
 * - **`changed`** — which of the chosen keys actually moved in the database on
 *   THIS device. `[]` means it already held every chosen value; that is a real
 *   and common outcome on a re-run, and it is not a failure.
 * - **`rotation`** — what happened to the screen that is streaming RIGHT NOW,
 *   `null` when the patch did not include `rotation` at all. It reuses
 *   `RotationApplyResultSchema` verbatim, so a bulk apply and a single-device
 *   `PATCH` cannot word the same four states differently.
 *
 * The pair is the point. `saved: true, rotation: { state: 'busy' }` is the
 * outcome this route exists to be honest about: the setting IS on the device
 * row, and the screen did NOT move, because a job is running and a settings
 * save must never rotate a phone out from under a running script (spec §10.1).
 * Collapsing those two facts into one "applied" is the failure mode this whole
 * report shape is built to prevent.
 *
 * `error` is a coded object rather than `DeviceLabelsApplyResult`'s bare
 * string, matching `DeviceNetworkApplyResultSchema` — the newer of the two
 * conventions, and the one a client can group by.
 */
export const DevicePrepApplyResultSchema = z.object({
  deviceId: z.string(),
  /** Whether the chosen keys are now on the device row. False only alongside an `error`. */
  saved: z.boolean(),
  /** The subset of the chosen keys whose value actually changed. Empty is normal, not a failure. */
  changed: z.array(z.enum(DEVICE_PREP_KEYS)),
  /** Null when `rotation` was not part of the patch. Never null just because nothing was streaming — that is `no-session`. */
  rotation: RotationApplyResultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type DevicePrepApplyResult = z.infer<typeof DevicePrepApplyResultSchema>

export const DevicePrepApplyResponseSchema = z.object({
  total: z.number().int(),
  /** Which keys the request asked for, echoed back — a report that cannot say WHAT was applied is half a report. */
  keys: z.array(z.enum(DEVICE_PREP_KEYS)),
  results: z.array(DevicePrepApplyResultSchema),
})
export type DevicePrepApplyResponse = z.infer<typeof DevicePrepApplyResponseSchema>

export type DevicePrepApplyOutcome = 'applied' | 'deferred' | 'failed'

/**
 * The one rule that turns a row into an outcome class, declared beside the
 * schema and used by both sides — the same discipline
 * `classifyDeviceNetworkApply` above follows, for the same reason: two copies
 * of a classification drift, and the moment they do, a count on screen stops
 * matching the list underneath it.
 *
 * - `failed` — nothing was saved (`error`), or the setting was saved and the
 *   phone did not end up in the requested orientation (`rotation.failed`). The
 *   second still counts as a failure even though the row was written, because
 *   the operator asked for a screen to rotate and it did not.
 * - `deferred` — saved, live apply not attempted, because a job is running.
 *   **Not** a skip: the device row DID change. The UI must say both halves.
 * - `applied` — everything the operator asked for on this device happened.
 *   `no-session` lands here: with nothing streaming there was no live half to
 *   do, and the stored setting is the whole of the action.
 */
export function classifyDevicePrepApply(result: DevicePrepApplyResult): DevicePrepApplyOutcome {
  if (result.error !== null) return 'failed'
  if (result.rotation?.state === 'failed') return 'failed'
  if (result.rotation?.state === 'busy') return 'deferred'
  return 'applied'
}
