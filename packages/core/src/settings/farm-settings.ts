import { FarmSettingsSchema, defaultFarmSettings, type FarmSettings } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { farmSettings } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { AuthMode } from '../config'

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
export function createFarmSettingsStore(db: Db, opts?: { authMode?: AuthMode }): FarmSettingsStore {
  const listeners = new Set<(s: FarmSettings) => void>()
  let cached: FarmSettings

  const row = db.select().from(farmSettings).where(eq(farmSettings.id, ROW_ID)).get()
  const parsed = row ? FarmSettingsSchema.safeParse(row.value) : null
  cached = parsed?.success ? parsed.data : defaultFarmSettings()
  if (!row) {
    // The server-mode `shell.mode: 'off'` default (plan 26 §3.2, §4.1) can
    // only be applied HERE, not in the Zod schema: the schema has no way to
    // see the bind address the auth mode is derived from (00-overview's
    // config precedence rule — never a silent fallback, so this only ever
    // touches a BRAND NEW row, never overwrites an operator's own choice on
    // an existing farm).
    // Plan 93 §3.8, §4.1 — fleet fan-out gets the SAME server-mode override
    // as `shell.mode` above, forced off alongside it: running one gated
    // shell and running a hundred at once on a network-exposed farm are two
    // different decisions, and the second must never be a discovery either.
    if (opts?.authMode === 'server') cached = { ...cached, shell: { ...cached.shell, mode: 'off', fanoutEnabled: false } }
    db.insert(farmSettings).values({ id: ROW_ID, value: cached, updatedAt: new Date() }).run()
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
