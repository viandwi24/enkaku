import { z } from 'zod'
import { AdbServerHealthSchema } from '../api/adb'

/**
 * "Is adb stuck?" (plan 88 §3.9, §4.7) — broadcast only when
 * `AdbServerHealth.status` TRANSITIONS (ok → degraded → stuck, or back),
 * never on every probe tick. `GET /api/adb/stats`'s `adbHealth` block
 * carries the same shape for a client that only just subscribed and missed
 * the transition (the `/ws` protocol has no snapshot replay).
 */
export const AdbHealthMessage = z.object({
  type: z.literal('adb.health'),
  payload: AdbServerHealthSchema,
})
export type AdbHealthEvent = z.infer<typeof AdbHealthMessage>
