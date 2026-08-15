import { z } from 'zod'
import { AgentStateSchema, ConnectionMediumSchema, DeviceConnectionSchema, DeviceInfoSchema, LeaseHolderSchema } from '../device'
import { DeviceEventSchema } from '../messages/device-event'
import { DeviceReadinessSchema } from '../readiness'
import { NetworkEngineIdSchema, RouteCheckSchema } from '../network'
import { ViewerSchema } from '../messages/presence'
import { pageSchema } from './pagination'

/** `GET /api/devices/:id`, `POST /api/devices/discovered/:stableId/admit`. */
export const DeviceResponseSchema = z.object({ device: DeviceInfoSchema })

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
  /** Every network the sweep actually looked at, and how big each one is (`addressCount()` — the full range, including the network/broadcast address). */
  networks: z.array(z.object({ cidr: z.string(), label: z.string(), addresses: z.number() })),
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

export const DeviceNetworkConfigSchema = z.object({
  host: z.string(),
  port: z.number(),
  credentialRef: z.string().optional(),
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
  config: DeviceNetworkConfigSchema.nullable(),
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
})

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
  state: z.enum(['not-installed', 'installed', 'ready', 'unreachable', 'unsupported', 'outdated', 'failed']),
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
 */
export const DeviceNumberChangeSchema = z.object({
  stableId: z.string(),
  from: z.number().int(),
  to: z.number().int(),
})
export const DeviceNumberCompactResponseSchema = z.object({
  changed: z.array(DeviceNumberChangeSchema),
  relabelled: z.number().int(),
  failed: z.array(z.object({ stableId: z.string(), reason: z.string() })),
})
export type DeviceNumberChange = z.infer<typeof DeviceNumberChangeSchema>
