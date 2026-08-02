import { z } from 'zod'

/**
 * Envelope message Core⇄Studio (00-overview §4.3, spec §13).
 * `id` correlates request and reply (unused in M0).
 */
export const EnvelopeSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  payload: z.unknown(),
})
export type Envelope = z.infer<typeof EnvelopeSchema>
