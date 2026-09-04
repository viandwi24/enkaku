import { JsonSchemaNodeSchema, ScriptListItemSchema, ScriptPluginRefSchema, type JsonSchemaNode } from '@enkaku/protocol'
import { z } from 'zod'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `script.list`, `.get` (plan 210 §4.8) — one-line delegations to
 * `ctx.scripts`, which wraps the SAME `scripts/service.ts` functions
 * `GET /api/scripts` calls. There is no `script.publish` any more: a script
 * exists only as a member of a plugin, and publishing goes through
 * `plugin.stage` (`capability/plugin.ts`).
 */

const ScriptDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  exportId: z.string(),
  plugin: ScriptPluginRefSchema,
  paramsSchema: z.unknown(),
  source: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number().int().nullable(),
  /**
   * Plan 97 §4.7 — so a model can read what a script PROMISES to return
   * before running it. `.nullable().default(null)`: `null` for a row
   * published before `scripts.resultSchema` existed, or for a script that
   * still declares nothing.
   */
  resultSchema: JsonSchemaNodeSchema.nullable().default(null),
})

export const scriptList = defineCapability({
  id: 'script.list',
  input: z.object({}),
  output: z.object({ items: z.array(ScriptListItemSchema) }),
  permission: 'script.view',
  deadline: 5_000,
  effect: 'read',
  description: 'List every script that is a member of an ACTIVE plugin, with its owning plugin, params and last run.',
  handler: (ctx) => Promise.resolve({ items: ctx.scripts.list() }),
})

export const scriptGet = defineCapability({
  id: 'script.get',
  input: z.object({ id: z.string() }),
  output: ScriptDetailSchema,
  permission: 'script.view',
  deadline: 5_000,
  effect: 'read',
  description: 'Get one script row by its concrete id (not a name@version reference) — any owned row, active or superseded.',
  handler: (ctx, { id }) => {
    const script = ctx.scripts.get(id)
    if (!script) throw new EnkakuError('script_not_found', `no such script: ${id}`)
    // Plan 97 §4.4, §4.7 — `resultSchema` carries the real stored value (or
    // `null` for an undeclared row). Reconciled the same way
    // `scripts/routes.ts`'s `GET /:id` reconciles its own raw `unknown`-typed
    // JSON column against `JsonSchemaNodeSchema` — not a bypass of
    // validation, since `ScriptDetailSchema` above still Zod-checks it on
    // the way out.
    return Promise.resolve({ ...script, resultSchema: script.resultSchema as JsonSchemaNode | null })
  },
})

export const SCRIPT_CAPABILITIES = [scriptList, scriptGet]
