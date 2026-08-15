import { z } from 'zod'
import { InstallResultSchema, PushResultSchema } from '../messages/transfer'

/** `POST /api/devices/:id/install`. */
export const InstallResponseSchema = z.object({ result: InstallResultSchema })

/** `POST /api/devices/:id/push` (plan 90 §4.6) — carries `mediaScan` so the
 * caller learns whether, and how, the pushed file was told to MediaStore. */
export const PushResponseSchema = z.object({ result: PushResultSchema })

/**
 * `POST /api/devices/:id/pull` — Studio only ever reads `.result.artifactId`
 * and `.result.bytes`, so this stays a narrow, permissive subset of the
 * actual pull-result shape rather than re-declaring every field.
 */
export const PullResponseSchema = z.object({
  result: z.object({ artifactId: z.string(), bytes: z.number() }),
})
