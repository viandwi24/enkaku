import type { ActionSpec, NavEntry, PluginSurface, PluginSurfaceOrigin, PluginUiEntry, ViewSpec } from '@enkaku/protocol'
import type { PluginRuntime } from './runtime'

/**
 * Which screens are LIVE right now, and where each one came from (plan 108
 * §3.5, §4.5, §5 step 108.6) — the merge point between the two places a
 * surface can come from, exactly as `scripts/registry.ts` is the merge point
 * for the two places a script can come from.
 *
 * Two rules, both borrowed rather than invented:
 *
 * 1. **Active plugins and dev slots only.** Never `staged` (verified but not
 *    switched on), never `failed` (§3.9: contributes nothing, disturbs
 *    nothing), never `superseded` (its pinned script refs still resolve, but
 *    it is not what the operator is looking at), never `disabled`. Criterion 6.
 * 2. **A dev slot of the same name WINS**, and wins totally — including when
 *    the dev build declares no surface at all, in which case the published
 *    plugin's screen disappears while the slot is held. This is the same
 *    precedent plan 82 §3.5 set for a dev SCRIPT shadowing a published one:
 *    what the operator is running is the dev build, and a sidebar entry that
 *    silently belonged to a different build than the scripts behind it would
 *    be the worst of both.
 *
 * Everything here is a read. Nothing caches: `runtime.surface()` re-validates
 * the stored manifest on every call (its own doc comment says why), and a dev
 * slot is an in-memory object that a rebuild replaces wholesale.
 */

/** One live surface, with the provenance every caller needs to say `DEV` — or to refuse. */
export interface ResolvedSurface {
  plugin: string
  /** The active version, or a dev slot's `buildVersion` (`1.2.0+dev.3`). */
  version: string
  origin: PluginSurfaceOrigin
  surface: PluginSurface
}

/** `GET /:name/view/:viewId`'s answer — the view, plus ONLY the actions it names. */
export interface ResolvedView {
  plugin: string
  version: string
  origin: PluginSurfaceOrigin
  viewId: string
  view: ViewSpec
  actions: Record<string, ActionSpec>
}

export interface SurfaceRegistry {
  /** Every live nav contribution, plugin name ascending. A surface with no nav entry is absent, not present-and-empty. */
  ui(): PluginUiEntry[]
  /** The live surface for one plugin name, dev slot first. `null` when the plugin is neither active nor holds a slot, and when it is live but declares no screen. */
  resolve(pluginName: string): ResolvedSurface | null
  /** One view of one plugin. `null` when the surface is not live; `undefined`-style "no such view" is reported by `viewExists` being false in the caller's 404. */
  resolveView(pluginName: string, viewId: string): ResolvedView | null
}

/**
 * The shadow rule of §3.5, applied once. Exported (rather than folded into
 * `createSurfaceRegistry`) because `action-executor.ts` must apply the SAME
 * precedence when it looks an action up: a screen rendered from the dev
 * build's surface whose buttons executed the PUBLISHED build's actions would
 * be a genuinely confusing failure, and the only defence against it is that
 * both go through this one function.
 *
 * Reads `runtime.surface(name)` for the published half rather than touching
 * `plugins.manifest` itself — that method is the one place a stored manifest
 * is re-validated, and a second reader would be a second thing to keep in
 * step with the vocabulary.
 */
export function resolvePluginSurface(runtime: PluginRuntime, pluginName: string): ResolvedSurface | null {
  const slot = runtime.devSlots().find((s) => s.pluginName === pluginName)
  if (slot) {
    // The dev slot wins whether or not it HAS a surface — see rule 2 above.
    return slot.surface ? { plugin: pluginName, version: slot.buildVersion, origin: 'dev', surface: slot.surface } : null
  }
  const surface = runtime.surface(pluginName)
  if (!surface) return null
  const row = runtime.active(pluginName)
  if (!row) return null
  return { plugin: pluginName, version: row.version, origin: 'plugin', surface }
}

/** The actions ONE view references, deduplicated, in declaration order (toolbar first, then row actions). */
function actionsFor(surface: PluginSurface, view: ViewSpec): Record<string, ActionSpec> {
  const out: Record<string, ActionSpec> = {}
  for (const id of [...view.toolbar, ...view.rowActions]) {
    if (Object.hasOwn(out, id)) continue
    // `validatePluginSurface` already refused a surface naming an action it
    // does not declare, at verify and again on read — so a miss here is not
    // reachable through a verified manifest. Skipped rather than thrown
    // anyway: this is on the way to rendering a page, and one dangling id
    // must cost that button, never the whole screen (§3.8's discipline).
    if (!Object.hasOwn(surface.actions, id)) continue
    const action = surface.actions[id]
    if (action) out[id] = action
  }
  return out
}

export function createSurfaceRegistry(deps: { runtime: PluginRuntime }): SurfaceRegistry {
  const { runtime } = deps

  const resolve = (pluginName: string): ResolvedSurface | null => resolvePluginSurface(runtime, pluginName)

  return {
    ui() {
      const items: PluginUiEntry[] = []
      const shadowed = new Set<string>()

      for (const slot of runtime.devSlots()) {
        // Recorded as shadowed even when the slot declares no surface, so the
        // published plugin's nav does not reappear underneath it.
        shadowed.add(slot.pluginName)
        if (!slot.surface || slot.surface.nav.length === 0) continue
        const nav: NavEntry[] = slot.surface.nav
        items.push({ plugin: slot.pluginName, version: slot.buildVersion, origin: 'dev', nav })
      }

      for (const row of runtime.list()) {
        if (row.status !== 'active') continue
        if (shadowed.has(row.name)) continue
        shadowed.add(row.name)
        const surface = runtime.surface(row.name)
        if (!surface || surface.nav.length === 0) continue
        items.push({ plugin: row.name, version: row.version, origin: 'plugin', nav: surface.nav })
      }

      return items.sort((a, b) => a.plugin.localeCompare(b.plugin))
    },

    resolve,

    resolveView(pluginName, viewId) {
      const resolved = resolve(pluginName)
      if (!resolved) return null
      if (!Object.hasOwn(resolved.surface.views, viewId)) return null
      const view = resolved.surface.views[viewId]
      if (!view) return null
      return {
        plugin: resolved.plugin,
        version: resolved.version,
        origin: resolved.origin,
        viewId,
        view,
        actions: actionsFor(resolved.surface, view),
      }
    },
  }
}
