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
    id: 'ui-tree',
    // No number in this name: the file header's rule (a display name is served
    // verbatim by GET /api/registry and must never assert a number nobody has
    // measured). The ui-tree find and dump costs are measured by plan 222's
    // owner run and live in the SDK doc comments, not here.
    displayName: 'UI tree (guest agent accessibility service, push-based waitFor)',
    kind: 'inspector',
    // No `set-text` / `long-click` / `double-click`: the agent has no element
    // actions (plan 222 §3.7), and claiming one would make
    // `supportsElementActions` lie. `watch` is what `device-executor.ts` reads
    // as "this engine can push", through `Inspector.watch?`.
    capabilities: ['dump', 'find', 'screenshot', 'watch'],
    // Deliberately empty, and this is the row MVP 13 A.9 asks for. An
    // AccessibilityService reads `AccessibilityNodeInfo` through a binding the
    // system owns; it never connects `UiAutomation`, which is the resource the
    // `instrumentation` lock names. The reverse hazard (a connected
    // UiAutomation suppresses accessibility services) is handled by the
    // ladder, which picks exactly one rung per session, not by a lock.
    locks: [],
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
    id: 'adb-proxy',
    // Plan 114 §3.2, §4.2: the display name states the advisory property rather
    // than being a neutral label, because `GET /api/registry` serves this string
    // straight to Studio — a flattering descriptor here is visible in the
    // product, which is the mistake DIV-068 caught on `vpn-helper` below. Every
    // capability is `false` and every one of them is a fact worth publishing:
    // no credential (Android's value is `host:port`, world-readable on-device),
    // no enforcement (an app with its own networking ignores the setting), no
    // UDP, no egress probe. `locks: ['network-route']` is what makes "a VPN and
    // an http_proxy at once" structurally impossible rather than merely
    // discouraged.
    displayName: 'HTTP proxy over adb (advisory — apps can ignore it)',
    kind: 'network',
    capabilities: [],
    locks: ['network-route'],
    configSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host of a proxy the phone itself can reach' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Port of a proxy the phone itself can reach' },
        exclusions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hosts the phone should reach directly, bypassing the proxy',
        },
      },
      required: ['host', 'port'],
    },
  },
  {
    id: 'adb-reverse-proxy',
    // Plan 114 §3.2, §3.8, §4.2, step 114.5. Same advisory setting as
    // `adb-proxy` above, so the same warning belongs in the name a farm
    // operator reads — the difference this rung buys is WHERE the proxy runs,
    // not whether an app can ignore it. `capabilities: []` including `auth`,
    // deliberately: this is the rung on which an authenticated upstream becomes
    // possible at all, and the engine still supports no authentication itself.
    // The account lives in the listener on this machine, and claiming a
    // capability that belongs to another process is exactly what
    // `NetworkCapabilitiesSchema` exists to prevent.
    //
    // No `devicePort` in the schema, and that is the contract, not an omission:
    // the operator says where the proxy listens on THIS machine, and the
    // device-side port is allocated by the reverse registry and persisted on
    // `devices.network_route.reverse` (plan 114 §4.3).
    displayName: 'HTTP proxy on this machine, over adb reverse (advisory — apps can ignore it)',
    kind: 'network',
    capabilities: [],
    locks: ['network-route'],
    configSchema: {
      type: 'object',
      properties: {
        hostPort: {
          type: 'integer',
          minimum: 1,
          maximum: 65535,
          description: 'Port the proxy listens on, on this farm’s own machine — the phone reaches it over the adb connection',
        },
        exclusions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hosts the phone should reach directly, bypassing the proxy',
        },
      },
      required: ['hostPort'],
    },
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
