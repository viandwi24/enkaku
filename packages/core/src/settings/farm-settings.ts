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
  onChange(cb: (settings: FarmSettings) => void): () => void
}

const ROW_ID = 1

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
    // The server-mode `privacy.adbCommand: false` default (plan 26 §3.2,
    // §4.1; plan 212 §4.1 F44) can only be applied HERE, not in the Zod
    // schema: the schema has no way to see the bind address the auth mode
    // is derived from (00-overview's config precedence rule — never a
    // silent fallback, so this only ever touches a BRAND NEW row, never
    // overwrites an operator's own choice on an existing farm).
    if (opts?.authMode === 'server') cached = { ...cached, privacy: { ...cached.privacy, adbCommand: false } }
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

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
