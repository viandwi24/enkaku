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
})

export const scriptList = defineCapability({
  id: 'script.list',
  input: z.object({}),
  output: z.object({ items: z.array(ScriptGroupSchema) }),
  permission: 'script.view',
  lease: 'none',
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
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description: 'Get one published script version by its concrete id (not a name@version reference).',
  handler: (ctx, { id }) => {
    const script = ctx.scripts.get(id)
    if (!script) throw new EnkakuError('script_not_found', `no such script: ${id}`)
    return Promise.resolve(script)
  },
})

const PublishFields = { name: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/), paramsSchema: z.unknown().optional() }

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
  lease: 'none',
  // A bundle-form publish is fast; a path-form publish also bundles server-side,
  // bounded at 30s by `scripts/build.ts` — this deadline has to cover both.
  deadline: 40_000,
  effect: 'write',
  description:
    'Publish a new script version, either from a pre-built bundle or from a workspace path (which the core bundles itself). (name, version) must be unique — publishing an existing pair refuses with script_version_exists. Importing anything outside @enkaku/sdk, zod, or another workspace path fails the build and publishes nothing.',
  handler: async (ctx, input) => {
    if ('path' in input) {
      const { bundle, source } = await buildScriptFromWorkspace(ctx.workspace, input.path)
      return ctx.scripts.publish({ name: input.name, version: input.version, bundle, source, paramsSchema: input.paramsSchema })
    }
    return ctx.scripts.publish(input)
  },
})

export const SCRIPT_CAPABILITIES = [scriptList, scriptGet, scriptPublish]
