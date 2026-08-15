import type { z } from 'zod'
import { foldRuntimeEnvelope } from './runtime-fold'
import type { ScriptDefinition } from './types'

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * No side effects — shape validation and a freeze, nothing more. All
 * orchestration (phases, timeouts, retries) belongs to the core's runner, so
 * a script published with an older SDK keeps working on a newer core.
 *
 * `timeout`/`retries` are folded into `runtime` here (plan 98 §4.2) — after
 * this call, `def.runtime` is the single, complete source of both, whether
 * the author wrote the deprecated top-level fields, the new `runtime`
 * object, or a combination that agrees. A combination that DISAGREES throws
 * (`foldRuntimeEnvelope`), before this script ever leaves the author's
 * machine.
 *
 * The second type parameter `R` (plan 97 §3.2, §4.2, fixes F1/F2, tests H1)
 * is declared here — not just on `ScriptDefinition` itself — SPECIFICALLY so
 * it is inferred from the `def` argument at the author's own call site: a
 * definition with no `result` field never supplies an inference site for
 * `R`, so it falls back to its default, `undefined`, and `run`'s return
 * type is `Promise<unknown>` exactly as before this plan. A definition that
 * does declare `result: someSchema` infers `R` as that schema's type, which
 * is what turns a wrong `run` return value into a compile error before this
 * function's own runtime check ever runs — see `result.type-test.ts`.
 *
 * `result` itself is validated the same way `params` already is (`:23-25`
 * below): a Zod schema when present, and no error at all when absent — an
 * output schema is optional and always optional (plan 97 §1, criterion 1).
 */
export function defineScript<S extends z.ZodTypeAny, R extends z.ZodTypeAny | undefined = undefined>(
  def: ScriptDefinition<S, R>,
): ScriptDefinition<S, R> {
  if (!def.id || def.id.trim().length === 0) throw new Error('defineScript: `id` is required')
  if (!SEMVER.test(def.version)) throw new Error(`defineScript: \`version\` must be semver, got "${def.version}"`)
  if (typeof def.run !== 'function') throw new Error('defineScript: `run` must be a function')
  if (!def.params || typeof (def.params as { safeParse?: unknown }).safeParse !== 'function') {
    throw new Error('defineScript: `params` must be a Zod schema')
  }
  if (def.result !== undefined && typeof (def.result as { safeParse?: unknown }).safeParse !== 'function') {
    throw new Error('defineScript: `result`, when present, must be a Zod schema')
  }
  const runtime = foldRuntimeEnvelope(def, `defineScript: "${def.id}"`)
  return Object.freeze(runtime !== undefined ? { ...def, runtime } : def)
}
