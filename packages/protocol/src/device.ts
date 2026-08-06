import { z } from 'zod'
import { BatteryStateSchema } from './settings'
import { DeviceReadinessSchema, ReadinessSchema } from './readiness'

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
