import { z } from 'zod'
import { FarmSettingsSchema } from '../settings'
import { JsonSchemaNodeSchema } from './json-schema'

/** `GET /api/settings` — `schema`/`deviceSchema` are `z.toJSONSchema(...)` output. */
export const SettingsResponseSchema = z.object({
  settings: FarmSettingsSchema,
  schema: JsonSchemaNodeSchema,
  deviceSchema: JsonSchemaNodeSchema,
  /**
   * What this build's schema would produce for a farm with no stored row —
   * `defaultFarmSettings()`, sent alongside the live values.
   *
   * It is here so a client can show what a reset would actually change
   * BEFORE the operator commits to one. Without it Studio can only offer
   * "restore defaults" as a leap of faith: the defaults live in the binary,
   * the stored values live in the database, and only the server holds both.
   */
  defaults: FarmSettingsSchema,
})

/** `PATCH /api/settings`. */
export const UpdateSettingsResponseSchema = z.object({ settings: FarmSettingsSchema })

/**
 * `POST /api/settings/reset` — put the named top-level sections back to this
 * build's defaults.
 *
 * Sections, never individual fields, and never the whole row implicitly: the
 * caller always names what it means. `min(1)` because a reset that resets
 * nothing is a caller bug worth surfacing, not a silent no-op.
 */
export const ResetSettingsRequestSchema = z.object({
  sections: z.array(z.string().min(1)).min(1).max(64),
})

/** `POST /api/settings/reset`. `reset` echoes the sections that were applied, in the order given. */
export const ResetSettingsResponseSchema = z.object({
  settings: FarmSettingsSchema,
  reset: z.array(z.string()),
})
