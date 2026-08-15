import { and, eq, inArray } from 'drizzle-orm'
import { compareSemver, isPrereleaseVersion, parseScriptRef, type RuntimeEnvelope, type ScriptRef } from '@enkaku/protocol'
import type { Db } from '../db'
import { plugins, scripts, type ScriptKind, type ScriptRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { DevSlot, DevSlotStore } from '../plugins/dev-slots'
import { resolveScriptRef } from './resolve'
import { materializeBundle } from './bundle-cache'
import { parseScriptRuntime } from './service'

/**
 * The single source of truth for "what scripts exist" and "resolve this
 * reference" (plan 82 §3.3) — the merge point between the two places a
 * script can come from: a persisted `scripts` row (standalone or a
 * published plugin member) and an unpublished plugin dev slot
 * (`plugins/dev-slots.ts`). Every consumer that used to read the `scripts`
 * table or call `resolveScriptRef` directly reads through here instead, so
 * a dev script is visible everywhere or nowhere — never "everywhere except
 * the one call site nobody updated" (§3.3's stated failure mode).
 */

export type ScriptOrigin = 'standalone' | 'plugin' | 'dev'

export interface ScriptEntry {
  /** `scripts.id` for a persisted script; `dev:<plugin>/<script>` for a dev one. */
  id: string
  /** `login` for a standalone script, `tiktok/login` for a plugin member (published or dev). */
  name: string
  version: string
  /**
   * Plan 99 §3.1, §4.5 — carried straight from `scripts.kind`; a dev entry
   * (there is no such thing as a dev workflow build) is always `'script'`.
   * `ScriptRegistry.resolve` reads and returns this like any other field —
   * it does not branch on it, which is the containment §3.1 asks for.
   */
  kind: ScriptKind
  origin: ScriptOrigin
  pluginName: string | null
  /** The script's id INSIDE its plugin bundle; null for a standalone script. */
  exportId: string | null
  enabled: boolean
  paramsSchema: unknown
  /**
   * Plan 98 §3.1, §4.4, §5 step 98.4 — the script's own declared execution
   * envelope, pinned exactly as `paramsSchema` is: read straight off the
   * row (or the dev slot) at the moment a job pins this entry, never
   * re-resolved later. `null` for a pre-plan-98 row and for a dev slot whose
   * bundle declared nothing — `resolveRuntime` already treats both
   * identically to "this layer declared nothing" (plan 98 §3.1).
   */
  runtime: RuntimeEnvelope | null
  /** Where the bundle comes from — the executor asks for this, never for a column. */
  bundle: { kind: 'db'; scriptId: string } | { kind: 'file'; path: string }
  /** A dev entry disappears when its session ends; a persisted one does not. */
  ephemeral: boolean
  /** Set only for a dev entry — who owns the slot, for the "which was used" log line (§3.5). */
  devOwner?: string
}

export interface ScriptGroupVersion {
  entryId: string
  version: string
  origin: ScriptOrigin
  enabled: boolean
}

export interface ScriptGroup {
  /** Full name — `checkout`, or `tiktok/login`. */
  name: string
  pluginName: string | null
  /** What `name@latest` resolves to right now; null when nothing does. */
  latestVersion: string | null
  /** Descending by version; a dev build is listed as its own `+dev.N` entry. */
  versions: ScriptGroupVersion[]
  hasDev: boolean
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total: number
}

export interface ScriptRegistry {
  list(q?: { name?: string; pluginName?: string; origin?: ScriptOrigin; limit?: number; cursor?: string | null }): Page<ScriptEntry>
  groups(q?: { pluginName?: string }): ScriptGroup[]
  get(id: string): ScriptEntry | null
  /** Replaces every `resolveScriptRef` call site. Same four errors, plus `script_is_dev`. */
  resolve(ref: ScriptRef, opts?: { allowDev?: boolean }): ScriptEntry
  /** Materialise the bundle to a path the child can import. */
  bundlePath(entry: ScriptEntry): Promise<string>
  /**
   * Drop cached state for one plugin, or all of it. Today the registry
   * holds no cache of its own beyond what `dev-slots.ts` and the bundle
   * file cache already own (both re-read fresh on every call) — this is a
   * deliberate no-op kept as the seam `plugins/runtime.ts` calls after
   * `activate`/`reload`, so a future caching layer has exactly one place
   * to invalidate.
   */
  invalidate(pluginName?: string): void
}

function devEntryId(pluginName: string, exportId: string): string {
  return `dev:${pluginName}/${exportId}`
}

function devEntryFromSlot(slot: DevSlot, exportId: string): ScriptEntry | undefined {
  const s = slot.scripts.find((x) => x.exportId === exportId)
  if (!s) return undefined
  return {
    id: devEntryId(slot.pluginName, exportId),
    name: `${slot.pluginName}/${exportId}`,
    version: slot.buildVersion,
    // A dev slot is always a plugin build; there is no dev workflow (plan 99 §2 non-goals).
    kind: 'script',
    origin: 'dev',
    pluginName: slot.pluginName,
    exportId,
    enabled: true,
    paramsSchema: s.paramsSchema,
    runtime: s.runtime,
    bundle: { kind: 'file', path: slot.bundlePath },
    ephemeral: true,
    devOwner: slot.owner.label,
  }
}

function allDevEntries(devSlots: DevSlotStore): ScriptEntry[] {
  const out: ScriptEntry[] = []
  for (const slot of devSlots.list()) {
    for (const s of slot.scripts) {
      const entry = devEntryFromSlot(slot, s.exportId)
      if (entry) out.push(entry)
    }
  }
  return out
}

function rowToEntry(row: ScriptRow): ScriptEntry {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    // Carried through, never branched on here (plan 99 §3.1's containment
    // claim: comparing this value against 'workflow' belongs only in the
    // three sanctioned files — this is not one of them, and resolve()/get()
    // below do nothing different for either value).
    kind: row.kind,
    origin: row.pluginId ? 'plugin' : 'standalone',
    pluginName: row.pluginId ? row.name.split('/')[0] ?? null : null,
    exportId: row.exportId ?? null,
    enabled: row.enabled ?? true,
    paramsSchema: row.paramsSchema,
    runtime: parseScriptRuntime(row.runtime),
    bundle: { kind: 'db', scriptId: row.id },
    ephemeral: false,
  }
}

