import { z } from 'zod'
import { InstallResultSchema } from '../messages/transfer'

/** `POST /api/devices/:id/install`. */
export const InstallResponseSchema = z.object({ result: InstallResultSchema })

/**
 * `POST /api/devices/:id/pull` — Studio only ever reads `.result.artifactId`
 * and `.result.bytes`, so this stays a narrow, permissive subset of the
 * actual pull-result shape rather than re-declaring every field.
 */
export const PullResponseSchema = z.object({
  result: z.object({ artifactId: z.string(), bytes: z.number() }),
})
