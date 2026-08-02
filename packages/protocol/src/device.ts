import { z } from 'zod'
import { BatteryStateSchema } from './settings'

/**
 * Device status (spec §12): M0 only ever produces 'offline' | 'idle'; the
 * full enum is declared now to avoid a schema migration in M3.
 */
export const DeviceStatusSchema = z.enum(['offline', 'idle', 'manual', 'busy', 'quarantined'])
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>

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

export const DeviceStatusMessage = z.object({
  type: z.literal('device.status'),
  payload: z.object({
    id: z.string(),
    stableId: z.string(),
    status: DeviceStatusSchema,
  }),
})
export type DeviceStatusEvent = z.infer<typeof DeviceStatusMessage>
