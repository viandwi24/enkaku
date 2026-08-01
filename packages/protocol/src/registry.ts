import { z } from 'zod'

/** Descriptor engine untuk GET /api/registry (spec §8). */
export const EngineDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  kind: z.enum(['transport', 'display', 'input', 'inspector']),
  capabilities: z.array(z.string()).default([]),
  locks: z.array(z.string()).default([]),
  /** JSON Schema config engine; M2: {} placeholder (renderer = Plan 07). */
  configSchema: z.record(z.string(), z.unknown()).default({}),
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
