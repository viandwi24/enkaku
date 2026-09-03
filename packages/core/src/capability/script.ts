import { JsonSchemaNodeSchema, type JsonSchemaNode } from '@enkaku/protocol'
import { z } from 'zod'
import { buildScriptFromWorkspace } from '../scripts/build'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/** `script.list`, `.get`, `.publish` (plan 63 §4.3 table) — one-line
 * delegations to `ctx.scripts`, which wraps the SAME `scripts/service.ts`
 * functions `POST /api/scripts`/`GET /api/scripts` call (plan 63 §4.3,
 * §6.9: `script.publish` and `POST /api/scripts` cannot disagree about what
 * publishing means, because they run the same function). No `script.delete`
 * capability — the plan's own table (§4.3) does not list one for this plan. */

const ScriptGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  latestVersion: z.string(),
  versionCount: z.number().int().nonnegative(),
  lastPublishedAt: z.number().int().nullable(),
  enabled: z.boolean(),
})

const ScriptDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  paramsSchema: z.unknown(),
  source: z.string().nullable(),
  enabled: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.number().int().nullable(),
  /**
   * Plan 97 §4.7 — so a model can read what a script PROMISES to return
   * before running it (the cheap half of plan 95 §9 Q3), needing no tool
   * roster change. `.nullable().default(null)`: `null` for a row published
   * before `scripts.resultSchema` existed (plan 97.2's storage column,
   * §4.4), or for a script that still declares nothing.
   */
  resultSchema: JsonSchemaNodeSchema.nullable().default(null),
})

export const scriptList = defineCapability({
  id: 'script.list',
  input: z.object({}),
  output: z.object({ items: z.array(ScriptGroupSchema) }),
  permission: 'script.view',
  deadline: 5_000,
  effect: 'read',
  description: 'List every script, one entry per NAME (not per published version), with its latest resolvable version.',
  handler: (ctx) => Promise.resolve({ items: ctx.scripts.listGroups() }),
})

export const scriptGet = defineCapability({
  id: 'script.get',
  input: z.object({ id: z.string() }),
  output: ScriptDetailSchema,
  permission: 'script.view',
  deadline: 5_000,
  effect: 'read',
  description: 'Get one published script version by its concrete id (not a name@version reference).',
  handler: (ctx, { id }) => {
    const script = ctx.scripts.get(id)
    if (!script) throw new EnkakuError('script_not_found', `no such script: ${id}`)
    // Plan 97 §4.4, §4.7 — `ScriptDetail.resultSchema` now carries the real
    // stored value (or `null` for a pre-plan-97/undeclared row). Reconciled
    // the same way `scripts/routes.ts`'s `GET /:id` reconciles its own raw
    // `unknown`-typed JSON column against `JsonSchemaNodeSchema` — not a
    // bypass of validation, since `ScriptDetailSchema` above still Zod-checks
    // it on the way out.
    return Promise.resolve({ ...script, resultSchema: script.resultSchema as JsonSchemaNode | null })
  },
})

/**
 * Plan 110 §3.2, §5 step 110.3 — a published script's name is
 * `<plugin>/<script>`, because a script cannot exist outside a plugin. The
 * plugin half is `definePlugin`'s own id shape; the script half additionally
 * allows `.`/`_`, which a recording's name may contain (`plugins/owner.ts`).
 *
 * Expressed in the INPUT SCHEMA and not only in the writer's refusal because
 * this capability is what the AI agent and MCP call: the schema is the tool
 * description a model reads before it writes anything, so the requirement has
 * to be visible there, not discovered from an error after a build.
 */
const MEMBER_NAME_SHAPE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/

const PublishFields = {
  name: z
    .string()
    .min(1)
    .regex(
      MEMBER_NAME_SHAPE,
      'a script is published as "<plugin>/<script>" — a script cannot exist outside a plugin (plan 110 §3.2). Write the entry as definePlugin({ id, version, scripts: [ … ] }) and publish it as "<that id>/<the member id>".',
    ),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  paramsSchema: z.unknown().optional(),
  /** Plan 97 §4.4, §4.7 — mirrors `paramsSchema` above exactly. */
  resultSchema: z.unknown().optional(),
}

/**
 * Two input forms (plan 64 §3.5, §4.4): a pre-built bundle (what `enkaku
 * publish` has always sent, on the AUTHOR'S own machine), or a workspace
 * `path` — the core bundles that one itself, under `scripts/build.ts`'s
 * constraints (import allowlist, no filesystem resolution, bounded, never
 * executed). Both end up calling the SAME `ctx.scripts.publish`, so the two
 * forms cannot produce a script that differs in anything but where the
 * bundle came from (plan 64 acceptance #7).
 */
const PublishInput = z.union([
  z.object({ ...PublishFields, bundle: z.string().min(1), source: z.string().optional() }),
  z.object({ ...PublishFields, path: z.string() }),
])

export const scriptPublish = defineCapability({
  id: 'script.publish',
  input: PublishInput,
  output: z.object({ id: z.string(), name: z.string(), version: z.string() }),
  permission: 'script.publish',
  // A bundle-form publish is fast; a path-form publish also bundles server-side,
  // bounded at 30s by `scripts/build.ts` — this deadline has to cover both.
  deadline: 40_000,
  effect: 'write',
  description:
    'Publish a new version of a PLUGIN member, either from a pre-built bundle or from a workspace path (which the core bundles itself). `name` must be "<plugin>/<script>": a script cannot exist outside a plugin, so write the entry as definePlugin({ id, version, scripts: [ … ] }) — the owning plugin is created on first publish and the script is published as a member of it. (name, version) must be unique — publishing an existing pair refuses with script_version_exists. A plugin published as a verified package (POST /api/plugins) cannot gain a member this way; add it to that plugin\'s bundle and republish the plugin. Importing anything outside @enkaku/sdk, zod, or another workspace path fails the build and publishes nothing.',
  handler: async (ctx, input) => {
    if ('path' in input) {
      const { bundle, source } = await buildScriptFromWorkspace(ctx.workspace, input.path)
      return ctx.scripts.publish({
        name: input.name,
        version: input.version,
        bundle,
        source,
        paramsSchema: input.paramsSchema,
        resultSchema: input.resultSchema,
      })
    }
    return ctx.scripts.publish(input)
  },
})

export const SCRIPT_CAPABILITIES = [scriptList, scriptGet, scriptPublish]
