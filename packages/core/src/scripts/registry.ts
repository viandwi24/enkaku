import { and, eq } from 'drizzle-orm'
import { compareSemver, parseScriptRef, type RuntimeEnvelope, type ScriptRef } from '@enkaku/protocol'
import type { Db } from '../db'
import { plugins, scripts, type ScriptRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { DevSlot, DevSlotStore } from '../plugins/dev-slots'
import { createLogger, type Logger } from '../util/logger'
import { resolveScriptRef } from './resolve'
import { materializeBundle } from './bundle-cache'
import { isUnownedScriptRow, ownedScriptsWhere, parseScriptRuntime } from './service'

/**
 * The single source of truth for "what scripts exist" and "resolve this
 * reference" (plan 82 §3.3) — the merge point between the two places a
 * script can come from: a persisted `scripts` row (a published plugin
 * member, or a workflow document) and an unpublished plugin dev slot
 * (`plugins/dev-slots.ts`). Every consumer that used to read the `scripts`
 * table or call `resolveScriptRef` directly reads through here instead, so
 * a dev script is visible everywhere or nowhere — never "everywhere except
 * the one call site nobody updated" (§3.3's stated failure mode).
 */

/**
 * Where an entry comes from: a persisted `scripts` row, or an unpublished
 * dev slot held in memory. There is no third value — a script is a member
 * of a plugin and nothing else (plan 210, MVP 03 §2), so a persisted row is
 * always `'plugin'`.
 */
export type ScriptOrigin = 'plugin' | 'dev'

export interface ScriptEntry {
  /** `scripts.id` for a persisted script; `dev:<plugin>/<script>` for a dev one. */
  id: string
  /** `tiktok/login` for a plugin member (published or dev). */
  name: string
  version: string
  origin: ScriptOrigin
  pluginName: string | null
  /** The script's id INSIDE its plugin bundle. */
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

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total: number
}

export interface ScriptRegistry {
  list(q?: { name?: string; pluginName?: string; origin?: ScriptOrigin; limit?: number; cursor?: string | null }): Page<ScriptEntry>
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
    // Every persisted row this function is ever handed is one the registry
    // serves: a plugin member (see `ScriptOrigin`). A row with no owning
    // plugin never reaches here — `isUnownedScriptRow` filters it out first.
    origin: 'plugin',
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

/**
 * ONE line, once, for N rows (never one per row, never one per request): a
 * farm with scripts published outside a plugin (or parked, plan 210
 * §db/migrations/park-synthetic-recordings.ts) stops running them, and the
 * operator has to be told why and what to do about it. Silence here is the
 * worst outcome this change can have.
 *
 * The names are in the message (up to ten, `name@version (id)`, plus a
 * count of the rest) because the rows are no longer in any list — without
 * them the operator cannot find what stopped.
 */
function warnUnownedRows(db: Db, log: Logger): void {
  const rows = db.select({ id: scripts.id, name: scripts.name, version: scripts.version, pluginId: scripts.pluginId }).from(scripts).all().filter(isUnownedScriptRow)
  if (rows.length === 0) return
  const names = [...new Set(rows.map((r) => r.name))].sort()
  const shown = rows
    .slice(0, 10)
    .map((r) => `${r.name}@${r.version} (${r.id})`)
    .join(', ')
  const rest = rows.length > 10 ? `, +${rows.length - 10} more` : ''
  log.warn(
    `${rows.length} script row(s) across ${names.length} name(s) have no owning plugin and are ignored: ${shown}${rest}. ` +
      'A script is a member of a plugin and nothing else, so these are not listed and a job, schedule or batch that names one is refused. ' +
      'Nothing was deleted and job history still reads back. Republish them inside a plugin, or delete them: DELETE /api/scripts/<id>.',
  )
}

export function createScriptRegistry(deps: { db: Db; dataDir: string; devSlots: DevSlotStore; log?: Logger }): ScriptRegistry {
  const { db, dataDir, devSlots } = deps
  warnUnownedRows(db, deps.log ?? createLogger('scripts.registry'))

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

  /** Only rows the farm still serves — see `isUnownedScriptRow` for the one class this leaves out and why. */
  function allPersistedRows(): ScriptRow[] {
    return db.select().from(scripts).where(ownedScriptsWhere()).all()
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
      if (!row || isUnownedScriptRow(row)) return null
      return rowToEntry(row)
    },

    resolve(ref, opts) {
      /**
       * `resolveScriptRef` reads the `scripts` table directly (deliberately
       * unmodified — §3.3), so the one class of row the registry does not
       * serve is refused HERE rather than by teaching that function about it.
       * `script_not_found` and not a code of its own: to every caller this is
       * a reference that names nothing runnable, and the boot warning
       * (`warnUnownedRows`) is where the explanation lives.
       */
      const served = (row: ScriptRow): ScriptEntry => {
        if (isUnownedScriptRow(row)) {
          throw new EnkakuError(
            'script_not_found',
            `"${ref}" names a script with no owning plugin — it was published before a script had to be a member of a plugin, and the farm no longer resolves it`,
          )
        }
        return rowToEntry(row)
      }
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
          return served(row)
        }
        const row = resolveScriptRef(db, ref)
        return served(row)
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
