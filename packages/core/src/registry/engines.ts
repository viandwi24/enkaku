import { engineDescriptors } from '@enkaku/drivers'
import { RegistryResponseSchema, type EngineDescriptor, type RegistryResponse } from '@enkaku/protocol'
import type { ToolchainManager } from '@enkaku/toolchain'

const byKind = (kind: EngineDescriptor['kind']): EngineDescriptor[] =>
  engineDescriptors.filter((d) => d.kind === kind)

/**
 * Registry engine (spec §8). Bentuk respons sudah final; Plan 07 hanya
 * mengisi configSchema sungguhan + form renderer tanpa mengubah kontrak.
 */
export async function buildRegistryResponse(toolchain: ToolchainManager): Promise<RegistryResponse> {
  const tools = await toolchain.list()
  return RegistryResponseSchema.parse({
    transports: byKind('transport'),
    displays: byKind('display'),
    inputs: byKind('input'),
    inspectors: byKind('inspector'),
    tools: tools.map((t) => ({ id: t.id, displayName: t.displayName, swappable: t.swappable })),
  })
}
