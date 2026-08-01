import { z } from 'zod'

/** Descriptor engine untuk GET /api/registry (spec §8). */
export const EngineDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  kind: z.enum(['transport', 'display', 'input', 'inspector']),
  capabilities: z.array(z.string()).default([]),
  /** Resource lock (spec §9.5) — dua engine dgn lock sama tidak boleh aktif bersamaan. */
  locks: z.array(z.string()).default([]),
  /** Capability yang wajib disediakan engine lain dalam kombinasi yang sama. */
  requires: z.array(z.string()).default([]),
  /** JSON Schema config engine (di-render schema-driven form). */
  configSchema: z.record(z.string(), z.unknown()).default({}),
  /** false = terdaftar tapi belum diimplementasi (UI future-proof). */
  available: z.boolean().default(true),
  unavailableReason: z.string().optional(),
})
export type EngineDescriptor = z.infer<typeof EngineDescriptorSchema>

export const RegistryResponseSchema = z.object({
  transports: z.array(EngineDescriptorSchema),
  displays: z.array(EngineDescriptorSchema),
  inputs: z.array(EngineDescriptorSchema),
  inspectors: z.array(EngineDescriptorSchema),
  tools: z.array(z.object({ id: z.string(), displayName: z.string(), swappable: z.boolean() })),
})
export type RegistryResponse = z.infer<typeof RegistryResponseSchema>

export interface EngineSelection {
  transport: string
  display: string
  input: string
  inspection: string
}

export type EngineSelectionResult =
  | { ok: true }
  | {
      ok: false
      code: 'UNKNOWN_ENGINE' | 'ENGINE_UNAVAILABLE' | 'LOCK_CONFLICT' | 'REQUIREMENT_MISSING'
      message: string
    }

/**
 * Validator kombinasi engine — dipakai Studio (disable opsi mustahil) DAN
 * core (server-authoritative saat PATCH driver device). Satu implementasi,
 * dua konsumen (spec §8).
 */
export function validateEngineSelection(registry: RegistryResponse, sel: EngineSelection): EngineSelectionResult {
  const pick = (list: EngineDescriptor[], id: string, kind: string): EngineDescriptor | EngineSelectionResult => {
    const found = list.find((e) => e.id === id)
    if (!found) {
      return { ok: false, code: 'UNKNOWN_ENGINE', message: `${kind} '${id}' tidak ada di registry` }
    }
    if (!found.available) {
      return {
        ok: false,
        code: 'ENGINE_UNAVAILABLE',
        message: found.unavailableReason ?? `${kind} '${id}' belum tersedia`,
      }
    }
    return found
  }

  const chosen: EngineDescriptor[] = []
  for (const [list, id, kind] of [
    [registry.transports, sel.transport, 'transport'],
    [registry.displays, sel.display, 'display'],
    [registry.inputs, sel.input, 'input'],
    [registry.inspectors, sel.inspection, 'inspector'],
  ] as const) {
    const res = pick(list, id, kind)
    if ('ok' in res) return res
    chosen.push(res)
  }

  // Lock bentrok: dua engine BERBEDA meminta resource yang sama.
  const lockOwner = new Map<string, string>()
  for (const engine of chosen) {
    for (const lock of engine.locks) {
      const owner = lockOwner.get(lock)
      if (owner && owner !== engine.id) {
        return {
          ok: false,
          code: 'LOCK_CONFLICT',
          message: `'${engine.id}' dan '${owner}' sama-sama mengunci resource '${lock}'`,
        }
      }
      lockOwner.set(lock, engine.id)
    }
  }

  const provided = new Set(chosen.flatMap((e) => e.capabilities))
  for (const engine of chosen) {
    for (const need of engine.requires) {
      if (!provided.has(need)) {
        return {
          ok: false,
          code: 'REQUIREMENT_MISSING',
          message: `'${engine.id}' butuh capability '${need}' yang tidak disediakan engine terpilih`,
        }
      }
    }
  }

  return { ok: true }
}
