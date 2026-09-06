import { FarmSettingsSchema, defaultFarmSettings, type FarmSettings } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { farmSettings } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { AuthMode } from '../config'
import { createLogger, type Logger } from '../util/logger'
import { migrateFarmSettings } from './migrate-settings'

export interface FarmSettingsStore {
  get(): FarmSettings
  /** Partial merge plus Zod validation; invalid values are rejected. */
  update(patch: unknown): FarmSettings
  /**
   * Drop the named top-level sections and let the CURRENT schema defaults
   * fill them back in.
   *
   * ### Why this exists at all
   *
   * The row below is written out in FULL on a farm's first boot —
   * `defaultFarmSettings()` is a materialised object, every key present. So
   * there is no "this operator never touched it" state to distinguish, and a
   * default CHANGED in a later release never reaches a farm that has already
   * run: the stored value is there, and it wins. (A default ADDED does reach
   * it, because the schema fills a key the row lacks.) An operator who wants
   * the new tuning has no way to ask for it (owner, 2026-09-06).
   *
   * ### What it deliberately cannot touch
   *
   * Only `farm_settings`, and within it only whole top-level sections that
   * exist in `FarmSettingsSchema`. This store holds no other table, so
   * devices, groups, jobs, runs, scripts, users, tokens and credentials are
   * out of reach by construction rather than by care — which is the point:
   * "reset my settings" must never be one typo away from "reset my farm".
   * An unknown section name is refused rather than ignored, so a caller
   * cannot believe it reset something it did not.
   */
  resetSections(sections: readonly string[]): FarmSettings
  onChange(cb: (settings: FarmSettings) => void): () => void
}

const ROW_ID = 1

/**
 * The server-mode `privacy.adbCommand: false` default (plan 26 §3.2, §4.1;
 * plan 212 §4.1 F44), applied in the ONE place both the first-boot insert and
 * `resetSections` can reach it.
 *
 * It cannot live in the Zod schema — the schema has no way to see the bind
 * address the auth mode is derived from — and it must not be inlined at the
 * insert alone: a reset of `privacy` would then hand a network-exposed farm
 * the schema's own `true`, quietly re-enabling the Adb command action for
 * every operator on an install that had it off. A settings reset must never
 * be able to widen what a farm exposes.
 */
function applyAuthModeDefaults(settings: FarmSettings, authMode: AuthMode | undefined): FarmSettings {
  if (authMode !== 'server') return settings
  return { ...settings, privacy: { ...settings.privacy, adbCommand: false } }
}

/**
 * `authMode` is optional so every existing call site (and test) that has no
 * opinion about it keeps compiling unchanged — it only matters the ONE time
 * a farm settings row is created from scratch.
 */
export function createFarmSettingsStore(db: Db, opts?: { authMode?: AuthMode; log?: Logger }): FarmSettingsStore {
  const log = opts?.log ?? createLogger('settings')
  const listeners = new Set<(s: FarmSettings) => void>()
  let cached: FarmSettings

  const row = db.select().from(farmSettings).where(eq(farmSettings.id, ROW_ID)).get()
  // Plan 212 §4.8 — a row written by ANY earlier schema is migrated onto
  // the nine-key one before it is ever parsed against the current schema:
  // renamed keys mapped, unknown keys dropped, out-of-range values clamped
  // (one `log.warn` each). `get(raw, 'general')` inside the migration is
  // what tells it a row is ALREADY the new shape, so this never re-runs
  // once a farm has migrated once.
  const wasPreMigration = row ? typeof row.value === 'object' && row.value !== null && !('general' in (row.value as object)) : false
  cached = row ? migrateFarmSettings(row.value, log) : defaultFarmSettings()
  if (!row) {
    // Only ever on a BRAND NEW row — never overwriting an operator's own
    // choice on an existing farm (00-overview's config precedence rule: never
    // a silent fallback). `resetSections` is the other caller, for the same
    // reason at a different moment.
    cached = applyAuthModeDefaults(cached, opts?.authMode)
    db.insert(farmSettings).values({ id: ROW_ID, value: cached, updatedAt: new Date() }).run()
  } else if (wasPreMigration) {
    // The migration runs once, not on every boot: a migrated row is written
    // straight back so the next boot's `get(raw, 'general')` check finds
    // the new shape already in place.
    db.update(farmSettings).set({ value: cached, updatedAt: new Date() }).where(eq(farmSettings.id, ROW_ID)).run()
  }

  return {
    get: () => cached,

    update(patch) {
      if (typeof patch !== 'object' || patch === null) {
        throw new EnkakuError('E_BAD_REQUEST', 'the settings body must be an object')
      }
      // A shallow per-section merge, so a partial PATCH does not wipe the rest.
      const merged: Record<string, unknown> = { ...cached }
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        const current = (cached as unknown as Record<string, unknown>)[key]
        merged[key] =
          typeof current === 'object' && current !== null && typeof value === 'object' && value !== null
            ? { ...(current as object), ...(value as object) }
            : value
      }
      const result = FarmSettingsSchema.safeParse(merged)
      if (!result.success) {
        throw new EnkakuError('E_BAD_REQUEST', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }
      cached = result.data
      db.update(farmSettings).set({ value: cached, updatedAt: new Date() }).where(eq(farmSettings.id, ROW_ID)).run()
      for (const cb of listeners) cb(cached)
      return cached
    },

    resetSections(sections) {
      if (sections.length === 0) {
        throw new EnkakuError('E_BAD_REQUEST', 'name at least one settings section to reset')
      }
      // Refused, not ignored: a caller that misspells a section must not be
      // told the reset succeeded. `FarmSettingsSchema.shape` is the authority
      // on what a section IS, so this cannot drift from the schema.
      const known = Object.keys(FarmSettingsSchema.shape)
      const unknown = sections.filter((name) => !known.includes(name))
      if (unknown.length > 0) {
        throw new EnkakuError('E_BAD_REQUEST', `not a settings section: ${unknown.join(', ')} (known: ${known.join(', ')})`)
      }

      // Dropping the key is what makes this a reset rather than a write of
      // today's constants: the schema's own `.default()` is what fills the
      // hole, so this function never needs to know a single default value and
      // cannot go stale when one changes.
      const stripped: Record<string, unknown> = { ...cached }
      for (const name of sections) delete stripped[name]

      const result = FarmSettingsSchema.safeParse(stripped)
      if (!result.success) {
        // Every top-level key carries a `.default()`, so this is unreachable
        // in practice — and if a future section is ever added without one,
        // failing loudly is better than writing a half-reset row.
        throw new EnkakuError('E_BAD_REQUEST', `resetting ${sections.join(', ')} left the settings invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      }

      cached = applyAuthModeDefaults(result.data, opts?.authMode)
      db.update(farmSettings).set({ value: cached, updatedAt: new Date() }).where(eq(farmSettings.id, ROW_ID)).run()
      log.info(`settings reset to defaults: ${sections.join(', ')}`)
      for (const cb of listeners) cb(cached)
      return cached
    },

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
