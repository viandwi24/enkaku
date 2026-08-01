import type { EngineDescriptor } from '@enkaku/protocol'

/**
 * Descriptor engine yang benar-benar terimplementasi di package ini
 * (spec §8; locks mengikuti pola spec §9.5). Engine yang masih rencana
 * didaftarkan core dengan `available: false`.
 */
export const engineDescriptors: Array<Omit<EngineDescriptor, 'requires' | 'available'>> = [
  {
    id: 'adb-usb',
    displayName: 'ADB (USB)',
    kind: 'transport',
    capabilities: ['shell', 'exec-out'],
    locks: [],
    configSchema: {},
  },
  {
    id: 'adb-tcp',
    displayName: 'ADB (Wireless / TCP)',
    kind: 'transport',
    capabilities: ['shell', 'exec-out'],
    locks: [],
    configSchema: {},
  },
  {
    id: 'screencap-loop',
    displayName: 'Screencap loop (fallback, ~2–3 fps)',
    kind: 'display',
    capabilities: ['png'],
    locks: [],
    configSchema: {},
  },
  {
    id: 'adb-input',
    displayName: 'ADB input (SDK mode, fallback)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text-ascii'],
    locks: ['input-injection'],
    configSchema: {},
  },
  {
    id: 'ui-server',
    displayName: 'UI server (persistent on-device, <200 ms per find)',
    kind: 'inspector',
    capabilities: ['dump', 'find', 'screenshot', 'set-text', 'long-click', 'double-click'],
    locks: ['instrumentation'],
    configSchema: {},
  },
  {
    id: 'scrcpy',
    displayName: 'scrcpy (H.264, latency rendah)',
    kind: 'display',
    capabilities: ['video-h264'],
    locks: ['video-encoder'],
    configSchema: {},
  },
  {
    id: 'scrcpy-uhid',
    displayName: 'scrcpy UHID (hardware-like input, wireless-friendly)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text', 'hardware-like-input'],
    locks: ['input-injection'],
    configSchema: {},
  },
  {
    id: 'scrcpy-sdk',
    displayName: 'scrcpy SDK (InputManager, kompatibilitas luas)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text'],
    locks: ['input-injection'],
    configSchema: {},
  },
  {
    id: 'uiautomator-dump',
    displayName: 'UiAutomator dump (jembatan, 0,5–2 dtk per query)',
    kind: 'inspector',
    capabilities: ['dump', 'find', 'screenshot'],
    // Merebut UiAutomation juga — tidak boleh barengan ui-server/appium.
    locks: ['instrumentation'],
    configSchema: {},
  },
]
