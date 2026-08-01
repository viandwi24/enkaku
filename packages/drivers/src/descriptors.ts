import type { EngineDescriptor } from '@enkaku/protocol'

/** Descriptor engine M2 (spec §8; locks mengikuti pola spec §9.5). */
export const engineDescriptors: EngineDescriptor[] = [
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
    id: 'uiautomator-dump',
    displayName: 'UiAutomator dump (jembatan, 0,5–2 dtk per query)',
    kind: 'inspector',
    capabilities: ['dump', 'find', 'screenshot'],
    locks: [],
    configSchema: {},
  },
]
