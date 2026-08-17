import type { z } from 'zod'
import { validatePluginSurface, type PluginSurface, type PluginSurfaceInput } from '@enkaku/protocol'
import { foldRuntimeEnvelope } from './runtime-fold'
import type { ScriptDefinition } from './types'

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * A script (plan 82 §3.6, §4.1). Since plan 110 §4.2 this is the ONLY shape a
 * script is ever authored in — there is no `defineScript` any more, because a
 * script cannot exist outside a plugin. Everything
 * `ScriptDefinition` has, EXCEPT `version`: a plugin member does not carry
 * its own version; `definePlugin` stamps the plugin's own version onto every
 * member (a member MAY declare one, but only to assert "this had better match
 * the plugin's", never to diverge from it).
 *
 * This type is declared here, as `Omit<ScriptDefinition<S>, 'version'> &
 * { version?: string }`, rather than by making `version` optional on
 * `ScriptDefinition` itself in `types.ts`: `ScriptDefinition` is what a member
 * BECOMES on the way out of `definePlugin` below, once a real `version` has
 * been stamped onto it — so every `ScriptDefinition` that leaves this module
 * still has a required, validated, semver `version`, and every consumer
 * downstream (the runner included) can keep relying on that.
 *
 * The second type parameter `R` (plan 97 §3.2, §4.2, §5 step 97.8) mirrors
 * `ScriptDefinition`'s own — a member declaring `result` gets an author-time
 * check that `run` returns the declared shape (H1). Defaults to `undefined`,
 * exactly like `ScriptDefinition` itself: a member declaring no `result` is
 * unaffected.
 */
export type PluginMemberScript<S extends z.ZodTypeAny = z.ZodTypeAny, R extends z.ZodTypeAny | undefined = undefined> = Omit<
  ScriptDefinition<S, R>,
  'version'
> & {
  /** Optional — must equal the plugin's own version when given (plan 82 §3.6). Omit it; `definePlugin` fills it in. */
  version?: string
  /**
   * Human-readable member metadata, reported by the verify child alongside
   * `{ id, paramsSchema, resultSchema, runtime }` and persisted into the
   * plugin's manifest (plan 108 §0.2 P8, step 108.3) — so a screen naming a
   * script shows what the author wrote rather than its bare id. Before that
   * step these were typed but discarded at the verify boundary, which is why
   * both shipped packs already write them.
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
  /**
   * The screens this plugin contributes to Studio (plan 108 §4.1) — a
   * sidebar entry, a table or a frame, and the actions they invoke. Wholly
   * optional: a plugin omitting it is unaffected in every way, and nothing
   * downstream of `definePlugin` behaves differently for one.
   *
   * Validated at import time on the AUTHOR's machine by `definePlugin`
   * below, through the same `validatePluginSurface` the verify child and
   * the parent's independent re-check run (§3.9) — so a defect that would
   * fail verification on the farm fails here first, before any network
   * call.
   *
   * Typed as `PluginSurfaceInput`, the surface as an AUTHOR writes it, not
   * the parsed `PluginSurface` every consumer reads: the two differ only in
   * that every defaulted field (`width`, `selectable`, `rows`, `device`, …)
   * is optional here. `definePlugin`'s RETURN carries the parsed form —
   * see `Plugin` below.
   */
  surface?: PluginSurfaceInput
}

/**
 * The `scripts` array as the AUTHOR writes it, one schema type per member.
 *
 * `PluginDefinition.scripts` is `PluginMemberScript[]` — i.e. `PluginMemberScript<z.ZodTypeAny>[]`
 * — which erases each member's own params schema, leaving `ctx.params` as `unknown` inside every
 * `run`. The homomorphic mapped type below is what makes
 * TypeScript infer `S[K]` per element instead of collapsing the array to its constraint.
 *
 * `result`'s own type (plan 97 §3.2, §5 step 97.8) is deliberately NOT
 * threaded through this same per-element inference — a second, independent
 * `readonly (z.ZodTypeAny | undefined)[]` array cannot be reverse-inferred
 * alongside `S` from the SAME array argument (tried; `tsc` silently falls
 * back to the constraint and every member's `result` collapses to
 * `undefined` — a real limit of TypeScript's homomorphic-mapped-type
 * inference, not a mistake in the attempt). Each element's `result` type is
 * instead left as the WIDE `z.ZodTypeAny | undefined` here — H1 for a
 * plugin member is proven at the member's own `const` DECLARATION site
 * instead (`const foo: PluginMemberScript<typeof params, typeof result> =
 * {...}`, exactly how `switch-account.ts`/`search-follow.ts` already
 * declare their members), where a plain generic-annotated assignment checks
 * `run`'s return against the CONCRETE `R`, not this array's necessarily
 * loosened one — see `plugin-result.type-test.ts`.
 */
type PluginMemberScripts<S extends readonly z.ZodTypeAny[]> = {
  [K in keyof S]: PluginMemberScript<S[K], z.ZodTypeAny | undefined>
}

/**
 * `definePlugin`'s return: every member has been stamped with a real,
 * required `version` — a genuine `ScriptDefinition[]` — and `surface`, when
 * the author declared one, has been through `validatePluginSurface`, so it
 * is the PARSED form with every default applied (plan 108 §4.1). Both
 * fields are narrowed on the way out for the same reason: what leaves this
 * module is canonical, whatever shorthand the author was allowed on the way
 * in.
 */
export interface Plugin extends Omit<PluginDefinition, 'scripts' | 'surface'> {
  scripts: ScriptDefinition[]
  surface?: PluginSurface
}

/**
 * No side effects beyond validation, a stamp, and a freeze (plan 82 §4.1) —
 * all orchestration (phases, timeouts, retries) belongs to the core's runner,
 * so a plugin published with an older SDK keeps working on a newer core.
 * Throws on the author's own machine, at import time, never on the farm:
 *
 * - `id` must match `[a-z0-9][a-z0-9-]*`.
 * - `version` must be semver.
 * - at least one script.
 * - every member's `id` is unique within the plugin.
 * - a member that declares its own `version` must match the plugin's
 *   exactly — a silent divergence would be unverifiable (plan 82 §3.6).
 * - `surface`, when present, passes `validatePluginSurface` (plan 108 §4.1)
 *   — unknown keys, a nav entry naming a missing view, an action reference
 *   naming a missing action, a duplicate nav id, an unknown icon, and every
 *   cap. It is the SAME function the farm runs at verify, so the author
 *   cannot publish a surface that passes here and fails there.
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
  // Plan 108 §4.1 — the author-time half of §3.9's "the parent re-validates
  // independently". One function, run in both places, so the two can never
  // disagree about what is wrong with a surface. Every defect is reported
  // at once rather than one per run: an author fixing four columns should
  // not need four import cycles to find them.
  let surface: PluginSurface | undefined
  if (def.surface !== undefined) {
    const checked = validatePluginSurface(def.surface)
    if (!checked.ok) {
      throw new Error(`definePlugin: surface — ${checked.errors.join('; ')}`)
    }
    surface = checked.value
  }

  const seen = new Set<string>()
  // Plan 98 §4.2 — the `timeout`/`retries` ⇒ `runtime` fold, per member.
  // Since plan 110 removed `defineScript` this is the ONLY place that fold
  // happens for any script at all (`runtime-fold.ts`). Computed in this
  // validation pass (which already throws on the author's own machine, at
  // import time, for every other per-member defect) and applied in the
  // `.map()` below, keyed by id since ids are already known unique here.
  const runtimeById = new Map<string, ReturnType<typeof foldRuntimeEnvelope>>()
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
    // Plan 97 §3.2, §4.2, §5 step 97.8 — `result` is
    // validated the same way `params` just above is, only when present — an
    // output schema is optional and always optional (plan 97 §1, criterion 1).
    if (s.result !== undefined && typeof (s.result as { safeParse?: unknown }).safeParse !== 'function') {
      throw new Error(`definePlugin: script "${s.id}" — \`result\`, when present, must be a Zod schema`)
    }
    runtimeById.set(s.id, foldRuntimeEnvelope(s, `definePlugin: script "${s.id}" (plugin "${def.id}")`))
  }

  const scripts: ScriptDefinition[] = def.scripts.map((s) => {
    const runtime = runtimeById.get(s.id)
    return Object.freeze({ ...s, version: def.version, ...(runtime !== undefined ? { runtime } : {}) }) as ScriptDefinition
  })

  // The authored `surface` is dropped from the spread and re-added only
  // when there was one, so a plugin that declared none carries no `surface`
  // key at all (rather than one holding `undefined`, which would show up in
  // `Object.keys` and in anything that walks the definition) — and one that
  // did carries the PARSED value, never the shorthand it was written as.
  const { surface: authoredSurface, ...rest } = def
  void authoredSurface
  return Object.freeze({ ...rest, scripts, ...(surface !== undefined ? { surface } : {}) })
}

/**
 * True for a `definePlugin()` result (a `scripts` array) as opposed to any
 * other default export, a bare `ScriptDefinition`-shaped object included (a
 * `run` function, no `scripts`) — the check `child-entry.ts`'s loader makes
 * (plan 82 §3.2) and the check `enkaku publish`/`enkaku dev` refuse on
 * (plan 110 §4.2).
 */
export function isPlugin(def: unknown): def is Plugin {
  return !!def && typeof def === 'object' && Array.isArray((def as { scripts?: unknown }).scripts)
}
