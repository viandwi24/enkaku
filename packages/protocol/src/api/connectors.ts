import { z } from 'zod'
import { ConnectorSchema, ModelInfoSchema } from '../agent'

/** `GET /api/connectors` (`packages/core/src/api/connectors.ts`). */
export const ListConnectorsResponseSchema = z.object({ connectors: z.array(ConnectorSchema) })

/** `GET/POST/PATCH /api/connectors(/:id)`. */
export const ConnectorResponseSchema = z.object({ connector: ConnectorSchema })

/**
 * `GET /api/connectors/:id/models` — either the no-API-key short circuit
 * (`{models: [], fallback: true}`) or `provider/index.ts`'s
 * `Promise<{models: ModelInfo[]; fallback: boolean}>` verbatim.
 */
export const ConnectorModelsResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
  fallback: z.boolean(),
})
