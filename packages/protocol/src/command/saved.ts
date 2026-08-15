import { z } from 'zod'
import { CommandTargetSchema } from './target'

/**
 * `packages/core/src/api/saved-commands.ts`'s response envelopes (plan 93
 * §3.10, §4.2, §4.4, step 93.6) — the wire shape of a `saved_commands` row.
 *
 * Kept in THIS directory (`command/`, step 93.6's own, per the brief) rather
 * than beside `api/command-runs.ts` in `packages/protocol/src/api/` — that
 * directory is where `command-runs.ts`'s own envelopes (step 93.4) live, and
 * this step does not own it.
 *
 * No `dangerous` field: whether a command is high-consequence is derived
 * fresh from `cmd` by the shared guard (`isHighConsequence`) at render and
 * run time — never cached here, so an edited command cannot go stale
 * against a stored boolean (plan 93 §3.10).
 */

export const SavedCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  cmd: z.string(),
  /** A cluster id, a tag set, or null — prefilled on the run form, never enforced (§3.10). */
  defaultTarget: CommandTargetSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  sortOrder: z.number().int(),
})
export type SavedCommand = z.infer<typeof SavedCommandSchema>

/** `GET /api/saved-commands` — a plain list, not keyset-paginated: capped at `shell.savedCommandLimit` (max 1000), matching `GET /api/scripts/:name/param-sets`'s own flat-list precedent. */
export const SavedCommandListResponseSchema = z.object({ items: z.array(SavedCommandSchema) })

/** `POST /api/saved-commands`, `PATCH /api/saved-commands/:id`. */
export const SavedCommandResponseSchema = z.object({ savedCommand: SavedCommandSchema })

export const SavedCommandDeleteResponseSchema = z.object({ deleted: z.boolean() })
