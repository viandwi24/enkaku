import { z } from 'zod'

/**
 * Envelope message Core⇄Studio (00-overview §4.3, spec §13).
 * `id` dipakai untuk korelasi request-reply (belum dipakai di M0).
 */
export const EnvelopeSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  payload: z.unknown(),
})
export type Envelope = z.infer<typeof EnvelopeSchema>
