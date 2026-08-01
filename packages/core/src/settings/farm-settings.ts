import { FarmSettingsSchema, defaultFarmSettings, type FarmSettings } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { farmSettings } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface FarmSettingsStore {
  get(): FarmSettings
  /** Merge parsial + validasi Zod; nilai invalid ditolak. */
  update(patch: unknown): FarmSettings
  onChange(cb: (settings: FarmSettings) => void): () => void
}

const ROW_ID = 1

export function createFarmSettingsStore(db: Db): FarmSettingsStore {
  const listeners = new Set<(s: FarmSettings) => void>()
  let cached: FarmSettings

  const row = db.select().from(farmSettings).where(eq(farmSettings.id, ROW_ID)).get()
  const parsed = row ? FarmSettingsSchema.safeParse(row.value) : null
  cached = parsed?.success ? parsed.data : defaultFarmSettings()
  if (!row) {
    db.insert(farmSettings).values({ id: ROW_ID, value: cached, updatedAt: new Date() }).run()
  }

  return {
    get: () => cached,

    update(patch) {
      if (typeof patch !== 'object' || patch === null) {
        throw new EnkakuError('E_BAD_REQUEST', 'body settings harus object')
      }
      // Merge dangkal per-section supaya PATCH sebagian tidak menghapus sisanya.
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
