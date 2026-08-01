import { engineDescriptors } from '@enkaku/drivers'
import { RegistryResponseSchema, type EngineDescriptor, type RegistryResponse } from '@enkaku/protocol'
import type { ToolchainManager } from '@enkaku/toolchain'

/**
 * Engine yang sudah terdaftar tapi BELUM diimplementasi — didaftarkan
 * sekarang supaya UI future-proof (dropdown menampilkannya disabled dengan
 * alasan, bukan menghilang lalu muncul mendadak).
 */
const PLANNED: EngineDescriptor[] = [
  {
    id: 'scrcpy',
    displayName: 'scrcpy (H.264, latency rendah)',
    kind: 'display',
    capabilities: ['video-h264'],
    locks: ['video-encoder'],
    requires: [],
    configSchema: {},
    available: false,
    unavailableReason: 'Tersedia mulai M6',
  },
  {
    id: 'scrcpy-uhid',
    displayName: 'scrcpy UHID (hardware-like input)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text', 'hardware-like-input'],
    locks: ['input-injection'],
    requires: [],
    configSchema: {},
    available: false,
    unavailableReason: 'Tersedia mulai M6',
  },
  {
    id: 'scrcpy-sdk',
    displayName: 'scrcpy SDK (InputManager, kompat luas)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text'],
    locks: ['input-injection'],
    requires: [],
    configSchema: {},
    available: false,
    unavailableReason: 'Tersedia mulai M6',
  },
  {
    id: 'scrcpy-aoa',
    displayName: 'scrcpy AOA/OTG (HID fisik via USB)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'hardware-like-input'],
    locks: ['input-injection'],
    requires: [],
    configSchema: {},
    available: false,
    unavailableReason: 'Tersedia mulai M8 (opt-in)',
  },
  {
    id: 'appium',
    displayName: 'Appium (WebView/hybrid, berat)',
    kind: 'inspector',
    capabilities: ['dump', 'find', 'screenshot', 'webview'],
    locks: ['instrumentation', 'input-injection'],
    requires: [],
    configSchema: {},
    available: false,
    unavailableReason: 'Tersedia mulai M8 (opt-in)',
  },
]

const all = (): EngineDescriptor[] => [
  // Engine dari packages/drivers = yang benar-benar terimplementasi.
  ...engineDescriptors.map((d) => ({ ...d, requires: [], available: true })),
  ...PLANNED,
]

const byKind = (kind: EngineDescriptor['kind']): EngineDescriptor[] => all().filter((d) => d.kind === kind)

/** Registry engine (spec §8) — dipakai Studio & validator kombinasi engine. */
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
