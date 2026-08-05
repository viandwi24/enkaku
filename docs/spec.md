# Enkaku — Product Spec

> **Codename: Enkaku** (遠隔 — "remote, at a distance"). A placeholder name, free to change.
> A device farm platform for remote control and automation of Android phones: self-hosted, zero-config, with a cloud option.
> Document status: **draft v0.2** — a living document.
>
> **Changelog v0.1 → v0.2:** revised after prior-art research and verification of technical claims. The big changes: (1) scrcpy-server is pinned to the core version rather than user-swappable; (2) the adb mutex is replaced by a per-device queue plus a loose semaphore; (3) the inspector uses a persistent on-device server (the uiautomator2 pattern) rather than a naive `uiautomator dump`; (4) the "sandbox" claim is corrected to be honest about the trust model; (5) device identity uses a stable ID rather than the adb serial; (6) cloud mode likely needs WebRTC rather than raw WS + WebCodecs; (7) added §6 competitor comparison, §9 input injection modes (for QA detection testing), the enrollment flow, battery/thermal, NFRs, retention, and licensing. Sources are summarised in §21.

---

## 1. Summary and vision

Enkaku is an end-to-end **device farm platform**: a system that makes a set of Android phones *remotely controllable* (see the screen and click from a browser) and *automatable* (scripts run on their own in a safe queue) through one web UI.

The target experience:

> **Install → run → it works.** No manual adb install, no PATH configuration, no terminal knowledge required. Every dependency (adb, scrcpy, and so on) is managed by the application itself through the UI.

Two audiences:

1. **Internal** — a team of programmers who need a tool to remotely control and test apps on many physical devices at once.
2. **A product to sell** — sold as a QA/test-automation device farm (positioned like BrowserStack or AWS Device Farm, but self-hostable and cheap).

**Why is this still relevant when there is so much open source already?** See §6 — the short version: what exists today (STF/DeviceFarmer) has an ageing architecture capped at Android 9, and the modern option (ws-scrcpy-web) is *mirroring only*, with no lease, queue, script framework, or multi-user support. Enkaku combines modern remote control, orchestration, and automation into one zero-config package. Nobody has filled that gap as a mature product.

---

## 2. Design principles (non-negotiable)

| Principle | What it means concretely |
|---|---|
| **Zero-config** | First run auto-provisions every tool, auto-detects devices, and opens the browser. No mandatory manual step. |
| **Self-contained** | Never depends on tools already on the user's system. adb, scrcpy, and the rest are downloaded and managed by the app into an app-local folder, not the system PATH. |
| **Schema-driven UI** | Every component (tool, driver engine, script) describes its config as a schema. Studio *renders* the management UI from that schema dynamically. Adding a component automatically gets it a settings panel, with no new UI code. |
| **Pluggable and swappable** | Transport, display, input, inspection, and tools are all modular. Replace or update one part without touching the others — **except for pairs that are genuinely tightly coupled** (see the scrcpy rule in §7.6). |
| **Server-authoritative** | Every rule (leases, resource conflicts, ACL) is enforced in the core, never in the UI. The client is never trusted. |
| **Portable runtime** | The core is a daemon that runs on macOS, Linux x64/arm64, in a container, or on a small SBC. |

---

## 3. Personas and use cases

- **Programmer (operator).** Registers devices, controls them manually for debugging, runs test scripts, reads logs and artifacts.
- **Admin / owner.** Manages users, devices, tool versions, ACLs; monitors the farm.
- **Script author.** Writes automation scripts with the SDK (type-safe, in their own editor) and publishes them to the farm.
- **End customer (product mode).** Installs an appliance or binary, plugs in devices, and uses it through a browser without knowing what is inside.

Primary use cases:

1. Remotely view and click one device from a browser (low latency).
2. Run automation scripts across many devices in a queue, one at a time and safely.
3. Manage a script library (CRUD, versioning, running with parameters).
4. Manage devices (name, owner, driver config, per-device settings).
5. Manage the toolchain (adb/scrcpy: install, update, pin, delete versions) through the UI.
6. **Test your own app against automation detection** (red-teaming your own detectors) — see §9 and §17.

---

## 4. High-level architecture

Three main artifacts:

- **Core** — the daemon (Bun + Hono). The orchestrator: device registry, drivers, session/lease, queue, script runner, toolchain manager, API and WebSocket. It runs near the devices (it needs USB or LAN).
- **Studio** — the web UI (Next.js). Dashboard, remote control, script manager, toolchain manager, settings. Served by the core itself (local) or hosted (cloud).
- **SDK** — an npm package (`@enkaku/sdk`). `defineScript`, types, the `DeviceDriver` interface. Published so script authors can write in their own editor with full autocomplete.

**Core ⇄ Studio** communication is message-based over WebSocket (not REST-first), so the transport can move to a relay/tunnel model for cloud without changing the message contract.

```
packages/
  core/        # the Bun + Hono daemon (orchestrator)
  studio/      # the Next.js web UI
  sdk/         # defineScript, DeviceDriver, types — published to npm
  protocol/    # Core⇄Studio message schemas (Zod), shared types
  adb/         # adb client, track-devices, scrcpy-server manager
  scrcpy/      # the scrcpy protocol client (socket demux, meta decode) — version-locked to the core
  toolchain/   # runtime and tool provisioning (download, version, checksum)
  drivers/     # transport/display/input/inspection implementations
  agent/       # the cloud tunnel mini-core (M8)
apps/
  desktop/     # the Tauri shell (native window, tray, auto-update)
```

> **Architecture note (from the ws-scrcpy research):** there are two schools of running scrcpy in a browser. (a) **Modified scrcpy-server** — rebuild scrcpy-server with an embedded WebSocket server (used by the older NetrisTV/ws-scrcpy). (b) **Vanilla scrcpy-server** — use Genymobile's official .jar as-is, with the host multiplexing its TCP sockets into one WebSocket and the browser demuxing and decoding (used by the newer ws-scrcpy-web). **Enkaku picks (b)** because: using the official .jar means following upstream releases, no Java fork to maintain, and a checksum that can be verified against the official release. The consequence is that `packages/scrcpy` (the protocol client on both host and browser) is ours to maintain and pin (see §7.6).

---

## 5. Deployment modes

The key topology constraint: **the core must be near the devices** (USB or LAN). What can move to the cloud is the *control plane* (Studio, orchestrator, relay), while the core attached to the devices stays where they are.

### 5.1 Local self-host (default, easiest)

One binary (from `bun build --compile`). Double-click → the core starts → Studio is served on `localhost` → the browser opens automatically. SQLite is created in the app data dir. Devices are plugged in or connected over WiFi and auto-detected. **This is the "anyone can install it" mode.**

A tidier UX variant: a **Tauri** shell (native window, system tray, auto-update) wrapping the core and Studio.

### 5.2 Headless server / homelab

The core runs as a service (systemd) on a mini-PC, SBC, or Proxmox VM. Studio is reachable from a browser on any machine on the network. A good fit for 10 devices in an office. A Docker image is available.

### 5.3 Cloud (split control plane)

