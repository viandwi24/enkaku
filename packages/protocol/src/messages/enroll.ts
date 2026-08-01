import { z } from 'zod'

/** Enrollment (spec §13, §15.1). */

/** core → studio: device butuh authorize di layar HP. */
export const DeviceUnauthorizedMessage = z.object({
  type: z.literal('device.unauthorized'),
  payload: z.object({ serial: z.string() }),
})

/** studio → core: mulai pairing wireless (Android 11+). */
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

/** studio → core: submit 6-digit code (+ connect port opsional). */
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
