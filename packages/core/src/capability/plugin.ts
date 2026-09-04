import { PluginStatusSchema, VerifyReportSchema } from '@enkaku/protocol'
import { z } from 'zod'
import { buildScriptFromWorkspace } from '../scripts/build'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

const StageFields = {
  /** `definePlugin({ id })`'s own shape; the verify child checks the bundle declares the same id. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a plugin id is lowercase letters, digits and dashes, starting with a letter or a digit'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  /** Stage without verifying in the same call (`POST /api/plugins`'s `stageOnly`). Default false. */
  stageOnly: z.boolean().default(false),
}
const StageInput = z.union([
  z.object({ ...StageFields, bundle: z.string().min(1), source: z.string().optional() }),
  z.object({ ...StageFields, path: z.string() }),
])

export const pluginStage = defineCapability({
  id: 'plugin.stage',
  input: StageInput,
  output: z.object({ id: z.string(), name: z.string(), version: z.string(), status: PluginStatusSchema, verify: VerifyReportSchema.optional() }),
  permission: 'script.publish',
  // No `activity` field: this capability touches no device (plan 205 §4.4).
  deadline: 120_000, // 30 s bundling (scripts/build.ts) plus the verify child (plugins/verify-child.ts)
  effect: 'write',
  description:
    'Stage a plugin package on the farm and verify it, the same as POST /api/plugins. `name` is the plugin id and `version` its semver; send a pre-built `bundle` (with optional `source`) or a workspace `path` to an entry whose default export is definePlugin({ id, version, scripts: [ … ] }), which the core bundles itself under the same limits as a dev slot. Returns the staged id and status, plus the verify report unless stageOnly is true. Activation is a separate step (POST /api/plugins/:id/activate). A script cannot be published on its own: this is the only way code reaches the farm.',
  handler: async (ctx, input) => {
    const port = ctx.plugins()
    if (!port) throw new EnkakuError('E_NOT_SUPPORTED', 'this host cannot stage plugins (orchestrator mode)')
    const built = 'path' in input ? await buildScriptFromWorkspace(ctx.workspace, input.path) : { bundle: input.bundle, source: input.source }
    const staged = await port.stage({ name: input.name, version: input.version, bundle: built.bundle, source: built.source, createdBy: ctx.actor?.id ?? null })
    if (input.stageOnly) return { id: staged.id, name: staged.name, version: staged.version, status: PluginStatusSchema.parse(staged.status) }
    const verify = await port.verify(staged.id)
    const fresh = port.get(staged.name, staged.version)
    return { id: staged.id, name: staged.name, version: staged.version, status: PluginStatusSchema.parse(fresh?.status ?? staged.status), verify }
  },
})

export const PLUGIN_CAPABILITIES = [pluginStage]
