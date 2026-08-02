import type { z } from 'zod'
import type { ScriptDefinition } from './types'

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * No side effects — shape validation and a freeze, nothing more. All
 * orchestration (phases, timeouts, retries) belongs to the core's runner, so
 * a script published with an older SDK keeps working on a newer core.
 */
export function defineScript<S extends z.ZodTypeAny>(def: ScriptDefinition<S>): ScriptDefinition<S> {
  if (!def.id || def.id.trim().length === 0) throw new Error('defineScript: `id` is required')
  if (!SEMVER.test(def.version)) throw new Error(`defineScript: \`version\` must be semver, got "${def.version}"`)
  if (typeof def.run !== 'function') throw new Error('defineScript: `run` must be a function')
  if (!def.params || typeof (def.params as { safeParse?: unknown }).safeParse !== 'function') {
    throw new Error('defineScript: `params` must be a Zod schema')
  }
  return Object.freeze(def)
}
