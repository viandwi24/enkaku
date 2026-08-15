import type { EngineDescriptor } from '@enkaku/protocol'

/**
 * Descriptors for the engines actually implemented in this package (spec §8;
 * locks follow the spec §9.5 pattern). Engines that are still only planned
 * are registered by the core with `available: false`.
 *
 * `displayName` is shown verbatim to users (Studio's device header resolves
 * an engine id to this string — `packages/studio/src/components/device/
 * DeviceHeader.tsx:92-93` — and it is served over `GET /api/registry`), so it
 * must never assert a number nobody has measured as fact. It did once: the
 * ui-server entry below claimed "<200 ms per find" through an entire shipped
 * release with no test or benchmark backing it anywhere in the repo, and the
 * number was wrong by roughly a factor of 10 for part of that time (plan 34's
 * shipped-defect repair, S4 in plan 87's MVP-readiness audit). Per plan 87
 * §4.6/step 87.6: softened to read as a design target, not a measured
 * guarantee — "target" is the operative word, not a smaller or hedged
 * number, because a qualified guess can still mislead if it reads as
 * confidence. `packages/toolchain/src/manager.bench.test.ts` and
 * `packages/core/src/jobs/spawn-overhead.bench.test.ts` now assert the parts
 * of spec §16 that are checkable with no device; `scripts/bench-device-nfrs.ts`
 * (gated behind ENKAKU_TEST_DEVICE=1, since it needs a real phone) is the
 * harness that would turn this specific number into a measured one — see its
 * own header comment for what it measures and what it deliberately cannot.
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
    // Plan 88 §3.1, §3.7 (fixes F3): 'ADB (Wireless / TCP)' asserted
    // *wireless* about every device on this engine, including a wired OTG
    // chassis — adb sees `10.20.0.37:5555` either way and cannot tell a
    // switch port from a radio, the same "must never assert a number nobody
    // has measured as fact" rule this file's own header states, applied to
    // a medium instead of a number. Whether a device on this engine is
    // wired or wireless is `DeviceInfo.connection.medium`
    // (`packages/protocol/src/device.ts`) — declared or inferred from a
    // configured farm network, never this string.
    displayName: 'ADB over the network (TCP)',
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
    // `text-ascii` (plan 90 §3.3, §5 step 90.5, fixes F25): declared since
    // before this plan but read by nothing (F25) — `resolveTextRoute`
    // (`@enkaku/session`) is now the reader, and a non-ASCII string on this
    // engine with no better rung available is refused as a named
    // precondition rather than reaching `AdbInput.text()` and dying inside
    // it as `INPUT_TEXT_UNSUPPORTED`.
    displayName: 'ADB input (SDK mode, fallback)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text-ascii'],
    locks: ['input-injection'],
    configSchema: {},
  },
  {
    id: 'ui-server',
    displayName: 'UI server (persistent on-device, target <200 ms per find)',
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
    // `text-unicode` (plan 90 §3.3, §5 step 90.5, fixes F25): renamed from the
    // undifferentiated `text` — UHID overrides only tap/swipe/gesture
    // (F22), so `text()` is inherited from the SDK engine's own
    // `INJECT_TEXT` (control type 1, UTF-8 on the wire), the same rung-2 path
    // `resolveTextRoute` (`@enkaku/session`) reads to confirm before choosing
    // `scrcpy-text` — NOT literally this string, though: `resolveTextRoute`
    // takes a plain `hasScrcpyControl` boolean, computed at the call site as
    // `session.inputEngineId !== 'adb-input'` rather than by reading this
    // array. The two are provably equivalent today (`session.ts`'s `scrcpy`
    // build gate is the only thing that decides both `inputEngineId` and
    // this descriptor's applicability), which is exactly why a clipboard-paste
    // text rung — designed in plan 90 §3.3, fully built, and never once
    // reachable — was removed outright rather than kept dormant; see
    // `text-input.ts`'s `TextRung` doc comment for the full finding
    // (docs/plans/96-m61-hotfixes.md §96.7, §96.8). This capability string is
    // real and accurate; it is just not the thing literally read at runtime.
    displayName: 'scrcpy UHID (hardware-like input, wireless-friendly)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text-unicode', 'hardware-like-input'],
    locks: ['input-injection'],
    configSchema: {},
  },
  {
    id: 'scrcpy-sdk',
    // `text-unicode`: same rename, same reason — see `scrcpy-uhid` above.
    displayName: 'scrcpy SDK (InputManager, broad compatibility)',
    kind: 'input',
    capabilities: ['tap', 'swipe', 'key', 'text-unicode'],
    locks: ['input-injection'],
    configSchema: {},
  },
  {
    id: 'uiautomator-dump',
    displayName: 'UiAutomator dump (bridge, restarts UiAutomation per query — slower fallback)',
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
    // `probe` is real as of plan 51 §4.2/§5.4 — the engine runs an egress probe
    // THROUGH the tunnel (`vpn-helper.ts`'s `capabilities.probe: true`). This
    // list said otherwise until plan 84's audit found the two declarations
    // disagreeing (DIV-068); it is served to Studio through `GET /api/registry`,
    // so the stale entry was visible in the product, not just in a comment.
    // Advertising `probe` does NOT mean the route is healthy: `deriveHealth`
    // (`packages/protocol/src/network.ts:304`) still reports `unverified` until
    // an `egress` check actually passes.
    capabilities: ['auth', 'enforcing', 'udp', 'probe'],
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
