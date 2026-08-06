import { z } from 'zod'
import { FarmSettingsSchema } from '../settings'
import { JsonSchemaNodeSchema } from './json-schema'

/** `GET /api/settings` — `schema`/`deviceSchema` are `z.toJSONSchema(...)` output. */
export const SettingsResponseSchema = z.object({
  settings: FarmSettingsSchema,
  schema: JsonSchemaNodeSchema,
  deviceSchema: JsonSchemaNodeSchema,
})

/** `PATCH /api/settings`. */
export const UpdateSettingsResponseSchema = z.object({ settings: FarmSettingsSchema })
