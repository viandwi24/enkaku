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
    id: 'appium',
    displayName: 'Appium (WebView/hybrid — opt-in, berat ~500 MB/sesi)',
    kind: 'inspector',
    capabilities: ['dump', 'find', 'screenshot', 'webview'],
    // Mengunci dua resource → tidak bisa barengan ui-server / input scrcpy.
    locks: ['instrumentation', 'input-injection'],
    requires: [],
    configSchema: {
      type: 'object',
      properties: {
        serverUrl: {
          type: 'string',
          default: 'http://127.0.0.1:4723',
          description: 'Base URL server Appium yang sudah berjalan',
        },
      },
    },
    available: true,
  },
  {
    id: 'scrcpy-aoa',
    displayName: 'scrcpy AOA/OTG (HID fisik via USB — butuh kabel, tanpa video)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'hardware-like-input'],
    locks: ['input-injection'],
    requires: [],
    configSchema: {},
    available: false,
    unavailableReason: 'Butuh transport USB AOA (libusb) — belum diimplementasi; pakai scrcpy-uhid',
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