Studio, orchestrator, and relay live in the cloud (a container image, ready to deploy). Devices stay in the office, handled by a lightweight **agent** (a mini-core) that opens an **outbound WebSocket tunnel** to the control plane — so no port forwarding, and NAT is a non-issue.

This is also the SaaS monetisation path: customers run a small agent next to their devices while you host the control plane.

> **⚠️ v0.2 revision — cloud video needs a different transport.** WS + WebCodecs is fine on a LAN. But WebSocket is TCP; on the internet, one lost packet triggers TCP head-of-line blocking and **the whole video freezes** until the retransmit completes (very noticeable during real-time remote control). For cloud, the video path has to be reconsidered: the realistic option is **WebRTC** (`RTCPeerConnection`, UDP, congestion control plus partial reliability), or at minimum WebTransport (HTTP/3, QUIC). Control and queueing may stay on WS (loss there matters far less). **Architectural consequence:** the control plane's relay must be able to terminate WebRTC and repackage scrcpy's H.264 as RTP. This is not a flag — it is real work in M8. LANs stay on WS + WebCodecs (simpler, no TURN/STUN).

### 5.4 Cloud devices (optional, no physical phones)

For cases that do not need physical hardware: **redroid** (Android in a container) in the cloud. The core treats it exactly like a physical device over the `adb-tcp` transport. (Note: redroid is an emulator, so plenty of naive automation detection flags it immediately — good for throughput testing, poor for testing that needs a "real device".)

| Mode | Core location | Devices | Video transport | Who it is for |
|---|---|---|---|---|
| Local self-host | The user's machine | Local USB/WiFi | WS + WebCodecs | Non-experts, solo devs |
| Headless server | A box on the network | Local USB/WiFi | WS + WebCodecs | An office with 10 devices |
| Cloud split | Local agent plus a cloud control plane | Local, tunnelled | **WebRTC** | A SaaS product |
| Cloud devices | Cloud | redroid | WebRTC | Testing without physical phones |

---

## 6. Competitor and prior-art analysis (NEW in v0.2)

Research shows this category is crowded. But nothing fills Enkaku's gap (modern remote control plus orchestration plus automation, zero-config, sellable). This matters for the pitch **and** for borrowing the parts that are already proven.

### 6.1 STF / DeviceFarmer (OpenSTF)

The elephant in the room — exactly this category, open source (Apache-2.0), and nine years old.

- **What is good and worth borrowing:** the UI model (device grid, live browser control, drag-and-drop APK, shell, reverse port forwarding, battery monitoring), the *device booking/lease* concept, and `adbkit` (a Node adb client — worth studying as a reference even though we use Bun).
- **Weaknesses that become our opportunity:**
  - **OpenSTF is capped at Android 9.** The last official release, v3.4.1, does not run on Android 10–15. DeviceFarmer (a community fork) describes its own development as "slow, funded by volunteers' spare time".
  - **Screen capture uses `minicap`/`minitouch`** — old technology that struggles on newer Android and needs a prebuilt binary per ABI. We use scrcpy (H.264 encoded on the phone, far more efficient and modern).
  - **Setup is a nightmare** — it requires orchestrating RethinkDB plus many services plus a Docker ambassador. "Setting up took days." That is precisely the antithesis of our zero-config goal.
  - **A loose trust model** — their own documentation admits "little to no security between processes, devices are not reset between uses." We can position more carefully (clean leases, `finish` clean-state).
- **The lesson:** a device farm is a money sink (hardware is expensive). Positioning around a cheap appliance (§16) is a real differentiator.

### 6.2 ws-scrcpy and ws-scrcpy-web (the CLOSEST prior art)

`NetrisTV/ws-scrcpy` (and its successor `bilbospocketses/ws-scrcpy-web`) is exactly Enkaku's core technical pattern: a Node server pushes scrcpy-server to the device and multiplexes the video/audio/control sockets into **one WebSocket** (a 1-byte channel prefix), and the browser demuxes and decodes H.264/H.265/AV1 through **WebCodecs**.

- **The surprise (which validates our architecture):** ws-scrcpy-web **already** has bundled Node and ADB, an **in-app updater for Node/ADB/scrcpy-server**, a SQLite store, device labels, mDNS scanning, and an embeddable library (`WsScrcpy.startStream()`). That means our toolchain-manager-in-the-UI is the right path — somebody has already proven it.
- **Technical lessons to take:** use **vanilla scrcpy-server** with client-side demuxing (not a Java fork), multiplex with a 1-byte prefix, and use WebCodecs as the primary decoder with fallbacks (MSE/Broadway/TinyH264 for non-Chromium browsers).
- **The gap we fill (why not just use ws-scrcpy):** ws-scrcpy is a **mirroring tool**, not a farm platform. It has no lease/queue, no script framework, no multi-user or ACL, no capability-based driver selection, no jobs or artifacts, no schema-driven management. In Enkaku, ws-scrcpy's approach becomes **one display/input layer**, wrapped in orchestration and automation.
- **Their security warning (which we must not repeat):** every ws-scrcpy variant starts up with "no encryption, no authorization by default, listening on all interfaces." That is unacceptable in a product. Auth and TLS are mandatory in server and cloud modes (§14).

### 6.3 Appium (plus the uiautomator2 driver)

Not a device farm, but the **de-facto standard for Android automation**. Relevant as inspector inspiration and as an opt-in engine.

