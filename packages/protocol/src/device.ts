import { z } from 'zod'
import { BatteryStateSchema } from './settings'
import { DeviceReadinessSchema, ReadinessSchema } from './readiness'
import { GuestAgentCapabilitySchema } from './guest-agent'

/** How a device's transport is reached — OBSERVED from adb (plan 88 §3.1, §4.1). */
export const ConnectionKindSchema = z.enum(['usb', 'tcp'])
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>

/** The physical medium a `tcp` connection rides on — DECLARED by an operator or INFERRED from a configured farm network; never observed (plan 88 §3.1). */
export const ConnectionMediumSchema = z.enum(['wired', 'wireless'])
export type ConnectionMedium = z.infer<typeof ConnectionMediumSchema>

/**
 * How a device is reached (plan 88 §3.1). TWO fields, deliberately:
 * `kind` is OBSERVED (adb's serial shape, plus the `usb:` field
 * `host:devices-l` carries), `medium` is DECLARED by an operator or
 * INFERRED from a configured farm network — adb cannot see the difference
 * between a switch port and a radio, and a schema that stores 'otg' as an
 * observed value stores a claim as a fact. Same observed-vs-declared split
 * as readiness (desired/actual) and network routes (declared/observed).
 */
export const DeviceConnectionSchema = z.object({
  kind: ConnectionKindSchema,
  medium: ConnectionMediumSchema.nullable(),
  mediumSource: z.enum(['declared', 'network', 'unknown']),
  /** Host part of a `host:port` serial; null for USB. */
  address: z.string().nullable(),
  port: z.number().int().nullable(),
  /** `discovery.networks[].label` when the address matched one — for the tooltip and the sweep report. */
  networkLabel: z.string().nullable(),
})
export type DeviceConnection = z.infer<typeof DeviceConnectionSchema>

/** USB | WI-FI | OTG | TCP — the ONE place the badge string is computed, so no surface can disagree with another (plan 88 §3.1, §4.1). */
export function connectionBadge(c: DeviceConnection): 'USB' | 'WI-FI' | 'OTG' | 'TCP' {
  if (c.kind === 'usb') return 'USB'
  if (c.medium === 'wired') return 'OTG'
  if (c.medium === 'wireless') return 'WI-FI'
  // tcp with no known medium — honest uncertainty, never a guessed WI-FI (the
  // exact mistake `packages/drivers/src/descriptors.ts`'s `adb-tcp` display
  // name made before this plan; see its own updated comment).
  return 'TCP'
}

/**
 * Device status (spec §12): M0 only ever produces 'offline' | 'idle'; the
 * full enum is declared now to avoid a schema migration in M3.
 */
export const DeviceStatusSchema = z.enum(['offline', 'idle', 'manual', 'busy', 'quarantined'])
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>

/**
 * Who holds a device's manual (control) lease — a person, an agent, or a job
 * (plan 71 §3.2). The lease manager already knew this (`Lease.holder`,
 * `Lease.holderUserId`); nothing propagated it past the lease manager itself,
 * so an agent driving a phone was invisible to every surface. One field
 * fixes the badge, the takeover dialog, and the wall.
 */
export const LeaseHolderSchema = z.object({
  kind: z.enum(['user', 'agent', 'job']),
  /** clientId for a user (or the authenticated userId when known), agentId for an agent, jobId for a job. */
  id: z.string(),
  /** For display: a username, an agent's name, a script's `name@version` — resolved server-side (plan 71 §3.3). */
  label: z.string(),
  /** Agent only — the ROOT run id, so a whole tree reads as one holder (plan 67 §3.7). */
  runId: z.string().nullable(),
  /** Whether this hold can be taken over at all (plan 71 §3.4) — computed server-side, never derived by a client. */
  takeable: z.boolean(),
  acquiredAt: z.number(),
  expiresAt: z.number().nullable(),
})
export type LeaseHolder = z.infer<typeof LeaseHolderSchema>

