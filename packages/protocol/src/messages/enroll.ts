import { z } from 'zod'
import { BatteryStateSchema } from '../settings'

/** Enrollment (spec §13, §15.1). */

/** core → studio: the device needs authorising on its own screen. */
export const DeviceUnauthorizedMessage = z.object({
  type: z.literal('device.unauthorized'),
  payload: z.object({ serial: z.string() }),
})

/** studio → core: begin wireless pairing (Android 11+). */
export const DevicePairingRequestMessage = z.object({
  type: z.literal('device.pairing.request'),
  id: z.string(),
  payload: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }),
})

/** core → studio: reply pairing.request. */
export const DevicePairingRequestResultMessage = z.object({
  type: z.literal('device.pairing.request.result'),
  id: z.string(),
  payload: z.object({ pairingId: z.string() }),
})

/** studio → core: submit the 6-digit code (plus an optional connect port). */
export const DevicePairingCodeMessage = z.object({
  type: z.literal('device.pairing.code'),
  id: z.string(),
  payload: z.object({
    pairingId: z.string(),
    code: z.string().regex(/^\d{6}$/),
    connectPort: z.number().int().min(1).max(65535).optional(),
  }),
})

/** core → studio: reply pairing.code. */
export const DevicePairingCodeResultMessage = z.object({
  type: z.literal('device.pairing.code.result'),
  id: z.string(),
  payload: z.object({ success: z.boolean(), message: z.string() }),
})

/** Status engine inspector on-device (M4.5). */
export const DeviceInspectorStatusMessage = z.object({
  type: z.literal('device.inspector.status'),
  payload: z.object({
    deviceId: z.string(),
    state: z.enum(['starting', 'healthy', 'restarting', 'dead']),
    reason: z.string().optional(),
    attempt: z.number().int().optional(),
  }),
})

/** The inspector engine dropped to a fallback for this session (M4.5). */
export const DeviceInspectorFallbackMessage = z.object({
  type: z.literal('device.inspector.fallback'),
  payload: z.object({
    deviceId: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
})

/** A device battery and temperature update (M5, spec §15.2). */
export const DeviceBatteryMessage = z.object({
  type: z.literal('device.battery'),
  payload: z.object({ deviceId: z.string(), battery: BatteryStateSchema }),
})