- **The lesson:** UiAutomator2 (Google-supported, Appium's default engine) is the most mature way to read a UI tree and inject actions. But Appium is heavy (~500 MB per session, a JVM), so it should be an **opt-in engine** (§7), never the default on a small box.
- **What we imitate more lightly:** the **openatx/uiautomator2** pattern — a persistent server APK (JSONRPC over HTTP) on the device, with fast queries. See §7.4.

### 6.4 Cloud services (BrowserStack, AWS Device Farm, HeadSpin, LambdaTest, DeviceLab)

- **Our positioning:** self-hostable, cheap, and the data never leaves (privacy for pre-release builds). That is exactly why people look for OpenSTF alternatives (privacy plus cloud cost).
- **What they have that we should imitate as sellable features:** parallel runs, device selection by capability, per-session video recording, CI integration (BrowserStack has a "Verified Step" on Bitrise — we can target similar CI integration later).

### 6.5 Summary table

| Capability | OpenSTF/DeviceFarmer | ws-scrcpy(-web) | Appium | Cloud SaaS | **Enkaku (target)** |
|---|---|---|---|---|---|
| Browser view and control | ✅ (minicap, old) | ✅ (modern scrcpy) | ❌ | ✅ | ✅ (modern scrcpy) |
| Android 14/15 support | ❌ (capped at 9) | ✅ | ✅ | ✅ | ✅ |
| Lease/queue/scheduler | ⚠️ (basic booking) | ❌ | ❌ | ✅ | ✅ |
| Script/automation framework | ❌ | ❌ | ✅ (code) | ⚠️ | ✅ (`defineScript`) |
| Multi-user plus ACL | ⚠️ | ❌ | ❌ | ✅ | ✅ |
| Zero-config install | ❌ (days) | ⚠️ (close) | ❌ | n/a | ✅ (target) |
| Toolchain manager in the UI | ❌ | ✅ (updater) | ❌ | n/a | ✅ |
| Self-hosted and cheap | ✅ | ✅ | ✅ | ❌ | ✅ |
| Hardware-like input (UHID) | ❌ | ⚠️ | ❌ | ❌ | ✅ (§9) |

---

## 7. Subsystem: drivers (five orthogonal layers) plus the toolchain

A "driver" is split into five separate abstractions so each layer can be swapped on its own. The best combination is usually a mix.

> **v0.4 revision.** This section described four layers until the network layer was added (plan 33). The first four are unchanged; `NetworkRoute` is the fifth and is the only optional one — its default engine is `none`, and a device with `none` behaves exactly as it did before the layer existed.

```ts
interface Transport {                         // 1. how to connect
  id: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  serial: string                              // the transport address (it can change!)
  stableId: string                            // stable device identity (see §7.5)
  exec(cmd: string): Promise<string>
}
interface DisplaySource {                     // 2. how to see the screen
  id: string
  start(): Promise<void>
  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): void
  stop(): Promise<void>
}
interface InputSink {                         // 3. how to send touches
  id: string
  mode: 'sdk' | 'uhid' | 'aoa'                // see §9
  tap(p: Point): Promise<void>
  swipe(from: Point, to: Point, ms: number): Promise<void>
  key(code: KeyCode): Promise<void>
  text(s: string): Promise<void>
}
interface Inspector {                         // 4. how to read the UI
  id: string
  dump(): Promise<UiNode>
  find(sel: Selector): Promise<UiNode | null>
  screenshot(): Promise<Uint8Array>
}
interface NetworkRoute {                      // 5. where the device's traffic goes (§7.9)
  id: string
  capabilities: NetworkCapabilities           // auth / enforcing / udp — declared, not assumed
  apply(cfg: NetworkConfig): Promise<void>
  observe(): Promise<NetworkObservation>       // what the DEVICE reports, not what we asked for
  revert(): Promise<void>                      // must be idempotent — the lease reaper calls it
}
```

A factory assembles them into one `DeviceSession`. A script only ever sees that handle, never the engines behind it.

```ts
const session = await createSession({
  deviceId,
  transport:  'adb-usb',        // ← chosen from a Studio dropdown
  display:    'scrcpy',
  input:      'scrcpy-uhid',    // the new default: hardware-like (§9)
  inspection: 'ui-server',      // a persistent on-device server (§7.4)
  network:    'none',           // the default: do not touch the device's routing (§7.9)
})
```

### 7.1 Planned engines (REVISED in v0.2)

| Layer | Engines | Notes |
|---|---|---|
| Transport | `adb-usb`, `adb-tcp` (wireless / redroid), `cloud-tunnel` | the tunnel is the agent's outbound WS |
| Display | `scrcpy` (H.264/H.265, default), `screencap-loop` (MVP/fallback, ~3 fps) | scrcpy encodes on the phone, the host only relays |
| Input | `scrcpy-uhid` (**the new default**, hardware-like), `scrcpy-sdk` (InputManager, broad compatibility), `scrcpy-aoa` (OTG, no adb), `adb-input` (crude fallback), `appium` (opt-in) | details in §9 |
| Inspection | `ui-server` (persistent on-device, default), `appium` (WebView/hybrid, opt-in), `ocr-pixel` (last resort) | replaces the naive `uiautomator dump` |
| Network | `none` (**the default**, never touches routing), `adb-proxy` (`settings put global http_proxy`), `adb-reverse-proxy` (`adb reverse` to a proxy on the host/agent), `vpn-helper` (an on-device helper app driven by intents) | details in §7.9; all hold the `network-route` lock so two of them can never be active at once |

### 7.2 Toolchain Manager (runtime provisioning) — the concept

This is what delivers "the user installs nothing". The pattern is Playwright's, which manages its own browser binaries, **and it is already proven** in ws-scrcpy-web (its in-app Node/ADB/scrcpy updater).

The core does **not** expect adb or scrcpy to exist on the system. Every tool is downloaded into a versioned app-local folder, and drivers resolve binary paths from there — **never from the system PATH**.

```
<app-data>/
  enkaku.db                         # SQLite
  tools/
    adb/
      35.0.1/adb                    # an installed version (users may swap)
      34.0.5/adb
      active -> 35.0.1              # the active-version pointer
    scrcpy-server/
      <locked>/scrcpy-server.jar    # PINNED to the core version, not user-swappable (§7.6)
    ui-server/
      <bundled>/ui-server.apk       # the on-device inspector server (§7.4)
    appium/                         # optional, opt-in
  artifacts/<job-id>/...
```

App-data dir per platform: `~/Library/Application Support/Enkaku` (macOS), `%APPDATA%\Enkaku` (Windows), `~/.local/share/enkaku` or `/var/lib/enkaku` (Linux/server).

### 7.3 Tool registry manifest

```ts
interface ToolManifest {
  id: 'adb' | 'scrcpy-server' | 'ui-server' | 'appium' | string
  displayName: string
  swappable: boolean            // NEW: false → users cannot pick a version (scrcpy-server, say)
  versions: ToolVersion[]
}
interface ToolVersion {
  version: string
  releasedAt: string
  compatibleCoreRange?: string  // NEW: the semver range of matching core versions (for coupled tools)
  platforms: {
    [platform: string]: { url: string; sha256: string; sizeBytes: number }
  }
  knownGood?: boolean
}
```

**Source abstraction** — each tool can come from: an official URL (Google platform-tools, scrcpy GitHub releases), a self-hosted mirror (air-gapped), or **pre-baked into an image** (cloud/container). The default is official.

### 7.4 Inspector: a persistent on-device server (major v0.2 revision)

**The problem with `uiautomator dump` (v0.1):** one dump takes 0.5–2 seconds, fails while the UI keeps changing ("could not get idle state"), and hangs in certain apps. A `waitFor` polling on top of that makes scripts crawl — a 15-second waitFor might only manage 8–10 checks. This is the speed bottleneck for the entire script framework.

**The solution (the openatx/uiautomator2 pattern):** deploy a **persistent instrumentation server** on the device (an APK or `app_process`) that exposes queries over local HTTP *forwarded* through adb. Start it once and use it many times (the device connects once rather than reconnecting per command). Selector queries execute **on the device** → far faster, far more tolerant of a changing UI, and capable of `set_text`/`long_click`/`double_click` directly on an element (much more reliable for WebViews).

- The MVP may still use `uiautomator dump` (M4) to get moving quickly, but `ui-server` is a priority upgrade path, because **inspector speed is farm speed**.
- `ui-server.apk` is bundled and managed by the Toolchain Manager (checksum, version follows the core).

### 7.5 Stable device identity (NEW in v0.2)

**The problem:** for wireless, the adb serial is an `ip:port` that keeps changing; the same phone over USB and over WiFi registers as **two devices** if identity comes only from the adb serial.

**The solution:** on connect, probe a stable identity once and cache it:
- Primary: `adb shell getprop ro.serialno` (the hardware serial).
- Fallback: `Settings.Secure.ANDROID_ID` (per-app-signing but stable across everything short of a factory reset).
- The adb serial is only a **transport address**, never an identity.

The effect: the "plug in over USB to enroll, then move to WiFi for daily use" flow produces no duplicate records. `devices.stableId` becomes the primary identity (see §12).

**Admission (v0.5, plan 56).** Resolving an identity does **not** make a phone a farm device. A `stableId` that has no `devices` row lands in a **Discovered** tray and waits for an operator to admit it by name.

The farm is therefore an allowlist, not a denylist. This matters because the adb server is usually shared — with Android Studio, with a developer's own phone, with whatever is plugged in to charge — and the previous behaviour made every one of those schedulable until somebody noticed. Blocking (§ plan 47) remains the outer layer and still wins over everything: a blocked `stableId` never reaches the tray.

Three consequences worth stating:

- A discovered phone **is** probed — `getprop` for the model, the Android version, and the identity itself — because a tray listing bare serial numbers cannot be acted on. Nothing else runs against it: no scrcpy, no guest agent, no ui-server, no network route.
- Discovered devices live in their own table rather than as a sixth `DeviceStatus`, so the scheduler, lease manager, wall, clusters and topology need no filter of their own — they query `devices`, which only ever holds members.
- **Forget** now works on a connected device, returning it to the tray. It previously had to be refused, because the registry would have re-enrolled it immediately, which forced an operator who only wanted a device *out of the farm* to declare it permanently unwelcome instead.

### 7.6 The scrcpy-server rule: PINNED to the core (critical v0.2 revision)

**Why this differs from adb:** the protocol between scrcpy-server.jar and the client is **not stable between versions** and is deliberately "internal" per Genymobile — their own documentation states the protocol *may (and will) change at any time, with no backward or forward compatibility, and the client must always run against a matching server version*. A concrete example: v3.1 required **client code changes** for coordinate mapping, not just a version bump. If the Tools UI let users freely pick a scrcpy-server version, one update would mean **video and control stop working entirely**.

The rule:
- `scrcpy-server` is `swappable: false` → in the Tools UI it appears as **"managed by core"** (version info and health, with no free version picker).
- One core version means one scrcpy-server version, tested together with our `packages/scrcpy` client. Raising the scrcpy version is part of a core release (via `compatibleCoreRange`).
- **adb may be swapped freely** (the adb protocol is stable across versions). scrcpy may not.

### 7.7 Tool management API and UI

```
GET  /api/tools                      → tools plus versions, active, swappable, health status
POST /api/tools/:id/install          → { version } download and verify (rejected when !swappable)
POST /api/tools/:id/activate         → { version } move the active pointer (rejected when !swappable)
DELETE /api/tools/:id/:version       → delete a version (rejected when active or in use)
POST /api/tools/:id/check            → health check (`adb version`, for instance)
POST /api/tools/manifest/refresh     → fetch the latest manifest
```

### 7.8 Tool security rules

- **sha256** verification is mandatory before a tool is used (checksums from the official release).
- Refuse to delete a version that is active or in use by a live session.
- Health check before setting a version active.
- Binary paths are resolved through the Toolchain Manager; drivers must never call the system PATH.
- **Licensing:** audit before selling — adb (platform-tools, Google's ToS on redistribution), scrcpy (Apache-2.0, fine), redroid, and so on. See §18.

### 7.9 Network layer: routing a device's traffic (NEW in v0.4)

The QA requirement is ordinary: point a device at a capture proxy to inspect **your own** app's traffic, test against a mocked backend, or check a regional catalogue. The layer exists so that requirement is met **without** a script gaining a raw shell.

The three working engines are a capability ladder, and each rung buys something the one below it cannot do:

| Engine | Auth | Enforcing | Needs an APK | Notes |
|---|---|---|---|---|
| `adb-proxy` | ✗ | ✗ (advisory) | ✗ | `settings put global http_proxy host:port`. `global` is Android's settings namespace — device-wide, **not** farm-wide. The value is world-readable by every app on the device, so credentials must never be placed in it. |
| `adb-reverse-proxy` | ✓ | ✗ (advisory) | ✗ | `adb reverse` to a proxy on the host/agent, which holds the upstream credentials. Works over USB and needs no shared LAN; **the credentials never touch the device**. This is the default recommendation. |
| `vpn-helper` | ✓ | ✓ | ✓ | An on-device helper app using `VpnService`. The only rung an app cannot ignore. The intent contract is **app-specific** — it is a per-app profile (§7.10), not an Android standard. |

Rules that hold for every engine on this layer:

1. **Configuration is bound to the device, never to the lease** (revised in v0.6 by `docs/plans/52-m24c-device-scoped-routes-and-stable-identity.md`, superseding this rule's original lease-scoped form). A route survives lease release, expiry via the reaper, client disconnect, a device reboot, and a core restart; only an explicit act — switching it off, removing it, or uninstalling the agent — tears it down. The original rule bound configuration to the lease specifically to stop one tenant's routing from silently leaking into the next tenant's session, and that concern was real — but tying a network identity to *whoever happens to be holding control* turned out to be the wrong model for a farm where a device is expected to present a consistent regional identity across sessions: an operator set a proxy, checked the device's geo IP, and got their own real address because the lease had idle-timed-out ninety seconds earlier and torn the route down with it. The isolation the old rule provided is kept, just moved: a device's route, its upstream, and who set it are shown wherever the device is shown, and every change is recorded to the device event log (rule 5) with an actor — so a tenant who acquires an already-routed device sees that immediately, rather than being silently protected by a teardown they never asked for. On a device coming back online, or on core start, the route is *restored*, never blindly re-applied: it is probed first, and only brought up when the device reports no route already running — a stored route may point at an upstream that has since expired, and reapplying blind would produce a device that looks routed and carries nothing.
2. **Declared intent and observed state are separate reads.** `getConfig()` returns what was requested; `observe()` returns what the device reports. They diverge (a VPN drops, a reboot clears the setting), and the drift must be visible rather than assumed away.
3. **`apply()` is not a success signal.** An engine that can verify egress must offer `probe()`; without a probe, the status is reported as `unverified`, never as `ok`.
4. **Credentials are referenced, never inlined.** Scripts and run configs name a stored credential; raw secrets never enter script params, the `jobs` table, artifacts, or the device event log.
5. **Every change is recorded** to the device event log (`network.*` kinds) with the secret redacted.
6. **HTTPS interception is out of scope and cannot be solved here.** Reading TLS payloads needs a trusted CA, which since Android 7 means a debug build of your own app with a matching network security config. The layer routes traffic; it does not decrypt it.

### 7.10 The `vpn-helper` engine is served by a first-party agent

> **v0.5 revision.** This section originally described driving a *third-party* VPN app through a declarative intent profile. Research has ruled that approach out; see `docs/research/android-guest-agent.md` for the verified findings and their sources.

Two results kill the third-party-profile idea outright. First, **`adb shell am` cannot reach components declared `exported="false"`** — only root and system bypass the export check, and shell is neither; worse, `am broadcast` fails *silently* with exit code 0. Second, real candidate apps export nothing usable: SocksDroid's manifest exports only its launcher activity, with its VPN service and boot receiver both unexported. There is therefore no intent contract to declare, for that app or most others.

So `vpn-helper` is served by **`enkaku-guest-agent`**, a first-party APK, provisioned through the Toolchain Manager (§7.2) with a pinned sha256 and installed with `adb install -r -g`, reusing the `ui-server` path (§7.4). It is controlled over a `localabstract` socket reached with `adb forward` — typed request/response, so the engine can *read* state rather than fire intents blindly, which is what makes `observe()` and `probe()` (§7.9) truthful rather than assumed.

Three platform facts constrain it and must not be rediscovered the hard way: the agent's entry components have to be `exported="true"` and guarded by a token in the payload rather than a signature permission; a freshly installed app sits in the stopped state and receives **no** broadcasts — including `BOOT_COMPLETED` — until the host explicitly launches it once; and the `VpnService` consent dialog is pre-granted non-interactively with `appops set <pkg> ACTIVATE_VPN allow`, which writes exactly the state the dialog writes. That last one is `@hide` and undocumented, so it is pinned by a per-release smoke test, never assumed.

The agent is scoped as a general on-device helper with negotiated capabilities, not a proxy shim: provisioning cost is per-app rather than per-feature, and SOCKS routing is simply its first capability.


---

## 8. Registry and schema-driven UI

Every pluggable component **describes itself** through a schema, and Studio renders the UI from it.

```
GET /api/registry
→ {
    transports:  [{ id, displayName, capabilities, configSchema, locks }],
    displays:    [{ id, displayName, capabilities, configSchema, locks }],
    inputs:      [{ id, displayName, capabilities, configSchema, locks }],
    inspectors:  [{ id, displayName, capabilities, configSchema, locks }],
    tools:       [{ id, displayName, swappable }],
  }
```

`configSchema` is a JSON Schema (generated from Zod). Studio uses a schema-driven form renderer, so every engine and tool automatically gets a settings panel with no hardcoded UI. **Capabilities and locks** validate combinations: Studio disables impossible or conflicting choices (an Appium inspector needs an Appium transport; `appium` input and `scrcpy-uhid` both claim `input-injection`) before anyone can pick wrongly.

---

## 9. Input injection modes and detection testing (NEW and REVISED in v0.2)

This section answers the need for "automation the phone's systems cannot trivially spot" — **framed correctly: testing your own app's detectors (red-teaming), not building a stealth bot**. The positioning stays QA (§17). What follows is legitimate QA knowledge: understanding the *detection surface* so you can test your own app.

### 9.1 Why automation is detectable — the detection surface

An app can distinguish real input from injected input through several signals. The most important: **where the event came from, and its flags.**

- **SDK mode (the default for many tools, including `adb shell input` and scrcpy `--mouse=sdk`):** events are injected through `InputManager.injectInputEvent` at the Android API level. These events can carry markers that distinguish them from a hardware touch (event source attributes and flags, and never passing through the kernel input driver). A detector can check for this. Also: `adb shell input` is slow and obviously patterned (rigid timing).
- **UHID mode (scrcpy 2.4+, `--keyboard=uhid`/`--mouse=uhid`):** scrcpy creates a **virtual HID device through the kernel's UHID module**. From Android's side this appears as a genuine *physical input device* (through the kernel input driver), not an API-injected event. It works **wirelessly** (no OTG cable needed). This is far closer to real hardware.
- **AOA/OTG mode (scrcpy `--otg`):** scrcpy becomes a **physical HID peripheral** through the Android Open Accessory protocol, **bypassing Android's input stack entirely** — it does not even need USB debugging. The most "pure hardware" option, but it needs a USB cable and carries no video (OTG only).

**The implication for Enkaku:** the default input becomes **`scrcpy-uhid`** (hardware-like, wireless-friendly), with `scrcpy-sdk` as a compatibility fallback (UHID needs its layout configured once, and certain features need certain Android versions). For extreme cases (testing an app that checks very deeply), `scrcpy-aoa` is available opt-in. This gives the device under test input that resembles hardware — **useful for QA: it exercises the app's real code path**, rather than its "this is definitely a bot" path.

### 9.2 The advantage of real devices (over emulators)

A physical phone automatically passes a lot of naive detection: real sensors (accelerometer, gyroscope), a real IMEI and serial, no emulator properties (`ro.kernel.qemu` and friends), and touches from a real driver. That is a structural advantage over redroid and emulators — and the reason a real-device farm is still relevant.

### 9.3 Realistic input profiles (timing) — standard QA practice

The timing jitter feature (`DeviceSettings.timing`) makes test traffic resemble a human so tests **exercise the app's real code path** (many apps have separate paths for fast robotic interaction and human interaction). This is QA practice, not "hopefully nobody notices". Tap jitter, pauses between actions, and small coordinate variation.

### 9.4 Instrumentation, not blind evasion (the core of the positioning)

Because you hold **both sides** (the detector and the farm), the correct and far more precise approach is:
1. **Tag all traffic from the farm** (an internal header or marker) — *on by default*.
2. Run scenarios and see which the detector flags and which slip through.
3. What slips through is a detector gap → fix the detector. What gets flagged despite being human-like is a false positive → tune it.
4. Build a **farm ⇄ detector feedback loop** you can iterate on.

This is engineering you can sell ("an anti-fraud test harness") and is legally and ToS-safe because it is aimed at *your own app*.

### 9.5 Capability locks (so engines cannot collide)

```ts
scrcpyDisplay.locks   = ['video-encoder']
scrcpyUhidInput.locks = ['input-injection']
scrcpySdkInput.locks  = ['input-injection']
uiServer.locks        = ['instrumentation']
appiumInspector.locks = ['instrumentation', 'input-injection']  // conflicts with scrcpy input
```

The session manager refuses to activate a second engine that claims the same resource → a user **can never** select two engines that would tread on each other.

---

## 10. Session, lease, queue, scheduler

### 10.1 Device state machine

```
offline → idle → { manual | busy }
```

`manual` (remote touch active) and `busy` (automation running) are **mutually exclusive**. While `busy`, control messages from a client are **rejected by the core** (not merely disabled in the UI). The video stream keeps running, so a client can still watch the automation.

### 10.2 Lease plus heartbeat

The runner heartbeats every ~15 seconds to extend the lease. An expired lease fails the job and force-releases the device. Without this, one stuck script (ANR, freeze, disconnect) means a dead device until a restart.

### 10.3 The queue in SQLite

The queue is **per device** (the device is the constraint). A single-writer transaction:

```sql
BEGIN IMMEDIATE;
UPDATE jobs
SET status='running', lease_expires_at = strftime('%s','now') + 60
WHERE id = (
  SELECT j.id FROM jobs j
  JOIN devices d ON d.id = j.device_id
  WHERE j.status='queued' AND d.status='idle'
  ORDER BY j.priority DESC, j.created_at
  LIMIT 1
)
RETURNING *;
COMMIT;
```

SQLite was chosen for zero setup (**and is retained** — per instruction, this decision does not change). The ORM is Drizzle. The DB driver stays abstracted in case Postgres is needed later, but the default is SQLite.

### 10.4 Serialising adb access (v0.3 revision — a scaling global semaphore, not a fixed one)

**The v0.1 problem:** "one global mutex in front of every adb exec" is far too coarse. If device A is running `adb install app.apk` (30–60 seconds), devices B through J all wait — including heartbeats and other users' manual input. Fatal at 10 devices.

**The v0.2 revision:** the adb server is in fact reasonably safe for many clients using different `-s <serial>` values. The classic problem is not exec concurrency but **device-discovery races** and stray `adb kill-server` calls.

- A **per-device command queue** (serialising commands *within* one device) — unchanged by this revision; one device still runs one adb command at a time.
- A **global semaphore that scales with fleet size** (plan 23 §3.2), not a fixed constant: `auto = min(24, max(6, ceil(nonOfflineDeviceCount * 0.75)))`. The floor of 6 keeps a small setup (≤4 devices) at the same concurrency as before this revision; the ceiling of 24 is deliberate — the adb server itself becomes the bottleneck above it on a typical host, and a farm that needs more should run a second core (the cloud agent model already provides this). `nonOfflineDeviceCount` excludes offline devices, so an unplugged phone does not reserve capacity. The farm setting `adb.maxConcurrent` (default `0` = auto) lets an operator pin a lower or higher value (up to the ceiling) instead of the formula, and it takes effect immediately, with no restart.
- **`adb kill-server` is FORBIDDEN** anywhere except the Toolchain Manager during an adb version swap (and even then, only after draining every session).
- Heavy operations (install, uninstall, large pushes) run without blocking heartbeats or control of other devices.

---

## 11. Script framework

### 11.1 Script shape (`defineScript`)

Three phases: `prepare` (get the device ready, may fail and retry), `run` (the real work), `finish` (**always** runs, cleans up state).

```ts
export default defineScript({
  id: 'post-content',
  version: '2.0.0',
  params: z.object({ caption: z.string(), imagePath: z.string() }),
  timeout: 180_000,
  retries: 1,

  async prepare(ctx) {
    await ctx.device.app.forceStop('com.myapp')
    await ctx.device.app.launch('com.myapp')
    await ctx.device.waitFor({ text: 'Home' }, { timeout: 15_000 })
  },

  async run(ctx) {
    const { device, params, artifact } = ctx
    await device.tap({ desc: 'New post' })
    await device.waitFor({ id: 'caption_input' })
    await device.type(params.caption)
    await artifact.screenshot('before-post')
    await device.tap({ text: 'Share' })
    await device.waitFor({ text: 'Sent' }, { timeout: 30_000 })
    return { ok: true }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop('com.myapp')
  },
})
```

### 11.2 Rules that make it solid

- **`finish` always runs** → the device comes back clean → the queue can safely continue.
- **Every job is a child process** (`Bun.spawn`). A timeout means a forced kill. Crashes are isolated. Logs and artifacts are per job.
- **`params` is a Zod schema** → Studio auto-generates the input form.
- **`waitFor` polls the inspector** (`ui-server`, fast), it is not a sleep.
- **Selectors are layered** (stable → fragile): `{ id }` → `{ desc }` → `{ text }` → `{ point }`.
- **`find` answers `null` when it cannot answer** (plan 60 §3.1). A selector that only resolves to a viewport-sized container is not a match: `tap` aims at a node's centre, so acting on one presses the middle of the page. The grammar stays at four shapes — `ctx.device.dump()` returns the whole tree (334–584 ms) for everything a selector cannot reach.
- **Artifacts per job**: screenshots, logs, results, stored against the job id → auditable.

### 11.3 Trust model and isolation (HONEST CORRECTION in v0.2)

**v0.1 said "sandbox: limits child process fs/network access". That was an overclaim.** Bun does **not** have a permission model like Deno's; a `Bun.spawn` child process has full fs and network access as its OS user.

What is actually true:
- **The isolation that EXISTS is crash containment**, not a security boundary: a child process plus a hard-timeout kill means a user's script cannot crash the core or hang it. That is the entire promise in local/single-tenant mode.
- **The local/self-host trust model is "the script author is a trusted operator."** Do not write "secure sandbox" in marketing.
- **If a real security boundary is needed** (mandatory for multi-tenant cloud later): that requires **a container, gVisor, or a microVM per job**, or at minimum a separate OS user. This is an architectural change (part of §18/M8), not a flag.
- Only the `device`, `artifact`, and `log` APIs are exposed to a script as a *convenience*, not as a security guarantee.

### 11.4 Dependencies and publishing (NEW in v0.2)

Scripts are stored as source in the DB — but what about npm packages? The flow: the SDK CLI `enkaku publish` *bundles* the script plus its dependencies into a single file (esbuild/bun build), and the farm only ever accepts a **finished bundle**. This simplifies the runner and makes dependencies deterministic.

### 11.5 Lifecycle and management

CRUD through Studio: create, edit, version, enable/disable, delete, run with parameters. Script authors write in their own editor with `@enkaku/sdk`, then publish to the farm.

---

## 12. Data model (SQLite + Drizzle)

```ts
export const devices = sqliteTable('devices', {
  id:        text('id').primaryKey(),          // internal id
  stableId:  text('stable_id').notNull().unique(), // ro.serialno / ANDROID_ID (§7.5)
  serial:    text('serial').notNull(),         // the adb transport address (can change)
  label:     text('label').notNull(),
  ownerId:   text('owner_id'),

  androidVersion: text('android_version'),
  apiLevel:  integer('api_level'),             // NEW: for feature gating (UHID and so on)
  screenW:   integer('screen_w'),
  screenH:   integer('screen_h'),
  density:   integer('density'),               // required for coordinate mapping

  transport:  text('transport').default('adb-usb'),
  display:    text('display').default('scrcpy'),
  input:      text('input').default('scrcpy-uhid'),   // the new default
  inspection: text('inspection').default('ui-server'),

  battery:   text('battery', { mode: 'json' }).$type<BatteryState>(), // NEW (§15)
  settings:  text('settings', { mode: 'json' }).$type<DeviceSettings>(),
  status:    text('status').default('offline'),   // offline|idle|manual|busy|quarantined
  lastSeen:  integer('last_seen', { mode: 'timestamp' }),
})

export const scripts = sqliteTable('scripts', {
  id:        text('id').primaryKey(),
  name:      text('name').notNull(),
  version:   text('version').notNull(),
  bundle:    text('bundle').notNull(),         // the publish output (a finished bundle, §11.4)
  paramsSchema: text('params_schema', { mode: 'json' }),
  enabled:   integer('enabled', { mode: 'boolean' }).default(true),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const jobs = sqliteTable('jobs', {
  id:        text('id').primaryKey(),
  scriptId:  text('script_id').notNull(),
  deviceId:  text('device_id').notNull(),
  params:    text('params', { mode: 'json' }),
  priority:  integer('priority').default(0),
  status:    text('status').default('queued'), // queued|running|success|failed|cancelled
  leaseExpiresAt: integer('lease_expires_at'),
  result:    text('result', { mode: 'json' }),
  error:     text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
})

export const artifacts = sqliteTable('artifacts', {
  id:      text('id').primaryKey(),
  jobId:   text('job_id').notNull(),
  kind:    text('kind').notNull(),             // screenshot|log|file|video
  label:   text('label'),
  path:    text('path').notNull(),
  sizeBytes: integer('size_bytes'),            // NEW: for retention and GC (§18)
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const users = sqliteTable('users', {
  id:      text('id').primaryKey(),
  email:   text('email').notNull().unique(),
  role:    text('role').default('operator'),   // admin|operator
  passwordHash: text('password_hash'),         // argon2
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const toolInstalls = sqliteTable('tool_installs', {
  id:      text('id').primaryKey(),
  toolId:  text('tool_id').notNull(),
  version: text('version').notNull(),
  active:  integer('active', { mode: 'boolean' }).default(false),
  sha256:  text('sha256'),
  installedAt: integer('installed_at', { mode: 'timestamp' }),
})

export const auditLog = sqliteTable('audit_log', {   // NEW (§14)
  id:     text('id').primaryKey(),
  userId: text('user_id'),
  action: text('action').notNull(),            // job.run|device.enroll|tool.activate|...
  target: text('target'),
  meta:   text('meta', { mode: 'json' }),
  at:     integer('at', { mode: 'timestamp' }),
})
```

`DeviceSettings` (JSON, validated by Zod):

```ts
const DeviceSettings = z.object({
  timing: z.object({
    tapJitterMs:     z.tuple([z.number(), z.number()]).default([40, 120]),
    betweenActionMs: z.tuple([z.number(), z.number()]).default([300, 900]),
    coordJitterPx:   z.number().default(2),    // NEW (§9.3)
  }),
  prep: z.object({
    disableAnimations: z.boolean().default(true),
    stayAwake:         z.boolean().default(true),
  }),
  input: z.object({
    preferredMode: z.enum(['uhid', 'sdk', 'aoa']).default('uhid'),  // NEW (§9)
  }),
  autoReconnect: z.boolean().default(true),
})
```

Screen dimensions, density, and apiLevel **must** be probed once on connect and cached — coordinate mapping and feature gating (UHID needs a particular Android version) depend on them.

---

## 13. The Core ⇄ Studio protocol

Message-based over WebSocket. Categories:

- **Device events**: `device.added`, `device.removed`, `device.status` (from `adb track-devices`, not polling).
- **Enrollment**: `device.unauthorized`, `device.pairing.request`, `device.pairing.code` (§15.1).
- **Control** (manual): `input.tap`, `input.swipe`, `input.key`, `input.text` → the core validates the lease and rejects while `busy`.
- **Video**: on a LAN, a stream of H.264 bytes (scrcpy) → the browser's WebCodecs `VideoDecoder`. In the cloud, WebRTC negotiation (§5.3).
- **Queue/job**: `job.enqueue`, `job.status`, `job.log`, `job.artifact`.
- **Registry/tools**: introspection plus tool operations.

REST handles ordinary request-response (script and tool CRUD). WebSocket handles streaming and realtime. The contract lives in `packages/protocol` (Zod), shared and type-safe.

---

## 14. Security and isolation

- **Server-authoritative**: leases, resource conflicts, and ACL live in the core.
- **Auth (REVISED in v0.2):**
  - Local single-user (the non-expert mode): may **auto-create an admin** and skip login for zero-config — BUT only when bound to `localhost`.
  - Server/cloud mode: login is **mandatory** (argon2 hashes), with session tokens. The agent tunnel uses a token.
  - **TLS is mandatory** in server and cloud modes (do not repeat the ws-scrcpy mistake: "no encryption, no auth, listening on all interfaces").
- **Crash containment (not a sandbox)**: every job is a child process with a hard-timeout kill (§11.3). A real security boundary (container or microVM) is multi-tenant cloud work (§18).
- **Tool integrity**: sha256 is mandatory.
- **adb access**: a per-device queue plus a loose semaphore, and no stray `kill-server` (§10.4).
- **Audit**: who ran what, enrolled which device, activated which tool → recorded (`audit_log`).
- **Data hygiene (a lesson from STF):** an option to *reset devices between leases* (clear app data, log out) so accounts and credentials do not leak between users — important for multi-user farms.

---

## 15. Device lifecycle: enrollment, battery, thermal (NEW in v0.2)

### 15.1 The enrollment flow (do not underestimate it)

"Plug in a device, it is auto-detected" glosses over real steps that make a bad *first impression* when they are ignored:

- **USB debugging authorization**: the RSA fingerprint dialog has to be *accepted on the phone's screen*. The core detects the `unauthorized` device state → Studio shows a wizard: "check the phone's screen, tap Allow, tick Always."
- **Wireless ADB (Android 11+)**: needs the **pairing code flow** (`adb pair host:port` plus a 6-digit code from the phone). Studio provides a pairing code input with visual instructions.
- Once authorized → probe stableId, dimensions, and apiLevel → register.

For 10 internal devices this is trivial; for a product being sold it is a make-or-break moment. The enrollment wizard is a feature, not an afterthought.

### 15.2 Battery and thermal (promoted from "future" to an early feature)

A farm of phones on chargers 24/7 risks **swollen batteries** (a safety and support-cost problem). From the early milestones at minimum:
- Read `dumpsys battery` (level, temperature, charging status) → show it on the dashboard.
- **Auto-quarantine** a device once its temperature passes a threshold (status `quarantined`, out of the scheduling pool).
- Backlog: charge limiting (many phones support it via `dumpsys` or vendor APIs — capping charge at 80%, for instance).

---

## 16. Non-functional requirements (NEW in v0.2 — with numbers)

v0.1 said "low latency" with no target. Define them so M2 and M6 have a definition of done, and so there is something to market:

| Metric | Target (LAN) | Notes |
|---|---|---|
| Glass-to-glass latency (manual control) | < 150 ms | scrcpy H.264 plus WebCodecs |
| Video FPS | ≥ 24 fps (may drop while idle) | depends on the phone and Android version |
| Inspector query (`ui-server`) | < 200 ms per find | versus 0.5–2 s for `uiautomator dump` |
| First-run provisioning | < 90 seconds | downloading adb, scrcpy, ui-server |
| Max devices per host (Intel N100, 4 GB) | 10–15 | I/O-bound; scrcpy encodes on the phone |
| Max devices per host (SBC, 1–2 GB) | 4–6 | adb-only edition, wireless ADB |
| Job overhead (spawn → prepare) | < 3 seconds | child process plus attaching ui-server |

Marketing angle: *"10 devices on a ~$150 mini-PC."*

---

## 17. Positioning and acceptable use (the QA framing)

- **The positioning is a QA / test-automation device farm** (BrowserStack-style), not "undetectable social media bots". The QA framing is safer legally and in ToS terms, the market is larger, and the customer is a developer testing *their own* app.
- **The acceptable-use policy is a product default, not just a document.** Farm traffic instrumentation and tagging is **on by default** (§9.4). Timing jitter and UHID input are documented in the context of *test realism* (exercising the app's real path), not evasion.
- **Testing your own detectors**: instrumentation beats blind evasion. A farm ⇄ detector feedback loop (§9.4).
- **The network layer (§7.9) is a single operator-set route per lease, and deliberately nothing more.** There is no proxy pool, no rotation, and no binding of a route to an account or persona — the absence of those abstractions is a design decision, not a missing feature. A route that is explicit, lease-scoped, and written to the device event log serves every QA use case listed in §7.9; rotation serves only the goal of stopping a third-party platform from clustering accounts by network origin, which §17 and the AUP place outside the product.
- **When sold**: include the AUP; default features are aimed at testing your own apps; the real-device advantage (§9.2) becomes a legitimate QA selling point.

---

## 18. Housekeeping and business plumbing (NEW in v0.2)

Things that will certainly happen and that often stall indie products:

- **Artifact retention and GC**: per-job screenshots and video pile up fast. This needs a policy: a per-device or global quota, a TTL, or a max size with LRU eviction. `artifacts.sizeBytes` is already in place.
- **Licensing and redistribution**: audit before selling — adb/platform-tools (Google's ToS), scrcpy (Apache-2.0 ✅), redroid, npm dependencies. Write a `LICENSES.md`.
- **Business plumbing (if selling seriously)**: docs and onboarding, licence keys and activation, opt-in telemetry, a support channel, an update channel. This is a real milestone (M7.5).
- **A cloud security boundary**: multi-tenancy needs isolation between customers plus a container or microVM per job (§11.3). Do not promise safe multi-tenancy before that exists.

---

## 19. Studio — screen spec

| Screen | Contents |
|---|---|
| **Dashboard** | A device grid (optional live thumbnails), status (idle/manual/busy/offline/quarantined), owner, **battery and temperature badges**. Quick actions: control / run. |
| **Enrollment wizard** | Detects `unauthorized` and wireless pairing, visual instructions, pairing code input (§15.1). |
| **Device detail / live control** | Video stream plus click input, a driver selection panel (dropdowns, validated by capabilities and locks), **input mode choice uhid/sdk/aoa**, per-device settings (schema-driven), a prep button. While `busy`: input disabled, video still running, an "automation running" badge. |
| **Scripts** | List, editor, versioning, enable/disable, run (parameter form generated from Zod), job history, publish button. |
| **Job / run detail** | Status, realtime logs, artifacts (screenshots and video per step), result or error. |
| **Tools (Toolchain)** | Per tool: installed versions (with an active badge) plus available ones, install/update/activate/delete, progress, health check, manifest refresh. **scrcpy-server appears as "managed by core" (read-only).** |
| **Settings** | Farm-wide defaults (driver, timing, default input mode), users and ACL (admin), retention policy, DB backup and restore. |

The rendering principle: every config panel is rendered from a schema through the schema-driven form renderer — no hardcoded UI per component.

---

## 20. Roadmap / milestones (REVISED in v0.2)

| Phase | Deliverable | Focus |
|---|---|---|
| **M0 — Foundations** | Monorepo, core daemon, `packages/adb` (client plus `track-devices`), device registry (**stableId probing**) → SQLite → WS broadcast, **per-device queue plus adb semaphore**. | Devices visible in the API in realtime, with a stable identity. |
| **M1 — Toolchain** | Manifest, download plus checksum, versions, active pointer, the **swappable flag**, API plus first-run auto-provisioning. | Genuinely zero-config "install and run". |
| **M2 — Basic control** | `screencap-loop` plus `adb-input`, end-to-end coordinate mapping validation, Studio live view and click, the **enrollment wizard**. | Manual remote control works (roughly) and devices enroll correctly. |
| **M3 — Session/lease/queue** | State machine, lease plus heartbeat, per-device queue (with a dummy `sleep` job at first). | Get queueing and device safety right first. |
| **M4 — Script framework** | `defineScript`, the subprocess runner, artifacts and logs, `@enkaku/sdk`, the inspector (starting with `uiautomator dump`, preparing `ui-server`). | Mature, isolated automation. |
| **M4.5 — ui-server** | A persistent on-device inspector (the uiautomator2 pattern), fast `find`/`waitFor`, `set_text`. | Inspector speed is farm speed. |
| **M5 — Studio complete** | Script CRUD plus run form and publish, job detail, the Tools UI, settings, the schema-driven renderer, the registry, **battery/thermal plus auto-quarantine**. | A fully dynamic UI plus device health. |
| **M6 — scrcpy** | The `scrcpy` display (H.264 relay, **version-locked**) plus **`scrcpy-uhid` input** plus WebCodecs decoding plus a fallback decoder. | Low latency, hardware-like input, production quality. |
| **M7 — Multi-user and packaging** | Auth/ACL plus TLS, a single binary, a Docker image, the Tauri shell, auto-update, retention and GC. | Ready to self-host. |
| **M7.5 — Business plumbing** | Docs, licence/activation, opt-in telemetry, the AUP, support and update channels, `LICENSES.md`. | Ready to sell. |
| **M8 — Cloud and extra drivers** | The cloud tunnel agent, a split control plane, **WebRTC video**, a per-job security boundary (container or microVM), opt-in `appium`, redroid, `scrcpy-aoa`. | Scale, flexibility, safe multi-tenancy. |

A note on ordering: **M3 before M4** is deliberate (getting queue and lease right with a fake job beats debugging the queue and the automation at the same time). **M4.5 and the M6 input work** were added because inspector speed and input realism are the two main axes of differentiation from competitors.

---

## 21. Research sources (v0.2 verification)

The technical claims in v0.2 were verified against primary sources (accessed 2026):

- **The scrcpy protocol is not stable between versions** — Genymobile/scrcpy's official developer documentation (`doc/develop.md`): the client↔server protocol is "internal, may (and will) change at any time, no backward/forward compatibility." Example client changes in v3.1 (issue #5733), version mismatches (issues #4276, #3421). → the basis for the §7.6 rule.
- **Input modes (SDK/UHID/AOA)** — the scrcpy DeepWiki "Advanced Topics", release notes for v2.4 (UHID keyboard/mouse) and v3.3 (UHID mouse virtual display), issues #4034 and #5473. → the basis for §9.
- **STF/DeviceFarmer status** — the DeviceFarmer/stf and openstf/stf repos (README: slow development, a loose trust model), plus alternative analyses (OpenSTF capped at Android 9). → the basis for §6.1.
- **ws-scrcpy / ws-scrcpy-web** — the NetrisTV/ws-scrcpy and bilbospocketses/ws-scrcpy-web repos (vanilla scrcpy-server, 1-byte prefix multiplexing, WebCodecs, in-app updater, SQLite, the no-auth-by-default warning). → the basis for §4 and §6.2.
- **uiautomator2 (openatx)** — the openatx/uiautomator2 and android-uiautomator-server repos (a persistent JSONRPC server APK, fast `dump_hierarchy` but laggy on a changing UI — issue #116). → the basis for §7.4.
- **The Appium UiAutomator2 driver** — the appium/appium-uiautomator2-driver repo (a Google-supported engine, heavy). → the basis for §6.3.

---

## 22. Open questions / future

- Full multi-tenancy in the cloud (isolation plus a per-job security boundary).
- A script marketplace (buying and selling automation scripts).
- Recording → script generation (record manual actions into a draft `defineScript`).
- Parallel runs across devices with capability-based routing ("run on any Android 15 device").
- CI integration (GitHub Actions, a Bitrise verified step) — competitors already have this.
- Per-session video recording as a standard artifact (for audit and QA reports).
- iOS support (far more complicated — WDA/Appium, needs a macOS host).

---

*Enkaku — draft v0.2. All names and numbers may change. The v0.2 changes are based on prior-art research and primary-source verification; the default decisions (SQLite, Bun/Hono, Next.js, monorepo) are retained as directed.*
