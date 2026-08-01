import type { z } from 'zod'
import type { ScriptDefinition } from './types'

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * Tanpa side effect — hanya validasi bentuk + freeze. Semua orkestrasi
 * (fase, timeout, retries) milik runner core, sehingga script yang
 * di-publish dengan SDK lama tetap jalan di core baru.
 */
export function defineScript<S extends z.ZodTypeAny>(def: ScriptDefinition<S>): ScriptDefinition<S> {
  if (!def.id || def.id.trim().length === 0) throw new Error('defineScript: `id` wajib diisi')
  if (!SEMVER.test(def.version)) throw new Error(`defineScript: \`version\` harus semver, dapat "${def.version}"`)
  if (typeof def.run !== 'function') throw new Error('defineScript: `run` wajib berupa function')
  if (!def.params || typeof (def.params as { safeParse?: unknown }).safeParse !== 'function') {
    throw new Error('defineScript: `params` harus schema Zod')
  }
  return Object.freeze(def)
}