/**
 * The on-device Enkaku guest agent's provisioning state (plan 90 §3.8, §4.3) —
 * a DEVICE property, not a session step (§3.8's decision): it exists whether
 * or not a session is open, exactly like `status` above.
 *
 * `absent` — never successfully provisioned (or removed).
 * `provisioning` — a pass is in flight right now.
 * `ready` — installed, matches the manifest's pinned build, and answered `hello`.
 * `outdated` — installed, but the version/signature (or protocol) does not
 *   match the pinned build after one repair attempt (R1, §3.9) — a repairable,
 *   actionable state ("Update agent"), never a crash.
 * `failed` — a provisioning pass could not install or reach the agent, with a
 *   verbatim reason. Load-bearing (§3.8): `failed` NEVER quarantines, blocks,
 *   or changes scheduling — a device with a failed agent still streams video,
 *   takes input, runs jobs, and answers a shell.
 * `unsupported` — the device's API level is below the agent's floor
 *   (`MIN_SUPPORTED_SDK`), terminal by design, not a failure to retry.
 */
export const AgentStateSchema = z.enum(['absent', 'provisioning', 'ready', 'outdated', 'failed', 'unsupported'])
export type AgentState = z.infer<typeof AgentStateSchema>

/**
 * The provisioner's COMBINED, in-memory view of one device's guest agent
 * (plan 90 §4.3; split into two persisted sources by plan 106 §5 step
 * 106.5 — see `GuestAgentIdentitySchema` below and
 * `packages/core/src/device/preparation/guest-agent-status.ts`, the module
 * that recombines them). `AgentProvisioner.ensure()`/`.status()` still
 * return exactly this shape — no external caller changed — but it is no
 * longer what is literally stored in any single DB column:
 *
 * - `state`/`reason`/`checkedAt`/`attempts`/`nextAttemptAt` are now
 *   authoritative in `devices.preparation['guest-agent']`
 *   (`PreparationComponentStatusSchema`, `device-preparation.ts`) — the
 *   SAME state machine every other on-device component uses.
 * - `appVersion`/`versionCode`/`androidSdkInt`/`capabilities` are identity
 *   facts a live `hello()` handshake happens to learn, with no equivalent
 *   in the generic per-component shape (every OTHER registered component
 *   is a plain installed/verified artifact with no protocol handshake of
 *   its own) — they still live in `devices.agent`, narrowed to exactly
 *   these four fields (`GuestAgentIdentitySchema` below). `devices.agent`
 *   no longer carries a `state` of its own to disagree with the
 *   preparation record's — it simply does not claim to know one.
 *
 * `reason` is always verbatim, never summarised (§3.8) — `AgentProvisioner`
 * callers show it directly to an operator. `attempts`/`nextAttemptAt`
 * mirror the bounded-retry shape network route recovery already uses (plan
 * 90 §3.7; `packages/core/src/device/bounded-retry.ts` since plan 106 §5
 * step 106.2).
 */
export const AgentStatusSchema = z.object({
  state: AgentStateSchema,
  appVersion: z.string().nullable(),
  versionCode: z.number().int().nullable(),
  androidSdkInt: z.number().int().nullable(),
  capabilities: z.array(GuestAgentCapabilitySchema),
  reason: z.string().nullable(),
  /** Unix epoch seconds of the last completed pass. */
  checkedAt: z.number().int().nullable(),
  attempts: z.number().int(),
  nextAttemptAt: z.number().int().nullable(),
})
export type AgentStatus = z.infer<typeof AgentStatusSchema>

/** A device that has never been provisioned — the default for a brand-new row, and the safe fallback for a stored value that fails validation. */
export const DEFAULT_AGENT_STATUS: AgentStatus = {
  state: 'absent',
  appVersion: null,
  versionCode: null,
  androidSdkInt: null,
  capabilities: [],
  reason: null,
  checkedAt: null,
  attempts: 0,
  nextAttemptAt: null,
}

/**
 * `devices.agent`'s ACTUAL persisted shape as of plan 106 §5 step 106.5 —
 * the identity facts a live guest-agent `hello()` handshake learns, with no
 * equivalent field in the generic `PreparationComponentStatusSchema` every
 * OTHER on-device component uses. Deliberately narrower than the old
 * `AgentStatusSchema` this column used to hold in full: it carries no
 * `state`, `reason`, `attempts`, or `nextAttemptAt` any more, because
 * `devices.preparation['guest-agent']` is now the ONLY place those facts
 * are written — this column no longer has an opinion to disagree with it.
 * Parsing an OLD, pre-106.5 row (which still has the full legacy
 * `AgentStatusSchema` shape here, `state` included) against this narrower
 * schema is safe and intended: Zod's default object parsing strips unknown
 * keys rather than rejecting them, so exactly the four fields below survive
 * unchanged and the rest is quietly ignored — `guest-agent-status.ts`'s own
 * legacy fallback is what recovers `state`/`reason`/etc. from that same old
 * row for `devices.preparation`, once, the first time a real pass writes it.
 */
