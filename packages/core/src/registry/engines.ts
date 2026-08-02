import { engineDescriptors } from '@enkaku/drivers'
import { RegistryResponseSchema, type EngineDescriptor, type RegistryResponse } from '@enkaku/protocol'
import type { ToolchainManager } from '@enkaku/toolchain'

/**
 * Engines that are declared but NOT implemented yet — registered now to keep
 * the UI future-proof (the dropdown shows them disabled with a reason, rather
 * than having them vanish and then appear out of nowhere).
 */
const PLANNED: EngineDescriptor[] = [
  {
    id: 'appium',
    displayName: 'Appium (WebView/hybrid — opt-in, heavy at ~500 MB per session)',
    kind: 'inspector',
    capabilities: ['dump', 'find', 'screenshot', 'webview'],
    // It locks two resources → cannot run alongside ui-server or scrcpy input.
    locks: ['instrumentation', 'input-injection'],
    requires: [],
    configSchema: {
      type: 'object',
      properties: {
        serverUrl: {
          type: 'string',
          default: 'http://127.0.0.1:4723',
          description: 'Base URL of an already-running Appium server',
        },
      },
    },
    available: true,
  },
  {
    id: 'scrcpy-aoa',
    displayName: 'scrcpy AOA/OTG (physical HID over USB — needs a cable, carries no video)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'hardware-like-input'],
    locks: ['input-injection'],
    requires: [],
    configSchema: {},
    available: false,
    unavailableReason: 'Needs an AOA USB transport (libusb) — not implemented yet; use scrcpy-uhid',
  },
]

const all = (): EngineDescriptor[] => [
  // Engines from packages/drivers are the ones actually implemented.
  ...engineDescriptors.map((d) => ({ ...d, requires: [], available: true })),
  ...PLANNED,
]

const byKind = (kind: EngineDescriptor['kind']): EngineDescriptor[] => all().filter((d) => d.kind === kind)

/** The engine registry (spec §8) — used by Studio and the combination validator. */
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
