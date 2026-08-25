import { z } from 'zod'
import { DevSlotViewSchema, PluginListItemSchema, type DevSlotView, type PluginListItem } from '@enkaku/protocol'

/**
 * `GET /api/plugins`, plus the grouping and the search this screen and the
 * plugin detail page both read it through. Pure data — no React, so both
 * pages agree on what "one plugin" and "matches the search" mean by
 * construction rather than by two copies staying in step.
 *
 * ---------------------------------------------------------------------------
 * THE LIST ROW AND THE FULL ROW ARE NO LONGER THE SAME TYPE
 * ---------------------------------------------------------------------------
 *
 * This file used to re-export `PluginRowSchema` under a local alias, so the
 * Plugins tab and the plugin detail page shared one type and one fetch. Plan
 * 126 (§3.2, step 126.2) split them, and the reason is size: the list is a list
 * of VERSIONS, and a farm that has published repeatedly carries 20+ rows for one
 * plugin name. Everything on the row is paid for once per row, and the two
 * heaviest members — every declared member's JSON Schemas, and the plugin's
 * whole declared SCREEN — were rendered by nothing on this screen.
 *
 * So `GET /api/plugins` now answers `PluginListItem`: the row's identity, its
 * live `scriptCount`, and the manifest projected down to `declaredScripts`
 * (id + title, the search index and the declared count) and `hasService` (one
 * chip). A page that needs the manifest itself — the detail page's Screen and
 * Service cards — reads ONE version through `GET /api/plugins/:name/:version`,
 * which is the request that is actually scoped to what an operator opened.
 */

/**
 * The list row. Named for what it is rather than kept as
 * `PluginRowWithServiceSchema`, whose name recorded a protocol gap that no
 * longer exists (`PluginManifestSchema` declares `service` now) and which read
 * as "a full row, plus something" — the opposite of what it is.
 */
export const PluginListRowSchema = PluginListItemSchema
export type PluginListRow = PluginListItem

/** `GET /api/plugins` and `GET /api/plugins?name=<name>` — the same envelope, filtered server-side. */
export const PluginsListSchema = z.object({
  items: z.array(PluginListRowSchema),
  dev: z.array(DevSlotViewSchema),
})

/**
 * ONE GROUP PER PLUGIN NAME, not per version — the shape the table has used
 * since a plugin iterated on during a session filled the page with eight
 * near-identical `tiktok` lines.
 */
export interface PluginGroup {
  name: string
  /** Newest first, so `[0]` is what `@latest` resolves to. */
  versions: PluginListRow[]
  /** The group is failed when its NEWEST version failed — that is the one a fresh install resolves to. */
  failed: boolean
}

export function groupPlugins(items: readonly PluginListRow[]): PluginGroup[] {
  const byName = new Map<string, PluginListRow[]>()
  for (const p of items) {
    const list = byName.get(p.name) ?? []
    list.push(p)
    byName.set(p.name, list)
  }
  return [...byName.entries()]
    .map(([name, versions]) => {
      const sorted = [...versions].sort((a, b) => b.version.localeCompare(a.version))
      return { name, versions: sorted, failed: sorted[0]?.status === 'failed' }
    })
    .sort((a, b) => {
      // Failed first — the page's own job (plan 82 §4.6).
      if (a.failed !== b.failed) return a.failed ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

/**
 * The version a group POINTS AT by default: the live one when there is one,
 * otherwise the newest. Shared by the row and the detail page so a link from
 * one lands on what the other was showing.
 */
export function defaultVersion(group: PluginGroup): PluginListRow | undefined {
  return group.versions.find((v) => v.status === 'active') ?? group.versions[0]
}

/** Every member script id any version of this plugin declared, deduplicated, in declaration order. */
export function declaredScriptIds(group: PluginGroup): string[] {
  const ids: string[] = []
  for (const v of group.versions) {
    for (const s of v.declaredScripts) if (!ids.includes(s.id)) ids.push(s.id)
  }
  return ids
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

export interface PluginMatch {
  group: PluginGroup
  /**
   * The member script ids that matched when the plugin's own identity did
   * NOT — i.e. the reason a row is on screen that the row would otherwise not
   * explain. Empty when the plugin matched by its own name/title/description.
   */
  viaScripts: string[]
}

/**
 * What the Plugins tab's search covers, and the whole of it: a plugin's
 * identifier, its human title, its description, any of its published version
 * strings, and **the ids and titles of the scripts it registers**.
 *
 * That last one is the case worth being explicit about — "which plugin does
 * `auto-scroll` come from" is a real question, and `declaredScripts` is on the
 * row already, so it costs no extra fetch. It is the whole reason that field
 * survived plan 126's projection while the rest of the manifest did not: the
 * search index needs an id and a title per member, and nothing on this screen
 * needs the JSON Schemas that used to travel with them.
 *
 * Its one limit, stated on the screen rather than hidden here: a FAILED plugin
 * whose bundle never got far enough to report a manifest has no member list at
 * all, so it can only be found by its own name.
 */
export function searchPlugins(groups: readonly PluginGroup[], query: string): PluginMatch[] {
  const q = norm(query)
  if (!q) return groups.map((group) => ({ group, viaScripts: [] }))
  const out: PluginMatch[] = []
  for (const group of groups) {
    const identity = [
      group.name,
      ...group.versions.map((v) => v.title ?? ''),
      ...group.versions.map((v) => v.description ?? ''),
      ...group.versions.map((v) => v.version),
    ]
    const identityHit = identity.some((s) => norm(s).includes(q))
    const viaScripts: string[] = []
    for (const v of group.versions) {
      for (const s of v.declaredScripts) {
        if (viaScripts.includes(s.id)) continue
        if (norm(s.id).includes(q) || norm(s.title ?? '').includes(q)) viaScripts.push(s.id)
      }
    }
    if (identityHit) out.push({ group, viaScripts: [] })
    else if (viaScripts.length > 0) out.push({ group, viaScripts })
  }
  return out
}

/** The same predicate over a dev slot — its plugin name, its build version, and the scripts it exports. */
export function devSlotMatches(slot: DevSlotView, query: string): boolean {
  const q = norm(query)
  if (!q) return true
  if (norm(slot.pluginName).includes(q)) return true
  if (norm(slot.buildVersion).includes(q)) return true
  return slot.scripts.some((s) => norm(s.exportId).includes(q))
}

/**
 * What the Scripts tab's search covers: the script's full name — which is
 * always `<plugin>/<script>`, so the plugin half is searchable without a
 * separate field — and the version `@latest` currently resolves to.
 */
export function scriptMatches(row: { name: string; latestVersion: string }, query: string): boolean {
  const q = norm(query)
  if (!q) return true
  return norm(row.name).includes(q) || norm(row.latestVersion).includes(q)
}
