import { z } from 'zod'

/**
 * Status device (spec §12): M0 hanya menghasilkan 'offline' | 'idle';
 * enum lengkap dideklarasikan sekarang supaya tidak migrate schema di M3.
 */
export const DeviceStatusSchema = z.enum(['offline', 'idle', 'manual', 'busy', 'quarantined'])
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>

export const DeviceInfoSchema = z.object({
  id: z.string(),
  stableId: z.string(),
  /** Alamat transport adb saat ini — BUKAN identitas (spec §7.5). */
  serial: z.string(),
  label: z.string(),
  androidVersion: z.string().nullable(),
  apiLevel: z.number().int().nullable(),
  screenW: z.number().int().nullable(),
  screenH: z.number().int().nullable(),
  density: z.number().int().nullable(),
  status: DeviceStatusSchema,
  /** Unix epoch detik. */
  lastSeen: z.number().int().nullable(),
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
