import type { EngineDescriptor } from '@enkaku/protocol'

/**
 * Descriptors for the engines actually implemented in this package (spec §8;
 * locks follow the spec §9.5 pattern). Engines that are still only planned
 * are registered by the core with `available: false`.
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
    displayName: 'scrcpy (H.264, low latency)',
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
    displayName: 'scrcpy SDK (InputManager, broad compatibility)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text'],
    locks: ['input-injection'],
    configSchema: {},
  },
  {
    id: 'uiautomator-dump',
    displayName: 'UiAutomator dump (bridge, 0.5–2 s per query)',
    kind: 'inspector',
    capabilities: ['dump', 'find', 'screenshot'],
    // It seizes UiAutomation too — it cannot run alongside ui-server or appium.
    locks: ['instrumentation'],
    configSchema: {},
  },
  {
    id: 'none',
    displayName: 'No route (default)',
    kind: 'network',
    capabilities: [],
    locks: [],
    configSchema: {},
  },
  {
    id: 'vpn-helper',
    displayName: 'Guest agent VPN route (SOCKS5)',
    kind: 'network',
    // NOT 'probe' — the egress probe does not exist yet and claiming it would be a lie.
    capabilities: ['auth', 'enforcing', 'udp'],
    locks: ['network-route'],
    configSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'SOCKS5 upstream host' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'SOCKS5 upstream port' },
        username: { type: 'string', description: 'Optional SOCKS5 username' },
        password: { type: 'string', description: 'Optional SOCKS5 password' },
        udpMode: { type: 'string', enum: ['udp', 'tcp'], default: 'udp', description: 'How UDP traffic is carried' },
      },
      required: ['host', 'port'],
    },
  },
]
