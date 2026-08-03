import { z } from 'zod'

/** Engine descriptor for GET /api/registry (spec §8). */
export const EngineDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  kind: z.enum(['transport', 'display', 'input', 'inspector', 'network']),
  capabilities: z.array(z.string()).default([]),
  /** Resource lock (spec §9.5) — two engines holding the same lock cannot both be active. */
  locks: z.array(z.string()).default([]),
  /** A capability another engine in the same combination must provide. */
  requires: z.array(z.string()).default([]),
  /** The engine's config JSON Schema (rendered by the schema-driven form). */
  configSchema: z.record(z.string(), z.unknown()).default({}),
  /** false = declared but not implemented yet (keeps the UI future-proof). */
  available: z.boolean().default(true),
  unavailableReason: z.string().optional(),
})
export type EngineDescriptor = z.infer<typeof EngineDescriptorSchema>

export const RegistryResponseSchema = z.object({
  transports: z.array(EngineDescriptorSchema),
  displays: z.array(EngineDescriptorSchema),
  inputs: z.array(EngineDescriptorSchema),
  inspectors: z.array(EngineDescriptorSchema),
  networks: z.array(EngineDescriptorSchema),
  tools: z.array(z.object({ id: z.string(), displayName: z.string(), swappable: z.boolean() })),
})
export type RegistryResponse = z.infer<typeof RegistryResponseSchema>

export interface EngineSelection {
  transport: string
  display: string
  input: string
  inspection: string
  network: string
}

export type EngineSelectionResult =
  | { ok: true }
  | {
      ok: false
      code: 'UNKNOWN_ENGINE' | 'ENGINE_UNAVAILABLE' | 'LOCK_CONFLICT' | 'REQUIREMENT_MISSING'
      message: string
    }

/**
 * Engine-combination validator — used by Studio (to disable impossible options) AND by
 * the core (server-authoritative on PATCH device drivers). One implementation,
 * two consumers (spec §8).
 */
export function validateEngineSelection(registry: RegistryResponse, sel: EngineSelection): EngineSelectionResult {
  const pick = (list: EngineDescriptor[], id: string, kind: string): EngineDescriptor | EngineSelectionResult => {
    const found = list.find((e) => e.id === id)
    if (!found) {
      return { ok: false, code: 'UNKNOWN_ENGINE', message: `${kind} '${id}' is not in the registry` }
    }
    if (!found.available) {
      return {
        ok: false,
        code: 'ENGINE_UNAVAILABLE',
        message: found.unavailableReason ?? `${kind} '${id}' is not available yet`,
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
    [registry.networks, sel.network, 'network'],
  ] as const) {
    const res = pick(list, id, kind)
    if ('ok' in res) return res
    chosen.push(res)
  }

  // Lock conflict: two DIFFERENT engines claim the same resource.
  const lockOwner = new Map<string, string>()
  for (const engine of chosen) {
    for (const lock of engine.locks) {
      const owner = lockOwner.get(lock)
      if (owner && owner !== engine.id) {
        return {
          ok: false,
          code: 'LOCK_CONFLICT',
          message: `'${engine.id}' and '${owner}' both lock the resource '${lock}'`,
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
          message: `'${engine.id}' needs the capability '${need}', which no selected engine provides`,
        }
      }
    }
  }

  return { ok: true }
}