export const GuestAgentIdentitySchema = z.object({
  appVersion: z.string().nullable(),
  versionCode: z.number().int().nullable(),
  androidSdkInt: z.number().int().nullable(),
  capabilities: z.array(GuestAgentCapabilitySchema),
})
export type GuestAgentIdentity = z.infer<typeof GuestAgentIdentitySchema>

/** No guest-agent pass has ever populated identity facts for this device — the default for a brand-new row, and the safe fallback for a stored value that fails validation. */
export const DEFAULT_GUEST_AGENT_IDENTITY: GuestAgentIdentity = {
  appVersion: null,
  versionCode: null,
  androidSdkInt: null,
  capabilities: [],
}

export const DeviceInfoSchema = z.object({
  id: z.string(),
  stableId: z.string(),
  /** The current adb transport address — NOT an identity (spec §7.5). */
  serial: z.string(),
  label: z.string(),
  androidVersion: z.string().nullable(),
  apiLevel: z.number().int().nullable(),
  screenW: z.number().int().nullable(),
  screenH: z.number().int().nullable(),
  density: z.number().int().nullable(),
  status: DeviceStatusSchema,
  /** Unix epoch seconds. */
  lastSeen: z.number().int().nullable(),
  /** Last battery and temperature reading — carried in the payload so badges show on first load. */
  battery: BatteryStateSchema.nullable().default(null),
  /** Quarantine reason, e.g. 'thermal:49.8C'. */
  quarantineReason: z.string().nullable().default(null),
  /** Sorted, normalised. Empty array rather than null, so callers need no guard. */
  tags: z.array(z.string()).default([]),
  /**
   * The owning cluster (plan 22.0 §4.2), or null when unclustered. An object
   * rather than a bare id so every list and picker can render the name
   * without a second lookup — the same reasoning that put `tags` inline.
   */
  cluster: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
  /**
   * When this device last had an application crash or ANR, IF it was within
   * the last hour — otherwise null (plan 37 §4.5). Only the fleet list
   * (`listDevicesWithTags`) populates this today; single-device fetches and
   * the `device.added`/`device.status` broadcasts leave it null rather than
   * paying for the lookup on every call site, which is honest (not stale)
   * because the device page has its own full Crashes panel regardless.
   */
  lastCrashAt: z.number().int().nullable().default(null),
  /**
   * asleep|awake|hot, desired-vs-actual reported separately (plan 43 §3.3,
   * §4.1) — a second, orthogonal axis to `status` above. Defaulted so a
   * caller that constructs a `DeviceInfo` without it (existing tests, or a
   * fallback computed with no live readiness manager to hand) still parses;
   * every production call site populates it from the real manager.
   */
  readiness: DeviceReadinessSchema.default(() => ({ desired: 'asleep' as const, actual: 'asleep' as const, blocked: null, since: 0 })),
  /**
   * Who currently holds this device's manual lease, or `null` when nobody
   * does (plan 71 §3.2) — replaces the three polling workarounds
   * `packages/studio/src/lib/agent-holders.ts` used to need. Defaulted so a
   * caller that constructs a `DeviceInfo` without it (existing tests, or a
   * fallback with no lease manager to hand) still parses.
   */
  heldBy: LeaseHolderSchema.nullable().default(null),
  /**
   * Who is currently assisting this device — a narrow, subordinate grant to
   * touch a device someone/something else already controls, never a
   * takeover (plan 91 §3.2, §3.4 item 4, F25). Empty, never null, so callers
   * need no guard (the same reasoning `tags` above uses). Every entry's
   * `takeable` is `false`: an assist is granted or refused, never taken over
   * (§3.2), so the takeover dialog must never target one. Defaulted so a
   * caller that constructs a `DeviceInfo` without it (existing tests, or a
   * fallback with no co-control manager to hand) still parses; every
   * production call site populates it alongside `heldBy`.
   */
  assistedBy: z.array(LeaseHolderSchema).default([]),
  /**
   * How this device is reached (plan 88 §3.1, §4.1) — computed by
   * `deriveConnection` (`packages/core/src/registry/device-registry.ts`),
   * never by a client. Defaulted so a caller that constructs a `DeviceInfo`
   * without it (existing tests, or a fallback with no live derivation to
   * hand) still parses; every production call site populates it for real.
   */
  connection: DeviceConnectionSchema.default(() => ({
    kind: 'usb' as const,
    medium: null,
    mediumSource: 'unknown' as const,
    address: null,
    port: null,
    networkLabel: null,
  })),
  /**
   * The guest agent's provisioning state (plan 90 §3.8, §4.3, §4.7) — the
   * narrow chip-only field on purpose: the version and capability list stay
   * on the per-device `GET /:id/guest-agent` endpoint, so this payload does
   * not grow for every device on every fleet fetch (§8's risk table).
   * Defaulted to `'absent'` so a caller that constructs a `DeviceInfo`
   * without it (existing tests, or a fallback with no provisioner to hand)
   * still parses.
   */
  agent: AgentStateSchema.default('absent'),
  /**
   * The device's short operator-facing number (plan 89 §3.1, §3.2). Lives in
   * its own `device_numbers` table keyed by `stableId`, NOT a column on
   * `devices` — that is what lets it survive Forget. Nullable only for a
   * device whose reservation was explicitly released; every admitted device
   * has one. Rendered as `#7`, never zero-padded — padding width would change
   * for the whole fleet the day it crosses 100. Composes with `label`; never
   * concatenated into it (§3.3).
   */
  number: z.number().int().positive().nullable().default(null),
})
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>