/** Splits `tiktok/login` into `{ pluginName: 'tiktok', exportId: 'login' }`; `null` for a name with no slash. */
function splitPluginName(name: string): { pluginName: string; exportId: string } | null {
  const i = name.indexOf('/')
  if (i < 0) return null
  return { pluginName: name.slice(0, i), exportId: name.slice(i + 1) }
}

export function createScriptRegistry(deps: { db: Db; dataDir: string; devSlots: DevSlotStore }): ScriptRegistry {
  const { db, dataDir, devSlots } = deps

  function findDevEntry(name: string, version: string): ScriptEntry | null {
    const split = splitPluginName(name)
    if (!split) return null
    const slot = devSlots.get(split.pluginName)
    if (!slot) return null
    const entry = devEntryFromSlot(slot, split.exportId)
    if (!entry) return null
    if (version === 'latest') return entry
    if (version === slot.declaredVersion || version === slot.buildVersion) return entry
    return null
  }

  function allPersistedRows(): ScriptRow[] {
    return db.select().from(scripts).all()
  }

  /**
   * A plugin can have several versions' `scripts` rows alive at once
   * (`active` plus every `superseded` one, kept exactly so a pinned
   * reference still resolves — §4.4). `resolveScriptRef`'s own `@latest`
   * logic (deliberately unmodified — §3.3) only knows "highest enabled
   * semver", which is wrong here: it would silently pick a `superseded`
   * version's number over the `active` one after a rollback. So a
   * plugin-scoped `@latest` is translated to the ACTIVE plugin's concrete
   * version before ever reaching `resolveScriptRef`; an exact pinned
   * reference is untouched, since any enabled version — active or
   * superseded — is meant to keep resolving.
   */
  function activePluginVersion(pluginName: string): string | null {
    return db.select().from(plugins).where(and(eq(plugins.name, pluginName), eq(plugins.status, 'active'))).get()?.version ?? null
  }

  return {
    list(q) {
      const limit = q?.limit ?? 50
      const persisted = allPersistedRows().map(rowToEntry)
      const dev = allDevEntries(devSlots)
      let all = [...persisted, ...dev]
      if (q?.name) all = all.filter((e) => e.name === q.name)
      if (q?.pluginName) all = all.filter((e) => e.pluginName === q.pluginName)
      if (q?.origin) all = all.filter((e) => e.origin === q.origin)
      all.sort((a, b) => a.name.localeCompare(b.name) || compareSemver(b.version, a.version))
      // Deliberately an in-memory offset cursor, not a real keyset (plan 62
      // §4.4 made the same call for the grouped scripts list): the number of
      // distinct scripts a farm publishes is small, and half this table is
      // in-memory dev slots that have no `createdAt` to keyset on anyway.
      const offset = q?.cursor ? Number.parseInt(q.cursor, 10) || 0 : 0
      const page = all.slice(offset, offset + limit)
      const nextCursor = offset + limit < all.length ? String(offset + limit) : null
      return { items: page, nextCursor, total: all.length }
    },

    groups(q) {
      const persisted = allPersistedRows().map(rowToEntry)
      const dev = allDevEntries(devSlots)
      let all = [...persisted, ...dev]
      if (q?.pluginName) all = all.filter((e) => e.pluginName === q.pluginName)

      const byName = new Map<string, ScriptEntry[]>()
      for (const e of all) {
        const list = byName.get(e.name)
        if (list) list.push(e)
        else byName.set(e.name, [e])
      }

      const groupsOut: ScriptGroup[] = []
      for (const [name, entries] of byName) {
        const sorted = [...entries].sort((a, b) => compareSemver(b.version, a.version))
        const pluginName = sorted[0]?.pluginName ?? null
        // A plugin-owned name's "latest" is the ACTIVE plugin version, not merely the
        // highest enabled semver among its rows — see `activePluginVersion`'s doc comment.
        const latestVersion = pluginName
          ? activePluginVersion(pluginName)
          : (sorted.find((e) => e.origin !== 'dev' && e.enabled && !isPrereleaseVersion(e.version))?.version ?? null)
        groupsOut.push({
          name,
          pluginName,
          latestVersion,
          versions: sorted.map((e) => ({ entryId: e.id, version: e.version, origin: e.origin, enabled: e.enabled })),
          hasDev: sorted.some((e) => e.origin === 'dev'),
        })
      }
      return groupsOut.sort((a, b) => a.name.localeCompare(b.name))
    },

    get(id) {
      if (id.startsWith('dev:')) {
        const rest = id.slice('dev:'.length)
        const split = splitPluginName(rest)
        if (!split) return null
        const slot = devSlots.get(split.pluginName)
        if (!slot) return null
        return devEntryFromSlot(slot, split.exportId) ?? null
      }
      const row = db.select().from(scripts).where(eq(scripts.id, id)).get()
      return row ? rowToEntry(row) : null
    },

    resolve(ref, opts) {
      const { name, version } = parseScriptRef(ref)
      const dev = findDevEntry(name, version)
      if (dev && opts?.allowDev) return dev
      try {
        // Plugin-scoped `@latest` means "the ACTIVE version", not "the highest enabled
        // semver" — translate to a concrete pinned lookup before calling resolveScriptRef,
        // whose own `@latest` logic knows nothing about `active`/`superseded` (see
        // `activePluginVersion`'s doc comment). An exact pinned ref is untouched.
        const split = splitPluginName(name)
        if (split && version === 'latest') {
          const activeVersion = activePluginVersion(split.pluginName)
          if (!activeVersion) {
            throw new EnkakuError('script_ref_unresolved', `"${ref}" has no active version — the plugin "${split.pluginName}" is not currently active`)
          }
          const row = resolveScriptRef(db, `${name}@${activeVersion}` as ScriptRef)
          return rowToEntry(row)
        }
        const row = resolveScriptRef(db, ref)
        return rowToEntry(row)
      } catch (err) {
        if (dev && !opts?.allowDev) {
          throw new EnkakuError(
            'script_is_dev',
            `"${ref}" resolves to a dev build of "${dev.pluginName}" (owned by ${dev.devOwner ?? 'a dev session'}) — dev scripts run only via an explicit ad-hoc run or trigger (allowDev), never a schedule or a batch`,
          )
        }
        throw err
      }
    },

    async bundlePath(entry) {
      if (entry.bundle.kind === 'file') return entry.bundle.path
      const row = db.select().from(scripts).where(eq(scripts.id, entry.bundle.scriptId)).get()
      if (!row) throw new EnkakuError('script_not_found', `no such script: ${entry.bundle.scriptId}`)
      return materializeBundle(dataDir, row)
    },

    invalidate() {
      // See the interface doc above — nothing to do today; kept as the seam.
    },
  }
}

/**
 * A dev entry never shadows a published one silently (plan 82 §3.5): when a
 * running job's own entry is a dev build, this finds the enabled published
 * (non-dev) entry of the same name that WOULD have resolved instead, so the
 * executor can log which one actually ran, and who owns the dev slot that
 * won. Returns null when the job's entry is not a dev build, or nothing
 * published shares its name — the ordinary case, and the only one before
 * this plan existed at all.
 */
export function findShadowedPublished(registry: ScriptRegistry, entry: ScriptEntry): ScriptEntry | null {
  if (entry.origin !== 'dev') return null
  const candidates = registry.list({ name: entry.name }).items
  return candidates.find((e) => e.origin !== 'dev' && e.enabled) ?? null
}

/** Small helper for `queue/job-store.ts`'s `scriptNames()` — batch name/version lookup for a set of concrete `scripts.id`s, used to denormalise `jobs.script_name`/`script_version` at enqueue and as the fallback for a pre-existing row that has neither (plan 82 §3.4). */
export function scriptNamesByIds(db: Db, ids: string[]): Map<string, { name: string; version: string }> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = db.select().from(scripts).where(inArray(scripts.id, unique)).all()
  return new Map(rows.map((r) => [r.id, { name: r.name, version: r.version }]))
}
