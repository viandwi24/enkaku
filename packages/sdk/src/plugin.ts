import type { z } from 'zod'
import type { ScriptDefinition } from './types'

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * A script authored to live inside a plugin (plan 82 §3.6, §4.1). Everything
 * a standalone `ScriptDefinition` has, EXCEPT `version` — a plugin member
 * does not carry its own version; `definePlugin` stamps the plugin's own
 * version onto every member (a member MAY declare one, but only to assert
 * "this had better match the plugin's", never to diverge from it).
 *
 * This type is declared here, as `Omit<ScriptDefinition<S>, 'version'> &
 * { version?: string }`, rather than by editing `ScriptDefinition` itself in
 * `types.ts` to make `version` optional there. `types.ts` is out of bounds
 * for this change (a concurrent plan owns it in this pass) — but the
 * intended shape is exactly the same either way: `defineScript`'s output
 * (full `ScriptDefinition`, version required) is untouched for a standalone
 * script; a plugin member is authored as a plain object against this looser
 * type instead of going through `defineScript` at all, and `definePlugin`
 * below stamps a real `version` onto it before anything downstream ever
 * sees it — so every `ScriptDefinition` that leaves this module, in a
 * plugin or not, still has a required, validated, semver `version`.
 */
export type PluginMemberScript<S extends z.ZodTypeAny = z.ZodTypeAny> = Omit<ScriptDefinition<S>, 'version'> & {
  /** Optional — must equal the plugin's own version when given (plan 82 §3.6). Omit it; `definePlugin` fills it in. */
  version?: string
  /**
   * Human-readable member metadata. The farm does NOT surface these yet: the
   * verify child reports only `{ id, paramsSchema }` per member
   * (`verify-child-entry.ts`), so unlike the PLUGIN-level `title`/`description`
   * — which do reach the `plugins` row — these stay inside the bundle. They are
   * typed because authors reasonably write them (both example packs do), and so
   * that plumbing them through later needs no change on the authoring side.
   */
  title?: string
  description?: string
}

export interface PluginDefinition {
  /** `[a-z0-9][a-z0-9-]*` — the KV namespace (plan 79 §3.2) and half of every member's `plugin/script` ref. */
  id: string
  /** Semver — stamped onto every member script (plan 82 §3.6). */
  version: string
  title?: string
  description?: string
  scripts: PluginMemberScript[]
  /** Merged with each script's own `reset.packages` at the runner (plan 82 §3.10). */
  reset?: { packages?: string[] }
}

/**
 * The `scripts` array as the AUTHOR writes it, one schema type per member.
 *
 * `PluginDefinition.scripts` is `PluginMemberScript[]` — i.e. `PluginMemberScript<z.ZodTypeAny>[]`
 * — which erases each member's own params schema, leaving `ctx.params` as `unknown` inside every
 * `run`. That is the asymmetry this fixes: `defineScript<S>` infers a standalone script's params,
 * so a plugin member should infer its own too. The homomorphic mapped type below is what makes
 * TypeScript infer `S[K]` per element instead of collapsing the array to its constraint.
 */
type PluginMemberScripts<S extends readonly z.ZodTypeAny[]> = { [K in keyof S]: PluginMemberScript<S[K]> }

/** `definePlugin`'s return: every member has been stamped with a real, required `version` — a genuine `ScriptDefinition[]`. */
export interface Plugin extends Omit<PluginDefinition, 'scripts'> {
  scripts: ScriptDefinition[]
}

/**
 * No side effects beyond validation, a stamp, and a freeze — matching
 * `defineScript`'s own contract (plan 82 §4.1). Throws on the author's own
 * machine, at import time, never on the farm:
 *
 * - `id` must match `[a-z0-9][a-z0-9-]*`.
 * - `version` must be semver.
 * - at least one script.
 * - every member's `id` is unique within the plugin.
 * - a member that declares its own `version` must match the plugin's
 *   exactly — a silent divergence would be unverifiable (plan 82 §3.6).
 */
export function definePlugin<const S extends readonly z.ZodTypeAny[]>(
  def: Omit<PluginDefinition, 'scripts'> & { scripts: PluginMemberScripts<S> },
): Plugin {
  if (!ID_SHAPE.test(def.id)) {
    throw new Error(`definePlugin: \`id\` must match ${ID_SHAPE} , got "${def.id}"`)
  }
  if (!SEMVER.test(def.version)) {
    throw new Error(`definePlugin: \`version\` must be semver, got "${def.version}"`)
  }
  if (!Array.isArray(def.scripts) || def.scripts.length === 0) {
    throw new Error('definePlugin: `scripts` must be a non-empty array')
  }

  const seen = new Set<string>()
  for (const s of def.scripts) {
    if (!s.id || s.id.trim().length === 0) {
      throw new Error('definePlugin: every script needs an `id`')
    }
    if (seen.has(s.id)) {
      throw new Error(`definePlugin: duplicate script id "${s.id}" within plugin "${def.id}"`)
    }
    seen.add(s.id)
    if (s.version !== undefined && s.version !== def.version) {
      throw new Error(
        `definePlugin: script "${s.id}" declares version "${s.version}", which does not match the plugin's own "${def.version}" — a plugin member cannot carry its own version (plan 82 §3.6)`,
      )
    }
    if (typeof s.run !== 'function') {
      throw new Error(`definePlugin: script "${s.id}" — \`run\` must be a function`)
    }
    if (!s.params || typeof (s.params as { safeParse?: unknown }).safeParse !== 'function') {
      throw new Error(`definePlugin: script "${s.id}" — \`params\` must be a Zod schema`)
    }
  }

  const scripts: ScriptDefinition[] = def.scripts.map((s) => Object.freeze({ ...s, version: def.version }) as ScriptDefinition)

  return Object.freeze({ ...def, scripts })
}

/** True for a `definePlugin()` result (a `scripts` array) as opposed to a standalone `ScriptDefinition` (a `run` function) — the check `child-entry.ts`'s loader makes (plan 82 §3.2). */
export function isPlugin(def: unknown): def is Plugin {
  return !!def && typeof def === 'object' && Array.isArray((def as { scripts?: unknown }).scripts)
}