export const DeviceAddedMessage = z.object({
  type: z.literal('device.added'),
  payload: DeviceInfoSchema,
})
export type DeviceAdded = z.infer<typeof DeviceAddedMessage>

export const DeviceRemovedMessage = z.object({
  type: z.literal('device.removed'),
  payload: z.object({ id: z.string(), stableId: z.string() }),
})
export type DeviceRemoved = z.infer<typeof DeviceRemovedMessage>

/**
 * A phone adb has seen that nobody has admitted to the farm (plan 56).
 *
 * Deliberately NOT a `DeviceInfo`: a discovered device has no id, no status,
 * no cluster, no readiness and no tags, because it has no `devices` row at
 * all. Reusing the device shape would mean inventing values for all of those,
 * and an invented status is exactly how something unadmitted ends up looking
 * schedulable.
 */
export const DeviceDiscoveredMessage = z.object({
  type: z.literal('device.discovered'),
  payload: z.object({
    stableId: z.string(),
    /** Transport address at last sight — informational; identity is `stableId`. */
    serial: z.string(),
    /** `ro.product.model` when the probe could read it. */
    label: z.string().nullable(),
    androidVersion: z.string().nullable(),
  }),
})
export type DeviceDiscovered = z.infer<typeof DeviceDiscoveredMessage>

export const DeviceStatusMessage = z.object({
  type: z.literal('device.status'),
  payload: z.object({
    id: z.string(),
    stableId: z.string(),
    status: DeviceStatusSchema,
  }),
})
export type DeviceStatusEvent = z.infer<typeof DeviceStatusMessage>

/**
 * Client → server: set the operator's standing intent (plan 43 §4.1).
 * NEVER changes anything by itself — the server derives `actual` and reports
 * it back on the `device.readiness` broadcast below. Refused server-side per
 * §3.4 (offline/quarantined for a Wake; a running job or another viewer/lease
 * holder for a Sleep) — crafting this message directly is refused exactly
 * the same way the UI's button would be (acceptance #7).
 */
export const DeviceReadinessSetMessage = z.object({
  type: z.literal('device.readiness.set'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string(), desired: ReadinessSchema }),
})
export type DeviceReadinessSet = z.infer<typeof DeviceReadinessSetMessage>

/**
 * Server → client, broadcast to every subscriber (plan 43 §4.1) so the Wall,
 * the devices list, and the device page all move together from one message,
 * with no page refresh (acceptance #13). `id` is set only on the direct
 * reply to a `device.readiness.set` request, correlating it back for the
 * sender; every other broadcast of this same message (the actual state
 * change, reconciliation, or an event unrelated to any one request) omits it.
 */
export const DeviceReadinessMessage = z.object({
  type: z.literal('device.readiness'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string(), readiness: DeviceReadinessSchema }),
})
export type DeviceReadinessEvent = z.infer<typeof DeviceReadinessMessage>
