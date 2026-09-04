import { FarmAgentSettingsSchema, defaultFarmAgentSettings, type FarmAgentSettings } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { farmSettings } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface AgentSettingsStore {
  get(): FarmAgentSettings
  update(patch: unknown): FarmAgentSettings
  onChange(cb: (settings: FarmAgentSettings) => void): () => void
}

/** Row 2 of `farm_settings` — plan 212 §4.7. Row 1 is the farm's own `FarmSettings`; no new table. */
const ROW_ID = 2

/** A copy of `createFarmSettingsStore`'s shape (plan 212 §4.7), against row 2 and `FarmAgentSettingsSchema`. No `authMode` argument - agent settings have no server-mode default. */
export function createAgentSettingsStore(db: Db): AgentSettingsStore {
  const listeners = new Set<(s: FarmAgentSettings) => void>()
  let cached: FarmAgentSettings

  const row = db.select().from(farmSettings).where(eq(farmSettings.id, ROW_ID)).get()
  const parsed = row ? FarmAgentSettingsSchema.safeParse(row.value) : null
  cached = parsed?.success ? parsed.data : defaultFarmAgentSettings()
  if (!row) {
    db.insert(farmSettings).values({ id: ROW_ID, value: cached, updatedAt: new Date() }).run()
  }

  return {
    get: () => cached,

    update(patch) {
      if (typeof patch !== 'object' || patch === null) {
        throw new EnkakuError('E_BAD_REQUEST', 'the settings body must be an object')
      }
      const merged: Record<string, unknown> = { ...cached }
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        const current = (cached as unknown as Record<string, unknown>)[key]
        merged[key] =
          typeof current === 'object' && current !== null && typeof value === 'object' && value !== null
            ? { ...(current as object), ...(value as object) }
            : value
      }
      const result = FarmAgentSettingsSchema.safeParse(merged)
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
