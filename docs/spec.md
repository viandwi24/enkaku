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
  node/        # the cloud tunnel mini-core (M8) — called "agent" before plan 61 renamed it
apps/
  desktop/     # the Tauri shell (native window, tray, auto-update)
```

> **Naming note** *(corrected in reconciliation, 2026-08-09, DIV-009/DIV-055 — a manager decision, not sent to the owner, since this is factual staleness rather than a scope question).* The package on disk, and every product-facing name, is `node` — `agent` was the name of this same process only until plan 61 renamed it, freeing "agent" for the unrelated in-product AI agent feature (§12.1). This tree, §5.3, and §7.1's Transport row previously still said `agent/` here; only §14 had caught up. `ai_agents` (§12.1) and `nodes` are two different things that happen to both have been called "agent" at different points in this project's history — see §12.1 for why that distinction is kept explicit everywhere.

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

Studio, orchestrator, and relay live in the cloud (a container image, ready to deploy). Devices stay in the office, handled by a lightweight **node** (a mini-core, called "agent" before plan 61 — see §4) that opens an **outbound WebSocket tunnel** to the control plane — so no port forwarding, and NAT is a non-issue. Node management is a real REST API: `POST /api/nodes/enroll`, `GET/POST /api/nodes`, `DELETE /api/nodes/:id`, `GET /api/nodes/ice-config` *(added in reconciliation, 2026-08-09, DIV-042)*.

This is also the SaaS monetisation path: customers run a small node next to their devices while you host the control plane.

> **⚠️ v0.2 revision — cloud video needs a different transport.** WS + WebCodecs is fine on a LAN. But WebSocket is TCP; on the internet, one lost packet triggers TCP head-of-line blocking and **the whole video freezes** until the retransmit completes (very noticeable during real-time remote control). For cloud, the video path has to be reconsidered: the realistic option is **WebRTC** (`RTCPeerConnection`, UDP, congestion control plus partial reliability), or at minimum WebTransport (HTTP/3, QUIC). Control and queueing may stay on WS (loss there matters far less). **Architectural consequence:** the control plane's relay must be able to terminate WebRTC and repackage scrcpy's H.264 as RTP. This is not a flag — it is real work in M8. LANs stay on WS + WebCodecs (simpler, no TURN/STUN).

### 5.4 Cloud devices (optional, no physical phones)

For cases that do not need physical hardware: **redroid** (Android in a container) in the cloud. The core treats it exactly like a physical device over the `adb-tcp` transport. (Note: redroid is an emulator, so plenty of naive automation detection flags it immediately — good for throughput testing, poor for testing that needs a "real device".)

| Mode | Core location | Devices | Video transport | Who it is for |
|---|---|---|---|---|
| Local self-host | The user's machine | Local USB/WiFi | WS + WebCodecs | Non-experts, solo devs |
| Headless server | A box on the network | Local USB/WiFi | WS + WebCodecs | An office with 10 devices |
| Cloud split | Local node plus a cloud control plane | Local, tunnelled | **WebRTC** | A SaaS product |
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
| Transport | `adb-usb`, `adb-tcp` (wireless / redroid) | a device behind a node still connects locally via one of these two — the node's own outbound WS tunnel (§5.3) is not itself modelled as a `Transport` engine today; there is no `cloud-tunnel` id in the registry |
| Display | `scrcpy` (H.264, default), `screencap-loop` (MVP/fallback, ~3 fps) | scrcpy encodes on the phone, the host only relays; only H.264 is requested from the device today |
| Input | `scrcpy-uhid` (**the new default**, hardware-like), `scrcpy-sdk` (InputManager, broad compatibility), `scrcpy-aoa` (OTG, no adb), `adb-input` (crude fallback) | details in §9. `appium` is **not** a separate `InputSink` — it registers only as an `Inspection` engine below, which happens to also hold the `input-injection` lock (§9.5) |
| Inspection | `ui-server` (persistent on-device, default), `appium` (WebView/hybrid, opt-in) | replaces the naive `uiautomator dump`. `ocr-pixel` ("last resort") is planned, not yet implemented |
| Network | `none` (**the default**, never touches routing), `adb-proxy` (advisory — `settings put global http_proxy`), `adb-reverse-proxy` (advisory — `adb reverse` to a proxy on this machine), `vpn-helper` (an on-device helper app, §7.10) | details in §7.9; all hold the `network-route` lock so two of them can never be active at once. `adb-proxy` and `adb-reverse-proxy` were deferred by plan 44 §2 to Plan 33 §5.5 and were **shipped by plan 114** (v0.8). They are advisory: an app with its own networking can ignore them, and only `vpn-helper` is enforcing |

> *(Transport, Display, Input, Inspection, and Network rows corrected in reconciliation, 2026-08-09, DIV-063/DIV-067/DIV-066/DIV-065/DIV-064 — none of these were sent to the owner individually; §3's "remaining rows" direction applies. DIV-009's "node" terminology fix, which was sent to the owner as a manager decision, also touches the Transport row's old "agent's outbound WS" wording.)*

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

**Admission (v0.5, plan 56).** Resolving an identity does **not** make a phone a farm device. A `stableId` that has no `devices` row lands in a **Discovered** tray (the `discovered_devices` table) and waits for an operator to admit it by name.

The farm is therefore an allowlist, not a denylist. This matters because the adb server is usually shared — with Android Studio, with a developer's own phone, with whatever is plugged in to charge — and the previous behaviour made every one of those schedulable until somebody noticed. Blocking (§ plan 47) remains the outer layer and still wins over everything: a blocked `stableId` never reaches the tray. It is enforced by the `blocked_devices` table, keyed on `stableId` (not the adb serial or `devices.id`) so a block survives a port change or a forget/re-enroll cycle.

Three consequences worth stating:

- A discovered phone **is** probed — `getprop` for the model, the Android version, and the identity itself — because a tray listing bare serial numbers cannot be acted on. Nothing else runs against it: no scrcpy, no guest agent, no ui-server, no network route.
- Discovered devices live in their own table (`discovered_devices`) rather than as a sixth `DeviceStatus`, so the scheduler, lease manager, wall, clusters and topology need no filter of their own — they query `devices`, which only ever holds members.
- **Forget** now works on a connected device, returning it to the tray. It previously had to be refused, because the registry would have re-enrolled it immediately, which forced an operator who only wanted a device *out of the farm* to declare it permanently unwelcome instead. A forgotten device leaves a placeholder row in `deleted_devices` (old id, `stableId`, label), so anything that still points at it — a job, an artifact, a device-event, a batch, a schedule — can render "deleted device (\<stableId\>)" instead of crashing. `GET /api/devices/refs?ids=...` resolves a batch of such dangling references to a label in one call.

**Tags.** A device can also carry free-form tags (`device_tags`, many-to-many, no foreign key so a forgotten device's tags are cleanly orphaned) for pool selection — "smoke pool", "Android 15" — normalised to lowercase/trimmed/`[a-z0-9:._-]`. `GET /api/tags` lists every tag in use; `PUT /api/devices/:id/tags` sets a device's tags. Clusters (§12.3) can resolve their membership from a tag instead of an explicit device list.

**Discovery reconciliation (v0.6, plan 85).** `host:track-devices` speaks only on change, which is not enough by itself: a phone plugged in *before* the core starts, one stuck in adb's `offline`/`authorizing` transition, or an identity probe that failed outright can each miss their one event and stay invisible until a physical replug. A `DeviceReconciler` re-derives adb's own truth (`host:devices-l`) on a timer — `discovery.scanIntervalSec`, default 10s, `0` disables it — and reconciles it against the registry's live view: adopting a device adb has but the registry does not, dropping one that vanished, nudging a device stuck `offline` past `discovery.offlineGraceSec` (default 20s) toward one rate-limited `host:reconnect-offline` per `discovery.recoveryCooldownSec` (default 120s, never `kill-server`), and retrying a failed probe on backoff instead of giving up. `POST /api/devices/rescan` runs the same pass immediately, on demand; Studio surfaces it as a **Rescan** button beside the Discovered tray.

*(This subsection's table names and the `device_tags`/`GET /refs` mentions added in reconciliation, 2026-08-09 — DIV-001, DIV-002, DIV-003, DIV-004 accepted as uncontroversial by the audit itself; DIV-038's device-tags REST API follows the owner's general direction, not an individually ratified decision — see the register. The discovery-reconciliation paragraph above was added directly by plan 85 §85.9, 2026-08-09, describing new product surface in the same pass that shipped it — not a register entry.)*

**Connection as a fact, an address book, and a bounded sweep (v0.7, plan 88, added directly here, 2026-08-12 — not a register entry).** A device's connection is two separate facts, never one: `kind` (`usb` | `tcp`) is *observed* from adb's own serial shape and the `usb:`/`transport_id:` fields `host:devices-l` carries; `medium` (`wired` | `wireless` | `null`) is *declared* by an operator or *inferred* from a configured farm network (`discovery.networks[]`), and is never asserted as observed — adb cannot tell a switch port from a radio. One function, `connectionBadge()`, turns the pair into the four values every surface renders: **USB**, **OTG** (`tcp` + `wired`), **WI-FI** (`tcp` + `wireless`), and **TCP** (`tcp` + unknown medium) — the last one matters, because guessing WI-FI for every networked device was a real, shipped bug this replaced. **As of this revision, `medium` never actually reaches a device outside a test**: every production caller of `rowToDeviceInfo`/`listDevicesWithTags` (the main device list, a single device fetch, topology) passes no farm-network list, and the endpoint store's declared medium is not yet read back into it either — both sources are implemented, wired to nothing, and every network device therefore reads TCP in practice. This is a known, already-flagged gap (plan 88 §5 step 88.4's own write-up), not new information; closing it is unclaimed as of this revision.

adb itself forgets a TCP device's address the moment it disconnects, so `device_endpoints` (§12) is Enkaku's own memory of it — the *address book*. Whenever a device probes successfully over a `host:port` serial, its address is recorded for free, no extra adb work. `registry/reconnect.ts`'s **reconnect ladder** (`DeviceReconnector`) is what reads it back: already-connected is a zero-cost short circuit; failing that, every remembered address is tried cheapest-first (a ~300 ms TCP pre-probe before ever risking a full `host:connect`, which can block the whole adb server for a minute or more against a genuinely dead address); failing that, and only when explicitly permitted, a bounded subnet sweep (`registry/sweep.ts`) probes a configured farm network — singleton farm-wide, a hard address ceiling, bounded concurrency, and **on-demand only**: there is no automatic background scan, by the owner's explicit decision (§9 Q1 of the plan). A sweep can never enlarge the farm itself — an address that answers as an unrecognised `stableId` goes through the same Discovered-tray admission gate as any other new phone, never straight into `devices`.

An operator acts on one device at a time through `POST /api/devices/:id/connection/disconnect` and `/reconnect`, `PATCH /api/devices/:id/connection` (a declared medium), and farm-wide through `POST /api/devices/scan` — all `device.settings`. Closing a session no longer drops a wireless device's adb transport: a session's `disconnect` and the farm's `host:disconnect` used to be the same call, so ending a wall tile could silently take a phone off the network; they are now two different things; a transport is released only by an explicit operator Disconnect, the device vanishing from adb on its own, or an adb server restart (below).

The **USB → OTG cutover** — arm TCP mode, have the operator flip the chassis's physical USB/OTG switch (no software can press it), then watch the device come back on the network — is designed (plan 88 §3.4) as a guided, four-screen wizard, but has not shipped as of this revision; today, moving a device to the network still goes through the existing manual Wireless-debugging pairing flow (`docs/guide/enrollment.md`) or a hand-run `adb tcpip`/`adb connect`, after which the address book and the ladder above take over automatically.

**The device number (v0.8, plan 89 §3.1–§3.3, §4.2, §4.3, step 89.1/89.2, added directly here, 2026-08-14 — not a register entry).** Answering "which one is it on the rack" is a different question from admission's "does it belong here" and from `label`'s "what is it called" — a short, human-facing integer, assigned once, incrementing from 1, and **sticky**: it lives in `device_numbers` (§12.4), keyed on `stableId` (never a column on `devices`), so it survives Forget, Block, unblock, and re-admission exactly the way `blocked_devices`/`discovered_devices` already do, and is released only by an explicit operator action, never automatically. It is allocated inside `admitDevice()`'s own transaction — the one place a `devices` row is born — so a phone gets its number the instant it becomes a farm member, never at the literal first adb connection (a colleague's phone charging in the Discovered tray never burns one). It **composes with `label`, never merges into it**: `DeviceInfoSchema.number` is its own nullable field (null only for an explicitly released reservation), rendered beside the label everywhere, number first (`#7 Pixel 5`) — baking it into the free-text, user-editable label would desynchronise the moment anyone renamed or renumbered. `GET /api/devices` defaults to `?sort=number` (the rack's own order), with `?sort=label` still available for anything that depends on alphabetical order. A manual reassignment rides `PATCH /api/devices/:id` (`number?: number`), refused with `409 E_NUMBER_TAKEN` naming the current holder rather than resolved silently — the `device_numbers.number` UNIQUE index is the actual guarantee, not the allocator's arithmetic. `POST /api/devices/numbers/compact` renumbers the whole fleet `1..n` in existing-number order (never `label ASC` — a device's relative order is preserved, only gaps close; plan 96 §96.41 fixed an earlier version of this that sorted by label and scrambled the fleet) and **re-pushes the physical label of every device that moved, in the same request** (below), reporting `relabelled`/`failed` for real (no longer always `0`/`[]`). It also deletes, unconditionally, every `device_numbers` reservation orphaned by a forgotten device (no matching `devices` row) before computing the dense sequence — §3.2's sticky reservation survives Forget on its own, but only until the next explicit fleet compaction reclaims the slot — reporting each one in `released: { stableId, number }[]` so the loss of that guarantee is never silent (plan 96 §96.42; previously an orphaned reservation could collide with the dense sequence and crash the request with an uncaught `UNIQUE constraint failed`). `DELETE /api/devices/numbers/:stableId` is the explicit release, idempotent for a `stableId` with no reservation. Every place a device is named in text — the online/offline/forgotten/blocked log lines, the matching `device.online`/`device.offline`/`device.forgotten`/`device.blocked`/`device.label` event `meta.number`, `enkaku doctor`'s `devices` check, and the `job_running` refusal an operator sees on Disconnect/Cutover — composes `#N label` the same way (`formatDeviceLabel`, `registry/device-number.ts`), never a bare label or a raw serial (step 89.4). Studio (step 89.3, done 2026-08-14) reads and renders the field on every one of those surfaces: the Wall tile, the device card, the device page header, the device picker, the admit toast, a hand-authored Settings field with inline collision feedback and a Release-number action, and the devices page's Renumber-fleet overflow action.

**Physical labelling (v0.8, plan 89 §3.4–§3.8, §4.4–§4.7, steps 89.4/89.6/89.9, added directly here, 2026-08-14 — not a register entry).** A phone can carry its own identity on its own screen: `DeviceSettings.labelling.mode` is `off` (default) | `lock-screen` | `wallpaper`, inherited from `FarmSettings.defaults` at admission only (§3.8 — flipping the farm default never retroactively relabels an existing fleet). **Two tiers, never a silent fallback**: `wallpaper` needs the guest agent's `screen-label` capability (plan 90) and a black wallpaper carrying `#N` and, optionally, the name, on both the home and lock screens; `lock-screen` needs nothing installed — it writes one line of text into `settings secure lock_screen_owner_info`, verified by reading it straight back before it may ever be reported `applied`. A device that cannot do the requested mode reads `unavailable` with a reason; a device where only one wallpaper surface took reads `partial` naming which — never rounded up. `packages/core/src/device/labelling.ts`'s `LabellingService` (`reconcile`/`apply`/`clear`/`status`) is the one caller of both tiers, bounded by `FarmSettings.labelling.maxConcurrent` (default 2) and serialised per device. State lives on `devices.labelFingerprint`/`devices.labelState` (§12) — a cache of the device's own last-confirmed answer, never the source of truth. REST, all `device.settings` except the two fleet-wide actions (`device.admin` per the original design table does not exist in this codebase's ACL — gated on `device.settings`, the same substitution `/api/devices/rescan`/`numbers/compact` already made): `GET /api/devices/:id/label` (`device.view`) → the live status when online, the cached row when not, verbatim (`state` is never flattened — a `partial`/`unavailable` result is never reported as `applied`); `POST /api/devices/:id/label/apply` → an unconditional re-apply; `POST /api/devices/:id/label/clear` (`{ restoreOriginal? }`, default `false`) → idempotent, same writes on the tenth call as the first; `POST /api/devices/labels/apply` (`{ deviceIds: string[] }`) → a per-device report, the fleet-wide switch-on. **Reconciliation fires on exactly three events and never a fourth**: a device reconnecting (`onDeviceReady`, probe-first, alongside the existing network-route restore), a `PATCH /api/devices/:id` that actually changes `label` or `number` (debounced 2s so a person typing a name does not fire six renders — a change to any other setting schedules nothing, by design), and an explicit action (`apply`/`labels/apply`/the compaction re-push above). There is no poll loop and no timer sweep. Forget and Block clear a device's label before its row is deleted, best-effort — logged and recorded on failure, never blocking the removal, the identical discipline the network-route teardown beside it already has. **Studio's opt-in/preview/badge UI (step 89.8, added directly here, 2026-08-14 — not a register entry)**: the device Settings page's Physical labelling section, the device header's truthful state badge, the Discovered tray's admit-time opt-in checkbox, and the devices page's fleet-wide **Apply labels** action are described in §19's Dashboard and Device detail rows. The on-device renderer itself (plan 90) has shipped (§4.5's status note); this plan's own hardware pass (step 89.10, H1/H2/H4/H5) has not.

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
POST /api/tools/repair               → re-provision every required tool (the recovery path for the
                                       pinned ones, which /:id/install rejects)
```

Provisioning is only a boot gate for **adb**. A device-side tool (the inspector
APKs, scrcpy-server) that fails to install degrades its feature and is reported
on the Tools page; the farm keeps running and the operator retries with
`/api/tools/repair`.

Three diagnostic/operational endpoints sit beside these: `GET /api/health`, `GET /api/doctor`, and `GET /api/adb/stats` *(named in reconciliation, 2026-08-09, DIV-043 — accepted as uncontroversial by the audit)*. `GET /api/adb/stats` gained `transport` (WS connection count, buffered-bytes and control-reply latency percentiles, watchdog reconnect count) and `hostAdb` (running/max/installs/long-lived adb CLI processes) blocks — plan 85 §4.6, added directly here rather than through the register, since the endpoint itself was already named above and this is only its response shape growing.

**`POST /api/tools/adb/restart`** *(plan 88 §3.10, §4.8, added directly here, 2026-08-12 — not a register entry)* — `tool.manage` (admin-only), `{ force?: boolean }` in, an `AdbCycleReport` out. It runs the **one** implementation in the workspace that stops the shared adb server (§10.4): drain sessions and leases (and, only with `force`, running jobs — named individually, never silently) → stop the server → start it → reattach every remembered network address from the endpoint book (§7.5) → one reconcile pass. Refuses with `E_ADB_BUSY_FARM`, naming the running jobs and held leases, unless `force` is set; rate-limited to one call per `adbControl.restartCooldownSec` (default 60s). Progress broadcasts one `adb.server.phase` event per phase (§13) so twenty devices dropping at once reads as one banner, not twenty offline toasts. `GET /api/adb/stats` gained an `adbHealth` block alongside it — the rolling-window verdict ("is adb stuck, and does restarting actually help") that both `enkaku doctor` and the Tools page's restart button read, computed by `device/adb-health.ts` and never itself allowed to act.

### 7.8 Tool security rules

- **sha256** verification is mandatory before a tool is used (checksums from the official release).
- Refuse to delete a version that is active or in use by a live session.
- Health check before setting a version active.
- Binary paths are resolved through the Toolchain Manager; drivers must never call the system PATH.
- **Licensing:** audit before selling — adb (platform-tools, Google's ToS on redistribution), scrcpy (Apache-2.0, fine), redroid, and so on. See §18.

### 7.9 Network layer: routing a device's traffic (NEW in v0.4)

The QA requirement is ordinary: point a device at a capture proxy to inspect **your own** app's traffic, test against a mocked backend, or check a regional catalogue. The layer exists so that requirement is met **without** a script gaining a raw shell.

The design is a three-rung capability ladder, each rung buying something the one below it cannot do, and **all three rungs are now built** (`docs/plans/114-m79-device-proxy.md`, v0.8). `adb-proxy` and `adb-reverse-proxy` were deferred by plan 44 §2 to Plan 33 §5.5 and stayed deferred until plan 114 built them; `none`, `adb-proxy`, `adb-reverse-proxy` and `vpn-helper` are all registered engines today *(the "only the first and last rungs are built" wording was corrected in reconciliation, 2026-08-09, DIV-064, and superseded by plan 114 on 2026-08-18)*. Two limits ride with the two new rungs and are stated here rather than in a plan nobody reads: the reverse rung has only ever been exercised over **USB** — `adb reverse` over wireless adb is **unrun**, so nothing here claims it works — and both new rungs are advisory, which is the property the table's Enforcing column has always carried and which no amount of shipping changes:

| Engine | Auth | Enforcing | Needs an APK | Notes |
|---|---|---|---|---|
| `adb-proxy` | ✗ | ✗ (advisory) | ✗ | `settings put global http_proxy host:port`. `global` is Android's settings namespace — device-wide, **not** farm-wide. The value is world-readable by every app on the device, so credentials must never be placed in it. Shipped by plan 114; a request carrying a username or a password, or a pasted URL with a userinfo component, is refused with `E_HTTP_PROXY_NO_AUTH`. Its `egress` check is permanently `skip`, so `health` is structurally `unverified` and must never be worded as success. |
| `adb-reverse-proxy` | ✓ | ✗ (advisory) | ✗ | `adb reverse` to a proxy on the host/node, which holds the upstream credentials. Works over USB and needs no shared LAN; **the credentials never touch the device**. This is the default recommendation of the two advisory rungs. Shipped by plan 114. The reverse is re-established on every device-online transition; between the phone returning and the tunnel being rebuilt, apps using the proxy fail to connect, and the `reverse` check reports that window as `fail` rather than hiding it. Exercised over USB only — wireless `adb reverse` is untested. |
| `vpn-helper` | ✓ | ✓ | ✓ | An on-device helper app using `VpnService`. The only rung an app cannot ignore. The intent contract is **app-specific** — it is a per-app profile (§7.10), not an Android standard. |

Rules that hold for every engine on this layer:

1. **Configuration is bound to the device, never to the lease** (revised in v0.6 by `docs/plans/52-m24c-device-scoped-routes-and-stable-identity.md`, superseding this rule's original lease-scoped form). A route survives lease release, expiry via the reaper, client disconnect, a device reboot, and a core restart; only an explicit act — switching it off, removing it, or uninstalling the agent — tears it down. The original rule bound configuration to the lease specifically to stop one tenant's routing from silently leaking into the next tenant's session, and that concern was real — but tying a network identity to *whoever happens to be holding control* turned out to be the wrong model for a farm where a device is expected to present a consistent regional identity across sessions: an operator set a proxy, checked the device's geo IP, and got their own real address because the lease had idle-timed-out ninety seconds earlier and torn the route down with it. The isolation the old rule provided is kept, just moved: a device's route, its upstream, and who set it are shown wherever the device is shown, and every change is recorded to the device event log (rule 5) with an actor — so a tenant who acquires an already-routed device sees that immediately, rather than being silently protected by a teardown they never asked for. On a device coming back online, or on core start, the route is *restored*, never blindly re-applied: it is probed first, and only brought up when the device reports no route already running — a stored route may point at an upstream that has since expired, and reapplying blind would produce a device that looks routed and carries nothing.

   **Recovery has a bound, and reconnecting gives it a fresh chance** (v0.7, `docs/plans/90-m55-unified-guest-agent.md` §3.7, answering `docs/plans/54-m24d-fail-closed-and-route-recovery.md` §9 Q2). Automatic recovery from a held-closed route is bounded — three attempts on a short backoff, then it stops and waits out a re-arm interval (farm setting `guestAgent.recoveryRearmSec`, default 120s) — so it never hammers a permanently dead upstream. That bound resets when the device is observed to have genuinely gone offline and come back (not merely on every heartbeat, which is what silently held routes dark for minutes after a USB blip before this revision), and a second, coarser breaker (`guestAgent.maxRecoveryCyclesPerHour`, default 4) catches a device that flaps so often the per-reconnect reset itself would otherwise mask a truly dead upstream behind an infinite retry loop. `GET /api/devices/:id/network` reports the live state as a `recovery` block (`attempts`, `maxAttempts`, `nextAttemptAt`, `exhausted`, `reconnectCycles`), and `POST /api/devices/:id/network/retry` (lease-gated, like every other network write) is the honest version of the operator's own workaround: it clears the bound and applies once, immediately, without the misleading "route is off" state a disable-then-enable toggle passes through on its way. `network.recovery.exhausted`/`network.recovery.recovered` join rule 5's device-event kinds.
2. **Declared intent and observed state are separate reads.** `getConfig()` returns what was requested; `observe()` returns what the device reports. They diverge (a VPN drops, a reboot clears the setting), and the drift must be visible rather than assumed away.
3. **`apply()` is not a success signal.** An engine that can verify egress must offer `probe()`; without a probe, the status is reported as `unverified`, never as `ok`.
4. **Credentials are referenced, never inlined.** Scripts and run configs name a stored credential (the `network_credentials` table — AES-256-GCM at rest, plan 52 §4.2); raw secrets never enter script params, the `jobs` table, artifacts, or the device event log.
5. **Every change is recorded** to the device event log (the `device_events` table, `network.*` kinds) with the secret redacted. `device_events` carries two streams sharing one shape but different retention budgets: `main` (lifecycle) and `input` (every injected tap/swipe/key — a full audit trail, plan 18) *(table names added in reconciliation, 2026-08-09, DIV-005/DIV-008 — accepted as uncontroversial by the audit)*.
6. **HTTPS interception is out of scope and cannot be solved here.** Reading TLS payloads needs a trusted CA, which since Android 7 means a debug build of your own app with a matching network security config. The layer routes traffic; it does not decrypt it.

### 7.10 The `vpn-helper` engine is served by a first-party agent

> **v0.5 revision.** This section originally described driving a *third-party* VPN app through a declarative intent profile. Research has ruled that approach out; see `docs/research/android-guest-agent.md` for the verified findings and their sources.

Two results kill the third-party-profile idea outright. First, **`adb shell am` cannot reach components declared `exported="false"`** — only root and system bypass the export check, and shell is neither; worse, `am broadcast` fails *silently* with exit code 0. Second, real candidate apps export nothing usable: SocksDroid's manifest exports only its launcher activity, with its VPN service and boot receiver both unexported. There is therefore no intent contract to declare, for that app or most others.

So `vpn-helper` is served by **`enkaku-guest-agent`**, a first-party APK, provisioned through the Toolchain Manager (§7.2) with a pinned sha256 and installed with `adb install -r -g`, reusing the `ui-server` path (§7.4). It is controlled over a `localabstract` socket reached with `adb forward` — typed request/response, so the engine can *read* state rather than fire intents blindly, which is what makes `observe()` and `probe()` (§7.9) truthful rather than assumed.

Three platform facts constrain it and must not be rediscovered the hard way: the agent's entry components have to be `exported="true"` and guarded by a token in the payload rather than a signature permission; a freshly installed app sits in the stopped state and receives **no** broadcasts — including `BOOT_COMPLETED` — until the host explicitly launches it once; and the `VpnService` consent dialog is pre-granted non-interactively with `appops set <pkg> ACTIVATE_VPN allow`, which writes exactly the state the dialog writes. That last one is `@hide` and undocumented, so it is pinned by a per-release smoke test, never assumed.

The agent is scoped as a general on-device helper with negotiated capabilities, not a proxy shim: provisioning cost is per-app rather than per-feature, and SOCKS routing is simply its first capability.

**v0.8 revision** (`docs/plans/90-m55-unified-guest-agent.md`) cashes that last sentence: the agent is installed on **every admitted device as a matter of course** — at admission, re-verified on every reconnect, repaired on drift, and swept at core boot — not only as a side effect of enabling a route. A phone with no agent (install refused, or not yet provisioned) still streams video, takes input, runs jobs, and answers a shell; only the facets below say they need the agent, and they say it as a named precondition with a fix, never as a device fault. Failure to install never quarantines a device, blocks it, or changes scheduling.

**The membership rule.** A capability belongs in the guest agent only if it needs to run as an ordinary Android app — a system API with no shell equivalent, or state that must survive the host disappearing. The agent's only channel to the host is `adb forward` over the same transport the shell already uses, so it can never reach *further* than the shell, only *differently*; anything the shell can already do belongs on the host side, never in the APK. Applying that rule yields four facets, one package, one provisioning story:

| Facet | Capability string | Why it needs the agent, not the shell |
|---|---|---|
| **Network route** | `socks5-route`, `vpn-status`, `egress-probe`, `route-hold` | `VpnService` is the only enforcing rung — see above |
| **Screen label** | `screen-label` | `WallpaperManager` has no shell equivalent; physically distinguishing many identical phones needs something drawn on-device |
| **Text input** | `text-input` | Only an `InputMethodService` commits arbitrary Unicode into whatever field has focus, on any input engine, without touching the device clipboard |
| **Mock location** | `mock-location` | The test-provider API needs an app registered as the device's mock-location provider (§28) |

Two capabilities the same rule explicitly **rejects** from the agent, built host-side instead because the shell can already do everything they need: a gallery/media facet (bytes already reach the device over the existing transfer path; the one missing step — telling `MediaStore` about a file under a known media root — is one shell `content call`, §11.3) and an on-device monitoring facet (everything it could report while adb is up is already streamed by the host, and when adb is down the agent is unreachable by the same transport constraint that bounds every facet here).

Provisioning is farm-wide, not only per-device: `POST /api/guest-agent/provision` runs the same verify-install-repair pass across every admitted device at once (bounded by the same install lane §10.4's semaphore already governs), and `GET /api/guest-agent/summary` answers "how many of my phones are on the current agent" in one call, so an operator does not have to probe each device individually.

### 7.11 Device preparation: a per-component provisioning registry (NEW, `docs/plans/106-m71-device-preparation.md`)

The guest agent's own `absent | provisioning | ready | outdated | failed | unsupported` state (§7.10) generalises to **every** on-device component worth tracking, keyed by a component id: `devices.preparation: { [componentId]: { state, version, reason, attempts, nextAttemptAt, checkedAt } }`. A component registers itself — how to detect it, how to install/repair it, whether a device is even eligible for it at all — instead of a new subsystem growing beside the guest agent's for each new artifact. `ui-server` (the openatx inspector APK pair, §7.4) was the first entry with real per-device state of its own; the guest agent (§7.10) migrated onto `devices.preparation['guest-agent']` as its own first entry (plan 106 §5 step 106.5) — that key is now the authoritative record for its `state`/`reason`/`attempts`/`nextAttemptAt`/`checkedAt`, and the legacy `devices.agent` column is narrowed to a compat/identity cache (`appVersion`/`versionCode`/`androidSdkInt`/`capabilities` — the facts a live `hello()` handshake learns, with no equivalent field in the generic per-component shape) rather than a second store of the same fact. The guest agent's own execution engine (verify → install → repair-once → `hello()`, plan 90 §3.8/§3.9) stays specialised — it is not registered in the generic per-component runner, since a protocol handshake has no equivalent in the plain install/verify contract every other component uses — but its retry/`Retry` bridges into the same `GET`/`POST /api/devices/:id/preparation[/:componentId/retry]` surface every other component uses, so an operator never has to know that guest agent's pass runs through a different engine underneath.

`scrcpy-server` (§7.6) is deliberately **not** a registry entry: it is pushed fresh every session and deletes itself, so an "installed" state for it would be a lie that looks tidy — it stays verified at use, by the session that pushes it.

`unsupported` (an SDK floor a component declares, checked before any retry) stays distinct from `failed` (a pass that could not install or verify): an old device is not a broken one, and conflating the two is how a phone ends up permanently reporting an error nobody can clear. A component's bounded automatic retry (mirroring §7.10's own three-attempt backoff) is clearable per component through `POST /api/devices/:id/preparation/:componentId/retry`, which forces a fresh pass regardless of the standing bound. `GET /api/devices/:id/preparation` reads the persisted record; `POST /api/devices/:id/preparation` runs every registered component for that device on demand. A core-side failure (adb not yet ready) never spends a component's retry budget — only a genuine device-side failure does. Preparation is a readiness signal, never a gate: a device with a failed component still streams, takes input, and runs work that does not need it.

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
    networks:    [{ id, displayName, capabilities, configSchema, locks }],  // the fifth layer, §7.9
    tools:       [{ id, displayName, swappable }],
  }
```

*(`networks` added to the example in reconciliation, 2026-08-09, DIV-041 — accepted as uncontroversial by the audit; purely additive, since §7.9's network layer postdates this example.)*

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

> **Mechanism note** *(implemented in reconciliation, 2026-08-11, plan 87 — replaces "an internal header or marker" below, which described network-level tagging the architecture cannot honestly provide without a MITM proxy this project deliberately does not build).* Bullet 1 below describes the actual, shipped mechanism: a device-scoped system property, not a tag on individual requests. See `packages/session/src/farm-tag.ts` for the exact boundary of what it does and does not cover.
>
> **Withdrawal note** *(2026-08-12, owner direction).* This section, and §17 below, previously also pointed to `docs/acceptable-use.md` for the boundary of this mechanism and for a stated product position on acceptable use more broadly. That document (added `ecdc24a`) was deliberately deleted (`d184063`) before this spec was last touched; an MVP-readiness audit misread the absence as a gap and had it recreated as a 246-line draft, complete with a Studio link and its own drift test. The owner has confirmed the original deletion was correct, not an oversight, and ordered the document — and every reference to it — removed again. Enkaku ships the device marker described in bullet 1 below, on by default; it states no acceptable-use position, and this document no longer claims one.

Because you hold **both sides** (the detector and the farm), the correct and far more precise approach is:
1. **Mark the device as farm-instrumented** — a device-scoped system property (`debug.enkaku.instrumented`), set via `adb shell setprop` when a session opens and cleared when it closes (`DeviceSettings.instrumentation.tagTraffic`, **on by default**). It tags the *device*, not the network path or any individual request — an app under test reads the property itself if it wants to recognize farm traffic. There is no per-packet or per-request header; §7.9's network layer carries no such marker.
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

> **Naming note** *(added in reconciliation, 2026-08-09, DIV-012/DIV-035/DIV-047 — Cluster B, owner decision).* This section's title predates a later addition, and "scheduler" here means only the per-device job-queue picker in §10.3 — the SQL query below that claims the next queued job for an idle device. It is **not** the cron-style, time-triggered dispatcher (recurring runs of a batch or an AI-agent thread) described in §12.3. That subsystem is unrelated code with its own tables (`schedules`, `schedule_runs`, `schedule_agent_targets`) and its own REST API and WS push (`schedule.fired`); a reader should not assume this section already covers it.

### 10.1 Device state machine (amended by plan 91 §3.4 — a co-control grant is a narrow exception to the busy rejection)

```
offline → idle → { manual | busy }
```

`manual` (remote touch active) and `busy` (automation running) are **mutually exclusive**. While `busy`, control messages from a client are **rejected by the core** (not merely disabled in the UI) — **unless that client holds a co-control grant on the device (§10.5), which authorises the five manual input verbs and nothing else.** The video stream keeps running, so a client can still watch the automation.

**`POST /api/video/reprofile`** *(plan 92 §3.8, §4.5, §5 step 92.2, added directly here, 2026-08-13 — not a register entry)* — `settings.manage`, no body, returns `{ restarted, skippedBusy, unchanged }` (device ids, device ids, a count). Restarts every open session whose resolved video profile (`FarmSettings.video` plus any per-device `DeviceSettings.video` override, §12) no longer matches the numbers it was actually built with, carrying each session's subscribers and refcount across the restart so a watching client is never dropped and never has to re-subscribe. A device currently `busy` is skipped and keeps its picture — the exact guarantee this section already states — and named in `skippedBusy` rather than silently ignored. The manual call above and an automatic path both run the identical `SessionManager.reprofile()`: `daemon.ts`'s `settingsStore.onChange` schedules one debounced (500ms) pass whenever farm video settings change, and `PATCH /api/devices/:id` restarts the one device it just patched when `changedKeys` includes `video`. Every restart re-announces the plan-17 startup phases (§13's `session.progress`) with `detail: 'applying new video settings'`, so an operator watching the tile sees why, not merely that.

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
- A **global semaphore that scales with fleet size** (plan 23 §3.2), not a fixed constant: `auto = min(24, max(6, ceil(nonOfflineDeviceCount * 0.75)))`. The floor of 6 keeps a small setup (≤4 devices) at the same concurrency as before this revision; the ceiling of 24 is deliberate — the adb server itself becomes the bottleneck above it on a typical host, and a farm that needs more should run a second core (the cloud agent model already provides this). `nonOfflineDeviceCount` excludes offline devices, so an unplugged phone does not reserve capacity. The farm setting `adb.maxConcurrent` (default `0` = auto) lets an operator pin a lower or higher value (up to the ceiling) instead of the formula, and it takes effect immediately, with no restart. This and every other farm-wide setting (including the AI agent defaults, §12.1) live as JSON in a single always-exactly-one-row table, `farm_settings` (`id = 1`) *(table name added in reconciliation, 2026-08-09, DIV-028 — accepted as uncontroversial by the audit)*.
- A **separate streaming lane** (plan 24, rescaled by plan 85 §3.1) for long-lived commands — `logcat`, `top`, the always-on crash watch, the ui-server instrumentation — that never touches the per-device queue above, so a stuck stream cannot park an exec slot. Its own farm-wide budget, `adb.maxStreams`, is `0 = auto` the same way: `auto = min(64, max(8, ceil(nonOfflineDeviceCount * 2.5)))`, derived from what a device holds at steady state (the ui-server instrumentation and the crash watch each hold one slot for a session's whole life) plus headroom for a Monitor tab or a file transfer — never a slice of the exec semaphore above. A pinned, over-the-lane request is refused immediately (`E_ADB_STREAM_LIMIT`), never queued.
- **`adb kill-server` is FORBIDDEN** anywhere except `packages/core/src/tools/adb-server-control.ts`'s `cycle()` — the one function in the workspace that runs it, shared by exactly two audited entry points: the Toolchain Manager during an adb version swap, and an operator's **Restart adb server** action on the Tools page (§7.7). Both drain every session, lease, and (only if the operator overrides with `force`) running job before the server stops, and reattach every remembered network address (§7.5) once it is back. The Tools page states the cost before the click: every device disconnects and reconnects (network devices dial back automatically, USB ones re-announce by hotplug), any other program sharing this machine's adb server loses its connection too (Android Studio, a running `adb logcat`, and the like), and it usually takes 5–15 seconds. A workspace-wide test asserts the literal command appears in exactly this one non-test file. *(Strengthened directly by plan 88 §3.10/§4.8/§88.9, 2026-08-12 — narrowed from "the Toolchain Manager" to one named function with two audited entry points, and given a workspace-wide guard where previously only the doctor package was checked; not a register entry.)*
- Heavy operations (install, uninstall, large pushes) run without blocking heartbeats or control of other devices. The adb **CLI** processes behind them (`install`/`push`/`forward`, and the long-lived `adb shell` running the scrcpy server) go through one bounded helper (`adb.maxHostConcurrent`, default 4, farm-wide) with a stricter, per-device-serialised sub-limit for installs and pushes specifically (`adb.maxInstallConcurrent`, default 2, farm-wide) — plan 85 §3.4, since a fleet attaching inspectors to many devices at once would otherwise fire dozens of concurrent `pm install` sessions over one shared USB controller.
- **Device discovery is reconciled, not only event-driven** (plan 85 §3.3, detailed in §7.5): `discovery.scanIntervalSec` (default 10s), `discovery.offlineGraceSec` (default 20s), and `discovery.recoveryCooldownSec` (default 120s) govern the periodic pass that recovers a device the live event stream missed.

### 10.5 The co-control grant (Assist) — a second, narrower authorisation beside the lease (NEW, plan 91)

A **co-control grant** is a third authorisation object, keyed `(deviceId, clientId)` — not a lease variant, and not a `DeviceStatus` value. It lets a second client reach into a device someone (or something) else already holds — a job mid-script, or another operator's manual lease — without ever taking that hold away. The user-facing name is **Assist**; §10.1's amendment names it as the one exception to the busy rejection.

**What it grants.** Exactly five input verbs and nothing else: `input.tap`, `input.swipe`, `input.gesture`, `input.key`, `input.text`. The gate that authorises them (`checkAssistAllowed`) is a function separate from the lease's own gate (`checkInputAllowed`), consulted only as a fallback by the input-message handler, and only after the lease check has already refused — every other input-adjacent surface (`shell.exec`, `inspect.*`, `clipboard.set`, install/push/pull, the adb endpoint) still calls only the lease gate and was never given this fallback, so none of them widens. This is proven structurally, not merely asserted: a client holding only a grant is refused `shell.exec`, `inspect.attach`, `clipboard.set`, `POST /:id/push`, and `POST /:id/adb-endpoint` — all five, on the same device, in one test — while its `input.tap` succeeds.

**What it explicitly does not do.**
- It never changes `DeviceStatus`. The device really is `busy` (or `manual`) throughout; a grant authorises one more input source against that same state, it does not change what the state means.
- It never calls the lease acquisition path and never touches the primary holder's lease row — the holder, and its `expiresAt`, are exactly what they were before and after a grant exists.
- It is never a takeover: the primary holder reported through this path always carries `takeable: false`, and neither `assist.start` nor `mirror.start` ever passes a takeover argument.
- It is not the reach of a shell (§11.3) — five narrow input verbs, no filesystem, no arbitrary command, no read of anything beyond what those five verbs already imply.
- By default only one client may hold a grant on a device at a time (`coControl.maxConcurrentPerDevice`, default 1, max 4) — a second concurrent request is refused `assist_taken`, naming who already holds it, because two people on one shared pointer is safe (the input arbiter serialises every action into one of three lanes — pointer, keys, text — so two sources can never interleave one gesture) but is not attributable to either of them.

**Gating.** A farm-wide switch, `coControl.mode` (`off | admin | operator`, default `operator`), plus the `device.assist` permission, checked together — the same shape §11.3's `shell.mode`/`canUseShell` already establishes. A script may additionally declare `assist: 'deny'` to refuse help for its own run; the default is `'allow'`.

**Lifetime.** A grant lasts `coControl.grantTtlSec` (default 300s), refreshed on every accepted action — the same freshening a manual lease's own heartbeat gets. It ends through five independent paths, and losing any one of them would let a second input source keep writing to a device nobody remembers granting it on:

1. the grant's own TTL expiring with no activity;
2. the assisting client's WebSocket connection closing;
3. the assisting operator releasing it voluntarily;
4. the primary hold ending the ordinary way — the job's lease clearing at settle, or the manual holder releasing, whether by their own action or the reaper's automatic idle release;
5. the primary hold being **taken over** by a third party — kept distinct from (4) because a takeover's compare-and-swap acquisition never calls the ordinary release path, so ending a subordinate grant on a takeover is wired independently.

**Attribution.** While the primary hold is a job, every accepted assist action increments that job's `jobs.assistCount` (§12.4) and is written to the device's own `input`-stream `device_events`, readable back as `GET /api/jobs/:id/assists`; the grant's start and end are also recorded as a `device.assist` audit row naming the job. A script may register a callback to react to being assisted; a script that does not is unaffected in every way — an assist never aborts a job and never invokes `finish()` outside its normal lifecycle.

**Controlling many devices at once (Mirror)** rides on exactly this mechanism rather than inventing a second one: one operator selects many devices and drives them from a single focused view, and each selected device is resolved independently — an idle device becomes an ordinary manual lease, a device someone or something else already holds becomes an ordinary co-control grant, subject to every rule above — with one outcome reported per device, never a silent drop. No multi-device lock exists anywhere; every mirrored member still has exactly one lease with exactly one holder, reached through the exact same doors a single-device operator would use. A device whose screen orientation disagrees with the one the operator is looking at is withheld for tap/swipe/gesture actions only (named, on its own tile) and still receives key presses and typed text, since a keycode has no geometry to disagree about.

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

  // OPTIONAL (plan 97, M62, §11.9) — declares the shape of what `run` returns.
  // Omit it and everything works exactly as before; declare it and `tsc`
  // checks your own `return` against it, before you ever publish.
  result: z.object({ ok: z.boolean() }),

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

**`runtime` — a script's own execution envelope (plan 98, M63) *(added directly, 2026-08-13, in the same pass that shipped its persistence; completed 2026-08-13 by step 98.9, documentation — not a register entry)*.** Alongside `timeout`/`retries` above (kept forever, now deprecated in favour of the shape below — both are folded together by `defineScript`/`definePlugin`, which throw at import time if they disagree), a script may declare `runtime: { sdk?, timeoutMs?, retries?, maxRssBytes?, maxConcurrent? }`.

**Every field is a restriction the script places on itself — never a permission it requests, and that is load-bearing.** Declaring `maxRssBytes: 4_000_000_000` does not grant a script four gigabytes: the farm's own ceiling still wins over anything a script or an operator asks for, and a per-job override that exceeds that ceiling is refused outright (`E_RUNTIME_OVER_CEILING`, naming the ceiling) rather than silently clamped down to it — a human typing a number is right there to be told no, so telling them is the honest failure. A script's own declaration over the ceiling, by contrast, is clamped and logged (naming the script and both numbers) rather than refused, because the artefact may have been published somewhere else, possibly long ago, and killing its job outright over a setting it never saw would be worse than running it shorter and saying so. Reading the envelope as an allowance rather than a ceiling is the one mistake this design cannot recover from silently — see the SDK README's own restatement of this same rule for the reader writing the script.

`enkaku publish` sends `runtime` verbatim; the farm re-validates it independently, never trusting the SDK's own checks alone (`E_RUNTIME_ENVELOPE_INVALID`, 400, on a shape violation; an unknown field is dropped with one warning naming it, never refused — the envelope is append-only and forward-compatible by design, §3.3 S3 of plan 98). `GET /api/scripts/:id` returns it as `runtime` (`null` for a script published before this field existed, or that declared nothing). It is persisted on the `scripts` row at publish time, not resolved — the same row a job pins at enqueue (§11.2, §11.6), so the declaration a job runs under is exactly the one that was reviewed, never a later republish.

**A running bundle still reports its own copy of this envelope at startup** (over the same `ready` channel `timeout`/`retries` always used) — but that report is a reconciliation check, never the source of truth. **When a script's `ready` envelope differs from the `scripts.runtime` row it was published as, the row governs, in both directions**: a bundle cannot raise its own ceiling by claiming a looser one at startup, and it cannot lower it either, by claiming a tighter one — the operator's published row is the agreed contract, not whatever the process on disk currently says about itself. A mismatch is logged exactly once, naming both full envelopes, never silently picked one way or the other. (The one legitimate case where they differ is a plugin dev slot, which has no `scripts` row at all and lives only in memory.)

A fourth, human-typed layer sits above the script's own declaration: a per-job `runtimeOverride`, checked against the identical farm ceiling **before the job row is even written** — over the ceiling is refused (`E_RUNTIME_OVER_CEILING`), never narrowed for the operator. `resolveRuntime` (`@enkaku/protocol`) is the one pure function that resolves `override ?? script ?? farm default`, then clamps to the farm ceiling, for every job on every attempt — nothing anywhere writes a *resolved* envelope back into a row (`jobs.max_concurrent` is the sole, deliberate exception, forced by `maxConcurrent`'s own SQL-transaction enforcement — see §11.2), so a farm setting changed today reaches an already-published script and an already-queued job with no republish and no re-enqueue.

`timeout`/`retries` fold into `runtime` at `defineScript`/`definePlugin` time: declaring both `timeout: 30_000` and `runtime: { timeoutMs: 60_000 }` with disagreeing values throws at import time, naming both numbers — a silent pick would be unverifiable by the author reading their own script back. See §11.2 for what each field enforces and how hard.

### 11.2 Rules that make it solid

- **`finish` always runs** → the device comes back clean → the queue can safely continue.
- **Every job is a child process** (`Bun.spawn`). A timeout means a forced kill. Crashes are isolated. Logs and artifacts are per job.
- **`params` is a Zod schema** → Studio auto-generates the input form.
- **`waitFor` polls the inspector** (`ui-server`, fast), it is not a sleep.
- **Selectors are layered** (stable → fragile): `{ id }` → `{ desc }` → `{ text }` → `{ point }`.
- **`find` answers `null` when it cannot answer** (plan 60 §3.1). A selector that only resolves to a viewport-sized container is not a match: `tap` aims at a node's centre, so acting on one presses the middle of the page. The grammar stays at four shapes — `ctx.device.dump()` returns the whole tree (334–584 ms) for everything a selector cannot reach.
- **Artifacts per job**: screenshots, logs, results, stored against the job id → auditable.
- **A declared `result` is checked, never coerced, and never fails the job** (plan 97, M62, §11.9 — output validation is an assertion, not a gate; input validation, at enqueue, is the gate). A script that declares no `result` is unaffected, forever.
- **Every `runtime` field is enforced, and the schema says exactly how hard** *(plan 98, M63, step 98.9)*. An `enforcement` hint (`hard | sampled | advisory`) travels with each field in the schema itself, so a declared limit is never a guess about what it actually promises. **The hint is descriptive, not a control** — it tells an operator how a limit is applied; there is nothing to flip, and Studio renders it as a read-only badge next to the field, never a setting. This plan ships zero `advisory` fields.

  | Field | Enforcement | What it actually promises |
  |---|---|---|
  | `sdk` | hard | An SDK major outside the core's supported range is refused **at enqueue**, before any device is claimed (`E_RUNTIME_UNSUPPORTED`) — an exact gate, never a soft warning. |
  | `timeoutMs` | hard | The existing abort path (30 s grace for `finish()` → SIGTERM → SIGKILL) fires at exactly the resolved number. A script's own request over the farm ceiling is clamped and logged, never silently honoured past it. |
  | `retries` | hard | The script's own retry budget on a **script**-classified failure — separate from the infra retry budget (plan 36 §3). An exact count; nothing about it is sampled. |
  | `maxRssBytes` | **sampled** | Enforced by periodic self-reported `process.memoryUsage.rss()` polling (2 s by default), never an OS-level cap. A breach is caught within one sample interval, not prevented — a single allocation large enough to exhaust the host between two samples is not caught, and that gap is disclosed by the badge rather than a doc comment nobody reads. **On a breach the kill is an immediate SIGKILL with no grace period at all** — deliberately harsher than the timeout path, because a process already over its own declared ceiling cannot be trusted to unwind politely. This is not a contradiction of `finish` "always runs" above: the killed attempt's `finish()` still runs afterward, in a genuinely fresh OS process with `ctx.error` populated — proven end to end by two differing `process.pid` values recorded on disk by `run()` and by the finish-only re-run, read back from outside both processes. The grace period is what is skipped; the cleanup contract is not. |
  | `maxConcurrent` | hard | Enforced **inside the claim's own SQL transaction** (`BEGIN IMMEDIATE`), as an exact correlated count — proven against 8 real, separately-spawned OS processes racing the identical claim with no coordination between them. It blocks only *that script's* additional jobs; every other script, on every other device, stays claimable in the same instant — a blocked job is skipped in the queue, never left stalled in front of it. |

  **No farm-wide memory default is shipped.** `job.memory.defaultMaxRssBytes` and `job.memory.maxRssBytes` both default to `null` — no limit anywhere, for a farm that sets neither and runs scripts that declare nothing. The 256 MB figure that appears in this plan's own test fixtures is a fixture, not a shipped default or a recommendation: a real number is deliberately left for a later step to choose, from the peak-RSS distribution this plan now records unconditionally on every job (`jobs.peak_rss_bytes`), rather than invented ahead of that data.

### 11.3 Trust model and isolation (HONEST CORRECTION in v0.2; extended in reconciliation, 2026-08-09, DIV-048/DIV-040 — owner decision)

**v0.1 said "sandbox: limits child process fs/network access". That was an overclaim.** Bun does **not** have a permission model like Deno's; a `Bun.spawn` child process has full fs and network access as its OS user.

What is actually true for **the first actor, a script**:
- **The isolation that EXISTS is crash containment**, not a security boundary: a child process plus a hard-timeout kill means a user's script cannot crash the core or hang it. That is the entire promise in local/single-tenant mode.
- **The local/self-host trust model is "the script author is a trusted operator."** Do not write "secure sandbox" in marketing.
- **If a real security boundary is needed** (mandatory for multi-tenant cloud later): that requires **a container, gVisor, or a microVM per job**, or at minimum a separate OS user. This is an architectural change (part of §18/M8), not a flag.
- Only the `device`, `artifact`, and `log` APIs are exposed to a script as a *convenience*, not as a security guarantee.

**There is a second actor this section did not previously name: an authenticated operator working through the browser**, not through a script at all. This is deliberate, shipped scope — this is documenting something real, not papering over a hole. Enkaku hands that operator, once authenticated and holding a lease on the device:

- **An interactive shell** (`shell.exec`, with `shell.echo`/`shell.result` streaming the output back) — a live root-equivalent-as-the-adb-user command line on the device, no different in reach from running `adb shell` at a terminal.
- **`monitor.*` live streams** (`monitor.start`/`monitor.stop`/`monitor.oneshot` from the client; `monitor.started`/`monitor.data`/`monitor.ended`/`monitor.result`/`monitor.subscribers` from the server) — live logcat and perf data piped straight from the device to the browser. **These are the one item here that is NOT lease-gated**: they are treated as read-only observation and are deliberately allowed while the device is `busy`, on the same reasoning as watching the video stream (`packages/core/src/server/ws-handlers.ts:904-907`, plan 24 §4.4 — it explicitly does not call `leases.checkInputAllowed`). Any authenticated session may therefore read any device's logcat. That is a real widening of who can see device output, and it is stated here rather than left to be discovered.
- **Lease-scoped raw adb access at the REST level**: `POST/DELETE/GET /api/devices/:id/adb-endpoint` (exposes an adb endpoint directly), plus `POST /:id/install`, `POST /:id/push`, `POST /:id/pull` for arbitrary file transfer and APK install. `POST /:id/push` accepts an optional `mediaScan` (`'auto' | 'always' | 'never'`, default `'auto'`, `docs/plans/90-m55-unified-guest-agent.md` §3.4/§4.6): when the resolved remote path falls under a known media root (`DCIM`/`Pictures`/`Movies`/`Music`/`Download`), the core tells `MediaStore` about the new file with one `content call` (`scan_file`, falling back to `scan_volume`) so it appears in the device's own photo/file picker with no reboot — no on-device gallery app is needed for this, since the shell can already write anywhere under those roots and issue that one call itself. A failed scan never fails the push (the bytes already landed); the result names which method answered, or that neither did.

**What authentication and leasing do guarantee:** all of these require a logged-in session (§14); an anonymous caller is rejected by the core (server-authoritative, §2). Beyond that the three surfaces are gated **differently**, and the difference matters:

- `shell.exec` is the strictest — a role permission **and** the farm-wide `shell.mode` switch **and** the same lease rule input uses (`ws-handlers.ts:939-957`). Studio hiding the terminal is a convenience, never the control.
- The raw adb REST surface (`adb-endpoint`, `install`/`push`/`pull`) is lease-scoped: `no_lease` and `not_lease_holder` are enforced server-side.
- `monitor.*` requires **no lease at all**, as described in the bullet above.

**Install has two distinct paths, and they are gated differently — both are stated precisely here because plan 93 found they had drifted (F10, 00-overview's Definition of Done: a plan touching a security surface updates the spec in the same commit).**

- **The REST path** — `POST /api/devices/:id/install` (and `push`/`pull`) — is the **lease-scoped** surface described in the bullet above: `device.files` (widened by `shell.mode`, the same switch the terminal and the adb endpoint use) plus the operator's own manual lease on that one device, exactly as `checkInputAllowed` enforces for input.
- **The batch path** — `POST /api/batches {scriptId:'internal:install'}` (and, since step 93.9, `internal:push`/`internal:pull`) — does **not** and structurally **cannot** require the operator to hold a manual lease on every targeted device: a batch install must not require twenty leases acquired by hand. Instead, each dispatched member holds a **job** lease (F20) for the duration of its own transfer — a real exclusive hold, just not the operator's manual one, released the instant that device's transfer finishes. As of plan 93 (step 93.8, closing F10), this path is gated by `device.files` (the SAME permission the REST path checks, evaluated against the acting operator's role) **and** the farm's `transfer.enabled` switch, both checked once, before any job row is written — previously it checked neither, an escalation where `POST /api/batches {scriptId:'internal:install'}` installed an arbitrary APK on every device in a cluster with only `job.run`. `JobExecutor.requires` (`jobs/executor.ts`) is the declaration every dispatch path (a standalone job, a batch, a schedule) reads through the one shared `validateScriptForRun` — a DECLARATION of what an executor needs, not a second authorisation system: it reuses `canUseFiles`/`canUseShell` and the farm's live settings, never a new gate function.
- A schedule that dispatches `internal:install` on its own cron takes the batch path's same two-part gate, evaluated at the schedule's OWN create/edit time (an interactive actor) and, separately, has no interactive actor to check a role for at the moment it actually fires — the farm-wide `transfer.enabled` switch still binds regardless (a farm setting is farm-wide authority, not a per-user one), matching the same "no interactive caller" reasoning already applied to a schedule's device-ownership check.

*(Corrected 2026-08-09, two days after the reconciliation that wrote this section: the first version of this paragraph claimed every one of the three required a lease. That was wrong for `monitor.*` and understated `shell.exec`. It is recorded here rather than silently rewritten, because a source-of-truth document overstating a security guarantee is a worse failure than the drift the reconciliation existed to fix.)*

**What leasing does not guarantee:** once a lease is held, there is no further restriction *inside* that device — the operator has the same reach as a local `adb shell`, including reading any file, any app's data the adb user can reach, and any command. This is the same trust model as §11.3's first half, extended to a second actor: **the authenticated, leased operator is a trusted operator**, exactly as the script author is. Neither the shell, the monitor streams, nor the raw adb endpoints are a narrower or safer surface than a script running under crash containment — they are the same trust boundary, reached a different way. A real security boundary between *different* operators (as opposed to between an operator and the core) remains the same unbuilt, out-of-scope-until-multi-tenant work described above.

**There is a third surface, and its author is the first actor again: a plugin's own browser code** *(added by plan 111 §0.1, 2026-08-17)*. A plugin may ship a React module that Studio loads into its own page and mounts in its own component tree (§11.6, tier C). That code is same-origin, sits behind no boundary of any kind, and reaches the farm's API with whatever session has the page open. It grants no trust that was not already granted: the same plugin's scripts run in the core's own process with the core's full OS authority, so its author is already trusted absolutely by the first half of this section, and withholding the operator's session in the browser was protecting nothing while capping what a plugin screen could be. What it does change is **attribution** — an action taken by a plugin's UI is attributed to the operator whose browser ran it, so an admin who opens a plugin screen lends that plugin their token and the audit row names the admin, not the plugin's author. That is a known property, written here rather than discovered later. The error boundary Studio puts around a mounted plugin component contains a **crash**, not a plugin, and is never to be described as isolation.

**There is a third actor, added by plan 91: an operator *assisting* a device someone else already controls**, holding no lease on it at all. This is deliberately a narrower trust decision than either actor above — a leased operator's reach is "the same as a local `adb shell`"; an assisting operator's reach is **five input verbs and nothing else** — tap, swipe, gesture, key, text. Never a shell, never the filesystem, never an arbitrary command, never a read of anything on the device beyond what those five verbs already imply. `checkInputAllowed`, the gate every surface above (the shell, `inspect.*`, `clipboard.set`, the raw adb endpoints, install/push/pull) still goes through unchanged, is never widened for this actor: a second, separate gate (`checkAssistAllowed`) is consulted only by the input-message handler, and only after the lease gate has already refused it. The boundary is proven structurally, not by review — a client holding only an assist grant is refused `shell.exec`, `inspect.attach`, `clipboard.set`, `POST /:id/push`, and `POST /:id/adb-endpoint`, all five, on the same device, while its own taps and key presses succeed. See §10.5 for the grant's full shape, gating, and lifetime.

**A stored upstream proxy credential can be read back in plaintext, by an admin, once per deliberate request, and every attempt is recorded** *(added 2026-08-18; this REVERSES a stated posture and is written here rather than left to be discovered)*. A `vpn-helper` route's upstream password has been stored since plan 52 §4.2 — encrypted under the `'network'` namespace of `packages/core/src/secrets/store.ts`, referenced from the route by `credentialRef` — and until now the API never handed it back and Studio said so ("Never shown back — type it again to change the route"). That was a real operational dead end: an operator could not tell which upstream session a phone was on, hand the account to a colleague, or rotate it, because the farm had swallowed it. `POST /api/devices/:id/network/credential/reveal` is the door, and its shape is the whole of the trust decision:

- **Gated on `device.network` *and* the admin role**, checked together. `device.network` is operator-level and stays that way for *setting* a route; reading one back is not the same authority, because a password that leaves the farm works from any machine forever after and nothing about it is scoped to this farm any more. That is the same reasoning §11's `kv.manage` already carries for the other surface that returns a plaintext secret, and it lands in the same place: admin only. An operator keeps the control on screen, disabled, with the reason — never a silently missing button.
- **Never part of `GET /:id/network`.** That endpoint is polled by the device panel; a password on it would travel continuously to every open browser whether anyone asked or not. The **username** *is* on it (`config.credentialUsername`, resolved from `network_credentials`): a username is the session string that identifies which upstream identity a phone is on, not a secret, and withholding it made every route an opaque `credentialRef`.
- **Audited every time, refusals included** — one `device.network.credential.reveal` row per request, naming the operator, the device, the outcome, and the credential's *name*. Never the password, never the username's value, and nothing derived from either. The row is written *before* the response body is serialised, so an audit failure fails the request: an unaudited reveal is not a degraded success.
- **The caller never names the credential.** There is no `credentialRef` in the request — it is whichever one that device's own route references — so the route cannot be used to enumerate the farm's credential store.
- **No lease is required**, unlike every other mutating route on a device: this one never touches the phone, and demanding a lease would block exactly the "read it out to hand to a colleague while a job runs" case it exists for.
- The plaintext exists in the response body and nowhere else: not logged at any level, not in an error message, not cached (`Cache-Control: no-store`), not held in any server-side state.

This does not change the encryption's honest claim, which is unchanged and still modest: a secret here is "not readable by grepping the database", not key management. Anyone with read access to the data directory can already read the key file beside `enkaku.db` and decrypt every secret — which is the real point about this reveal: it does not grant an admin a capability they lacked, it gives them a *recorded* way to exercise one they always had.

### 11.4 Dependencies and publishing (NEW in v0.2)

Scripts are stored as source in the DB — but what about npm packages? The flow: the SDK CLI `enkaku publish` *bundles* the script plus its dependencies into a single file (esbuild/bun build), and the farm only ever accepts a **finished bundle**. This simplifies the runner and makes dependencies deterministic.

**A script cannot exist outside a plugin** *(plan 110 §3.2; the removal of the last traces of the older shape documented in the same pass that shipped it, 2026-08-17 — not a register entry)*. Every `kind: 'script'` row carries an owning plugin: `enkaku publish` refuses an entry that is not a `definePlugin()` result, and `POST /api/scripts` refuses a name that owns no plugin with `E_SCRIPT_NEEDS_PLUGIN` (400). There is one publish shape, one authoring shape, and no second category anywhere in the product — no "standalone" script, and nothing in Studio that filters for one. A farm that upgraded into the rule may still hold rows published before it; **the farm ignores them**: they are not listed, not grouped, not resolvable, and cannot be run, scheduled, or batched. That is never silent — the core counts them once at startup and emits exactly **one** warning naming how many there are and which names, whatever the number of rows. Nothing deletes them (that stays the operator's call), and the job history that references them still reads back correctly, because `jobs.script_name`/`script_version` are denormalised at enqueue for exactly this. A **workflow** (§11.7) carries no owning plugin either and is deliberately *not* covered: its `bundle` is a document rather than a plugin bundle, so there is no plugin for it to be a member of, and it lists, groups and resolves exactly as it always has.

### 11.5 Lifecycle and management

CRUD through Studio: create, edit, version, enable/disable, delete, run with parameters. Script authors write in their own editor with `@enkaku/sdk`, then publish to the farm.

### 11.6 Plugins — many scripts, one bundle (plan 82)

A **plugin** is one TypeScript project — an `index.ts` calling `definePlugin` — that publishes many scripts sharing helpers, types, and constants by ordinary import, as one bundle instead of one per script. Publishing a plugin writes one `plugins` row (identity plus version, so a farm can say what it is running and roll back) and N ordinary `scripts` rows, one per script it defines, each pointing at the same bundle blob and named `<plugin>/<script>` (e.g. `tiktok/login`). A plugin is a grouping and build concept, not a new execution path: a job still runs through the existing executor and still pins a concrete, resolved entry at enqueue, so publishing a new plugin version never changes what an already-queued job runs (§11.2's rules apply unchanged). A plugin may also occupy a **dev slot** — a built-but-unpublished bundle, runnable immediately for iteration, never a database row, and gone on a core restart. A published plugin can be rolled back to a previous version (`POST /api/plugins/:name/rollback`), disabled, or reloaded from its dev-slot bundle after an edit (`POST /api/plugins/:name/reload`); Studio's **Plugins** screen (§19) surfaces this as a failed-plugins-first list with the verbatim error, code, and dev-slot badges *(rollback/reload endpoints and the Studio screen mentioned in reconciliation, 2026-08-09, DIV-056 — follows the owner's general direction, not an individually ratified decision)*.

**A plugin may also contribute a screen, not only scripts** *(added directly by plan 108 §3.2–§3.9, §4.1–§4.5, 2026-08-17 — new product surface, documented in the same pass that shipped it, not a register entry)*. `PluginDefinition.surface` is an optional block declaring **nav** (up to 8 sidebar entries, each an id, a label, an icon from a closed allowlist, and the view it opens), **views** (up to 16 screens), and **actions** (up to 32). A plugin that omits it is unaffected in every way. The surface is **data, not code** on the default path: there is no expression language, no string interpolation, and no author-supplied JavaScript in the operator's session — a view that declares `react` is the one, deliberate exception, described next.

**Two tiers, and each one's cost is stated rather than implied** *(rewritten by plan 111 §3.1–§3.6, 2026-08-17: the tier B this paragraph used to describe — a sandboxed iframe — was removed from the code, not deprecated, and what replaced it reverses a refusal this spec previously called permanent. The reversal is set out below rather than quietly dropped.)*

*Tier A* — the default — is a declared view: a data source, a table, a toolbar, and row actions, rendered by Studio's own components. A plugin's screen is not "styled consistently"; it is drawn by the same `Table`, `SchemaForm`, and `ConfirmDialog` every other screen uses, so it inherits every later change to them for free. No build step, no npm install, no bundler.

*Tier C* is a React module the plugin ships. A view states `react: { entry, apiVersion }` in place of `table`; Studio loads that module out of the plugin's own `ui/` directory and mounts the component **inside Studio's own React tree**, running on Studio's own React. The contract is deliberately stated as a contract and not as a mechanism — the module registers a component under a view id, and the host mounts it — because how it is loaded belongs to Studio and will keep changing. A tier-C module imports `@enkaku/ui`, the component library Studio itself is built from, and receives the **host's live instances**: its `Table` is not a lookalike of Studio's `Table`, it is the same one, and it picks up the next change to it the day Studio does. It reads and writes by calling `fetch` directly, with the operator's session. There is no bridge, no RPC, and no frame.

**The refusal this spec used to make, and why it was withdrawn.** Earlier versions of this section refused *permanently* to load plugin JavaScript into the Studio bundle itself, on the ground that Studio is a static export served same-origin by the core, so third-party code in that page could call any API as the operator. **Tier C is exactly that, and the refusal is withdrawn** — by the farm owner, deliberately, after being shown the concrete consequence: a plugin runs with whatever session opens the page, so an admin who opens a plugin screen lends that plugin their token, and the audit row names the admin (§11.3, third surface). The reasoning (plan 111 §0.1) is that the refusal was protecting nothing it claimed to protect: a plugin's *server* half already runs arbitrary code in the core's own process with the core's full OS authority (§11.3 — a script bundle is not sandboxed), so a plugin author is already trusted absolutely, and an operator installs a plugin the way they install anything else they have chosen to trust. Withholding the browser session extended trust to nobody new; it only put a ceiling on what a plugin screen could be.

**So tier C is not contained, and this document will not imply that it is.** What survives is containment of a *mistake*: an error boundary around the mounted component means a plugin that throws renders a named error instead of taking the page down. It contains a crash and nothing else. The costs an author is choosing when they take tier C are a build step, a version coupling, and no sandbox — `docs/design.md`'s "Tier A or tier C" states them and gives the rule for choosing between the two.

**The rules that hold across both tiers.** `react` and `table` are **mutually exclusive** and a view needs exactly one *renderer*; `data` is legal beside either, so a React view may declare a source and read it through the same `/api/plugins/:name/data/*` route a table does, and may invoke the same declared `actions` — the action route stays the only path that resolves a `ScriptRef` server-side and audits as `plugin.action`, whoever calls it. `actions` may be omitted entirely (it defaults to `{}`), because a React view that calls `fetch` for everything declares none. `react.apiVersion` is the `@enkaku/ui` major the module was built against; it is **required**, never defaulted, and the farm compares it at **verify** against the major it ships (`PLUGIN_UI_API_VERSION`, `@enkaku/protocol`) with exact equality. A mismatch is `E_PLUGIN_UI_UNSUPPORTED`, naming both numbers, so the plugin is refused before it can be activated rather than rendering blank in front of an operator. The comparison is equality and not a range because a stable component API is explicitly not promised — Studio's components are internal and change. On styling: a tier-C view renders inside Studio's document and inherits Studio's stylesheet, so today it can only use the classes Studio itself already compiles; letting a plugin compile its own utilities against a theme `@enkaku/ui` exports is decided but **not built** (plan 111 §9 Q1, step 111.9).

**A view's columns and forms are JSON Schema nodes, and this plan adds no field vocabulary at all.** A column is planned by the same `planField`/`formatValue` resolver a parameter form uses; an action's form is rendered by `SchemaForm`. The surface vocabulary adds *layout* only (§8's rendering principle, and `docs/design.md`'s "Plugin views"). An action reads its inputs through a closed, non-Turing **binding** language — a JSON literal, `$row.<path>`, `$form.<path>`, `$device.<field>`, `$entry.<field>`, or an object/array of those, evaluated by a pure, depth-capped function — the same discipline §11.7's workflow gates already follow.

**Actions execute server-side**, at `POST /api/plugins/:name/action/:actionId`, for three reasons that would each otherwise be a hole: a `batch` needs a concrete `scripts.id` while a `job` takes a ref, and resolving that in the browser would duplicate the registry; the binding evaluation must be the one that was verified; and the audit row must name the plugin and the action, not merely record that a job was created. The four action kinds are `job`, `batch`, `kv.set`, and `kv.delete`, plus a `form` wrapper that opens a `SchemaForm` and then runs one of them. Permission is derived from the **action**, never from the route: `job`/`batch` need `job.run`, `kv.set`/`kv.delete` need `plugin.data` (§12.4).

**A plugin ships as a `.enkaku` package** — a plain `tar.gz` holding `plugin.json`, `scripts.mjs`, and an optional `ui/` directory (a tier-C view's built module and any asset it ships; `react.entry` names a path inside it), written and read by the core's own dependency-free tar implementation so the release binary needs no system `tar`. Any entry outside that allowlist is refused at verify, which closes path traversal by construction rather than by sanitising. `POST /api/plugins` accepts either shape: the original JSON body (`{ name, version, bundle }`, unchanged) or a raw package upload. The surface is verified in the **same child process** that already imports the bundle, under the same bound, and re-validated independently by the parent — the whole block against its schema, every embedded JSON Schema through the same gate a `params` schema passes, every action reference resolved, every icon in the allowlist, every cap checked. Any failure is `E_PLUGIN_SURFACE_INVALID`: the plugin is recorded `failed`, registers zero scripts, and disturbs nothing else.

REST, beyond the lifecycle routes above: `GET /api/plugins/ui` (`script.view`) — the nav entries of every active plugin and dev slot, and nothing else, so a staged, failed, superseded, or disabled plugin contributes no sidebar entry; `GET /api/plugins/:name/view/:viewId` (`script.view`) — one view plus only the actions it references; `GET /api/plugins/:name/ui/*` (`script.view`) — a `ui/` asset, the one route that serves a plugin's own bytes to a browser, resolving a **dev slot ahead of the active row** so `enkaku dev` iterates a React view, with one 404 code for all three misses so a prober cannot tell them apart. A path is looked up by exact match in the package's already-validated entry list, so traversal is closed by construction rather than by sanitising. It carries `nosniff`, `no-referrer`, and `no-store`, and deliberately **no** `Content-Security-Policy`: plan 108's strict policy governed a document loaded into a frame, and a module loaded as a subresource of Studio's own page never consults one (removed by plan 111 step 111.4, with the full reasoning kept in `packages/core/src/plugins/asset-store.ts` where the constant used to be); the five `/api/plugins/:name/data/*` routes (`plugin.data`, §12.4); and the action route above. **Studio: the plugin-view screen and the sidebar's plugin group (§19).** A route registered here with no way to reach it from Studio fails a test that reads this router's own source (`packages/core/src/api/plugins-route-parity.test.ts`) — an opt-out requires a written reason, because four such routes had already shipped unreachable before this plan.

**A plugin can also run code for as long as it is enabled — a `service` — and it runs INSIDE THE CORE'S OWN PROCESS** *(added directly by plan 109 §3.1–§3.2, §4.2, step 109.2, 2026-08-17 — new product surface, documented in the same pass that shipped its host, not a register entry)*. `PluginDefinition.service`, written with `defineService({ permissions, setup })`, declares the long-lived half: code that starts when the plugin is activated, is torn down through `ctx.onStop` disposers before every reload/disable/remove/shutdown, and is reported to the operator under a status of `stopped | starting | running | failed | stopping`. **`starting` is never worded as `running`** — a service is `running` only once its `setup` has resolved, and until then every call into it is refused with a coded error rather than queued, because an operator who reads `running` will assume the port is bound and the subscriptions are live. It is `service` and not `runtime` deliberately: a plugin MEMBER's `runtime` is already §11.2's execution envelope (`timeoutMs`, `retries`, `maxRssBytes`, `maxConcurrent`), and two keys one level apart sharing a word while meaning unrelated things is a permanent trap in a published authoring type.

**This is not a sandbox, and this document will not imply that it is.** What the host contains is real and bounded: a handler that throws, a handler that rejects, a handler that overruns its deadline, a module that fails to import, and a floating promise rejection the farm can trace back to a plugin are each caught, charged against that plugin's error budget (20 failures in 60 seconds disables its service, surfaces the last error verbatim, and never retries), and reported. **What it does not contain, by any amount of `try`/`catch`, is the following — and each one takes the whole core down with it, freezing every device on the farm:** a synchronous infinite loop in plugin code (the event loop stops), running out of memory, a `process.exit()` anywhere in plugin code, and a native crash inside an npm dependency a plugin imported. There is also no per-plugin memory ceiling, because RSS is process-wide once the code shares a process; what the farm reports instead is per-plugin counters (invocations, failures, timeouts, event deliveries, attributed rejections, open listeners) and a warning when a plugin's own reported listener count crosses a threshold — an honest substitute, not an equivalent. This is the same position §11.3 takes for a script bundle, and it is defensible for the same reason: a plugin is written by the farm operator, there is no marketplace, no third-party distribution, and no signing. `service.isolation` accepts `'process'` in the manifest so that reserving the escape hatch costs nothing later, and the farm **refuses it at verify** with `E_PLUGIN_ISOLATION_UNSUPPORTED`, naming it as unimplemented, rather than accepting a manifest it would silently ignore.

**`definePlugin` and `defineAgentPlugin` are two different, deliberately unrelated things that happen to share a word.** `definePlugin` (`@enkaku/sdk`) is the public authoring API described above — a script author's `index.ts` calls it, and it is the only one of the two ever exported from the SDK a script project depends on. `defineAgentPlugin` (`packages/core/src/agent/plugins/`, plan 77) is core-internal: it groups the AI agent's own built-in capabilities (device control, workspace, skills, and so on) into named sections of the agent's system prompt, compiled into the core binary. A script author has no way to reach `defineAgentPlugin` and never sees its output; an agent capability author never touches `definePlugin`. The two names collide in English, not in any code path either type of author can reach.

### 11.7 Workflows — a pipeline of scripts, one job, one device (plan 99, M64) *(added directly, 2026-08-13 — new product surface, documented in the same pass that shipped its publish route, not a register entry)*

A **workflow** is a `scripts` row like any other, distinguished only by `scripts.kind` (`'script' | 'workflow'`, default `'script'` — every row published before this plan reads back unchanged). Where an ordinary script's `bundle` is a finished ESM bundle (§11.4), a workflow's `bundle` is a validated **workflow document** (`WorkflowDocSchema`, `@enkaku/protocol`): an ordered list of **nodes** — each an ordinary published script reference, run as its own child process through the SAME runner every standalone job uses — plus **gates**, which evaluate a closed, non-Turing predicate over earlier nodes' outputs and workflow parameters (no author-supplied code, no regular expressions) and choose to continue, stop, fail, or jump. A workflow runs as **one job**, under **one lease**, on **one device**, for its whole pipeline — the queue, the lease, and the pre-job reset are unmodified; only the executor selected for `kind: 'workflow'` differs. REST: `POST /api/workflows` (publish; delegates to the same writer every script publish uses), `POST /api/workflows/validate` (the same static check, without writing anything), `GET /api/workflows/:name/versions`. `GET/POST /api/scripts` gained `kind` on every row and an optional `?kind=` filter so a workflow is reachable from the same list every script already is. **Studio: `/workflows` (the list, grouped by name like Scripts) and `/workflows/editor?name=…` (the list-editor — node rows with drag-reorder, a script+version picker per node, a bindings sub-form binding each parameter to a constant/workflow parameter/earlier node's output/the run summary, Promote to lift a node parameter into a workflow parameter, a bespoke predicate editor for a gate's condition, and Validate)** *(added directly, 2026-08-13, plan 99 §5 step 99.9)*. See `docs/plans/99-m64-workflows.md` for the full design.

### 11.8 Action recordings — a captured macro that compiles to an ordinary script (plan 94, M59) *(added directly, 2026-08-13, documented in the same pass as its own §12.5/§19 companions — new product surface, not a register entry)*

An **action recording** captures an operator's manual taps, swipes, gestures, key presses, and typed text — the same input surface the device page's live control already sends — with every coordinate stored normalised 0..1 (a tap's point, a swipe's `from`/`to`) so a recording replays correctly on a device with a different screen size than the one it was captured on. **A recording is *source*; a script is its *build output* — there is no second artefact type.** `scripts.kind` has exactly two members, `'script' | 'workflow'` (§11.7); there is no third for a recording, and a recording is never stored as a database row of its own — it lives as `/recordings/<slug>.recording.json`, an ordinary workspace file (§12.2).

That document compiles to a short, generated entry — one `import { defineRecording } from '@enkaku/sdk'` followed by one `export default defineRecording({ ... })` call with the recording document inlined — deterministic and byte-identical on a re-compile of an unedited document, so recompiling never drifts from the source that produced it. Publishing goes through the **exact same** `buildScriptFromWorkspace` + `publishScript` pair every hand-authored script's `script.publish { path }` form already uses — no second bundling path exists for a recording. The published row is an ordinary `scripts` row, `kind` left at its default (`'script'`) — indistinguishable from a hand-written script on every surface that reads it, including the run dialog, job history, and `GET /api/scripts`.

REST, under `/api/recordings`: `GET /` (list), `GET /:slug` (the document), `POST /` (creates the first `.recording.json` from a device's just-finished recording session — the one write path nothing else here performs), `PATCH /:slug` (edits, compare-and-swap against the document's own content hash — a write against a stale hash is refused with `E_STALE`, never silently applied over someone else's edit), `DELETE /:slug`, `POST /:slug/publish` (compiles and publishes, optionally bumping the version), `POST /:slug/detach` (writes a plain `defineScript` to `/scripts/<slug>.ts` with every step expanded as a literal, ordered `await` — never an interpreter loop — refuses to overwrite a pre-existing hand-authored file at that path, deletes the compiled `/recordings/<slug>.ts` entry so nothing regenerates over it again, and marks the document detached; **one-way** — a detached recording no longer compiles, and `/scripts/<slug>.ts` is the operator's own file from that point on). Studio: `/recordings` (the list) and `/recordings/detail?slug=…` (the review panel — a query parameter, not a dynamic route segment, the same static-export precedent `/device?id=…` set, §19).

**A typed-text step is stored, and stays, exactly as typed — a real, disclosed privacy exposure the farm owner has not yet ruled on.** A `text` step's literal string is captured unconditionally, regardless of the farm's `logInputText` setting — that setting gates only what the device event/audit log may show (§18), an unrelated, narrower concern; the recorder needs the real string to be replayable at all, so it is captured either way. A recording made while an operator types a password or a one-time code into a login screen stores that value in the clear, on disk, in the workspace — and unless the step is explicitly parameterised before publish, the same literal reappears verbatim in the published script's own source, readable by anyone who can read a script. **This is not softened to "text steps are stored":** the review panel names it, in plain sight next to the value itself (not a tooltip, not a doc footnote), at every unparameterised typed-text step: *"Stored verbatim — this exact text is saved to the workspace and will appear in the published script's source, regardless of the farm's 'log typed text' setting."* A recording is therefore exactly as sensitive as the device session that produced it — reviewing one shows what was typed, the same as watching the screen live already would have — and that is disclosed on purpose, not smoothed over. Whether a further mitigation (masking, a farm-wide opt-out, redaction on capture) is warranted is a decision the farm owner has not yet made.

### 11.9 The output contract — what a script returns, and who may believe it (plan 97, M62) *(added directly, 2026-08-13, documented in the same pass that shipped it — not a register entry)*

`params` has always been typed, validated on both sides, and rendered as a generated form (§11.1, §11.2, plan 95). Its output — `run`'s return value — was `unknown` at every hop: never validated, never measured, never bounded, rendered as a wall of raw JSON. `result` is the optional, second half of the same idea, and it is deliberately **not** the mirror image of `params`'s enforcement:

**Input validation is a gate; output validation is an assertion.** By the time a result exists, every tap has landed, every artifact is on disk, `finish()` has run, and the lease is about to release — refusing the job at that point would assert something false about the device and, worse, would feed plan 36's retry classifier a reason to re-run the entire device workload over a typo in a return value. So a result that does not match its declared schema **never fails the job**: the job settles exactly as it would have, the value is stored **verbatim** (never coerced, never stripped of unknown keys), and the row instead carries a status and the field paths that did not match.

**Five states**, `jobs.result_status`, written once at settle: `undeclared` (no schema declared — the compatibility floor; every script published before this feature, and every future script with nothing to say, stays exactly as it is), `valid`, `invalid` (declared, and the value did not satisfy it — stored as-is), `partial` (the run *failed*; `finish()`'s own return value, salvaged — never checked against the schema, because a run that did not finish has no contract left to hold it to), and `oversize` (the value exceeded `job.maxResultBytes`, a farm setting, default 64 KiB — the same cap `ctx.kv`'s value already uses — measured in the child **before** it crosses to the parent, so an oversize result costs the parent no memory; `jobs.result` is `NULL` and the operator is told to use `ctx.artifact.file` instead).

**A crash is not a result.** `jobs.error`/`failureClass`/`errorPhase` are unchanged and this feature adds nothing beside them — a script-authored error taxonomy would just hand plan 36's retry policy a second, less trustworthy input. A script that wants a failure a *later* script can branch on returns a successful job with a negative verdict instead (a discriminated union result, `{ ok: false, reason }`), never a thrown error.

**`ctx.progress(value)`** is the answer to "a long script produces output progressively" — and it is deliberately **not** a streaming result. It is coalesced (at most one push per `job.progressIntervalMs`, last value wins), never persisted (no column, no `UPDATE`, gone on restart), and never readable by `ctx.jobs.resultOf` or any other job. A job has exactly one result, written once, at settle — because `resultOf` already refuses a job that has not finished, and a streaming result would make that refusal meaningless.

**Where it is stored and served.** `scripts.result_schema` is the JSON sibling of `params_schema`, written at the same three publish paths and pinned to the version that ran (§12). `GET /api/jobs` carries `resultStatus`/`resultSummary` (a ≤120-character line built once at settle from at most three fields the schema marks `summary: true`) and never the value itself; `GET /api/jobs/:id` carries the full result plus its pinned schema and issues. Studio's job detail page renders a declared result as values through the same schema-driven vocabulary and resolver `params` already uses (§19; `docs/design.md`'s "Result views").

**Known gaps, stated rather than hidden:** MCP `tools/list` does not yet advertise a per-tool `outputSchema`; the cloud/node tunnel path does not yet forward live `ctx.progress` pushes (the local path is complete); Studio's job detail page does not yet render a live progress line above the result panel. None of the three affects `jobs.result_status`, `scripts.result_schema`, or any value already stored — each is an unbuilt read surface, not a gap in the contract itself.

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
  resultSchema: text('result_schema', { mode: 'json' }), // NEW (§11.9, plan 97) — the declared `result` shape, pinned per version
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
  status:    text('status').default('queued'), // queued|running|success|failed|cancelled|expired (last one added in reconciliation, 2026-08-09, DIV-070 — a real terminal state the queue produces on timeout, plan 21)
  leaseExpiresAt: integer('lease_expires_at'),
  result:    text('result', { mode: 'json' }),
  resultStatus:  text('result_status'),        // NEW (§11.9, plan 97) — undeclared|valid|invalid|partial|oversize
  resultBytes:   integer('result_bytes'),      // NEW (§11.9, plan 97) — measured in the child before crossing IPC
  resultSummary: text('result_summary'),       // NEW (§11.9, plan 97) — ≤120 chars, built once at settle
  resultIssues:  text('result_issues', { mode: 'json' }), // NEW (§11.9, plan 97) — Zod's own paths/messages when invalid
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
    rotation: z.enum(['device', 'lock-portrait', 'lock-landscape', 'lock-current'])
                       .default('device'),   // NEW (plan 85 §3.7) — applied at session
                                              // start, reverted on close, same shape as stayAwake
  }),
  input: z.object({
    preferredMode: z.enum(['uhid', 'sdk', 'aoa']).default('uhid'),  // NEW (§9)
  }),
  autoReconnect: z.boolean().default(true),
})
```

Screen dimensions, density, and apiLevel **must** be probed once on connect and cached — coordinate mapping and feature gating (UHID needs a particular Android version) depend on them.

> **Note** *(added in reconciliation, 2026-08-09, DIV-029 — accepted as uncontroversial by the audit).* The `devices` and `jobs` blocks above are not a full schema dump — they show the columns meaningful to the concepts this document already describes. The shipped tables carry more: `devices` also has `quarantineReason`, `nodeId`, `tenantId`, `clusterId`, `desiredReadiness`, and `networkRoute` (each the anchor of a subsystem described below or elsewhere in this spec); `jobs` also carries batch membership, expiry, failure classification, an infra-retry count, and the trigger/lineage chain used by schedules (§12.3). See `docs/spec-divergences.md` (DIV-029) for the complete, currently-verified column set.

### 12.1 AI agents *(added in reconciliation, 2026-08-09, DIV-019 and its companions — owner decision 2026-08-03, Plan 84 §9 Q1; applied to this document in this pass)*

An **AI agent** is a stored, editable configuration — model, provider connector, system prompt, context budgets, tool allowlist, device grants (empty/null = ALL devices), workspace scope, permissions — that a farm operator creates through Studio's **AI agents** screens (§19) and that then runs conversations (`agent_threads`), executes turns (`agent_runs`), and exchanges messages (`agent_messages`, including images stored content-addressed in `agent_blobs`) much like a script does, but interactively and with its own capability model. Destructive capability calls can pause for a human decision (`agent_approvals`, persisted so a core restart resumes the run exactly where it paused); an undelivered message to a running agent queues in `agent_inbox` until the next turn boundary; and one agent may be allowed to spawn another, opt-in per pair (`agent_spawn_grants`, defaulting to none) — managed through `GET/POST /api/agents/:id/spawn-grants` and `DELETE /api/agents/:id/spawn-grants/:childId`.
The REST surface is `GET/POST/PATCH/DELETE /api/agents*` for agent CRUD, `/api/v1/threads`, `/api/v1/runs`, `/api/v1/approvals`, and `/api/v1/agent-commands` for the conversation itself, plus `/api/v1/blobs`, `/api/v1/cap` (the capability registry), an MCP endpoint (`POST /mcp`), and an OpenAPI document (`GET /api/openapi.json`).

**Naming: `ai_agents` is not `agents`.** For this project's entire history until plan 61, "agent" meant the cloud tunnel mini-core — now called `nodes` (§4, §5.3). Reusing "agent" for this feature would recreate exactly that ambiguity, which is why the table is `ai_agents` and every table it owns is prefixed `agent_*` while remaining conceptually unrelated to a `node`. Keep the two distinct when reading or writing about either: a **node** tunnels a farm's devices to a cloud control plane (§5.3); an **AI agent** is an in-product chat/automation actor with its own device grants and workspace. `defineAgentPlugin` (§11.6) is a third, also-unrelated use of the word, internal to how an agent's own built-in capabilities are packaged.

### 12.2 Connectors, workspace, webhooks, and notifications *(added in reconciliation, 2026-08-09, DIV-015/DIV-018/DIV-026/DIV-027 — Cluster A, owner decision)*

Four more tables support the AI agent and are described here alongside it, per the owner's ruling that they ride along with the `ai_agents` decision:

- **`connectors`** — a farm-level, admin-managed LLM provider endpoint (Anthropic, OpenRouter, and so on) plus an AES-256-GCM-encrypted credential, shared across agents. **Load-bearing**: an agent cannot run at all without one, which is why this table was decided alongside `ai_agents` rather than separately. REST: `GET/POST/PATCH/DELETE /api/connectors`, `GET /:id/models`, `POST /:id/test`.
- **`workspace_files`** — a content-addressed, DB-backed *virtual* filesystem the AI agent reads and writes instead of the real OS filesystem, deliberately, since an agent (reading attacker-controllable device screens) runs under the same crash containment as a script, not a sandbox (§11.3). SQLite holds only the catalogue — path, size, hash, content type, timestamps, and (`storage`, `locator`) which content driver a row's bytes live behind — never the bytes of a file over the inline threshold *(extended by plan 115 §3.1–§3.5, §4.3, 2026-08-18 — documented in the same pass that shipped it, not a register entry)*. A write is routed by policy, never by caller choice (plan 115 §3.4): small text (a script, `captions.txt`) stays `storage: 'inline'` in the row exactly as every pre-existing row does; anything over `workspace.inlineMaxBytes`, or anything not text, is written by the `fs` content driver to `<dataDir>/workspace-content/<first-two-hex-of-sha256>/<sha256>` — content-addressed on the file's own hash, so a rename is a row update only (never a file move), two uploads of identical content share one file on disk, and no operator-supplied filename is ever joined to that root. `workspace.maxFileBytes`/`maxFilesPerScope`/`maxTotalBytesPerScope`/`inlineMaxBytes` are farm settings, not schema, and are now a disk budget (256 MiB / 1000 / 8 GiB / 64 KiB defaults) rather than a database one. **A backup that copies only `enkaku.db` does not capture this content**: `enkaku backup` (§19's Settings row) archives the database and `secrets.key`, never `workspace-content/`, so restoring only the database leaves any non-inline workspace file's row pointing at bytes the restore did not bring back — see `docs/guide/install.md`'s Backup and restore section. Studio's **Workspace** screen (§19) is a tree-plus-editor view over the same `fs.*` capabilities the agent itself uses, with compare-and-swap saves, plus an **Upload** control (`POST /api/workspace/file`, multipart — the browser's way of getting bytes in, auth and audit shaped like `POST /api/artifacts`'s own upload; `fs.write` stays exactly as it is, the way a *script* writes) and a **Rename** action, beside the create/edit/delete the page already had.
- **`webhook_endpoints`** — farm-level, admin-managed webhook targets. An agent can only choose among these **by name**, via `notify.send` — never a raw URL — so a webhook call cannot leak farm data to an arbitrary address. REST: `GET/POST/PATCH/DELETE /api/webhooks`.
- **`notifications`** — the in-app notification record (the bell). Written *before* any webhook delivery is attempted, so the record survives even when delivery fails; `context` makes a row clickable. REST: `GET /api/notifications`, `GET /unread-count`, `POST /:id/read`, `POST /read-all`.

### 12.3 Clusters, batches, and schedules — the recurring-dispatch scheduler *(added in reconciliation, 2026-08-09, DIV-010/DIV-011/DIV-012/DIV-013/DIV-014 — Cluster B, owner decision: "the scheduling subsystem is wanted scope; the spec absorbs it")*

This is a different mechanism from §10's per-device job-queue picker — see the naming note at the top of §10. Three tables plus two companions:

- **`clusters`** — a container, not a selector: a device belongs to at most one cluster (`devices.clusterId`), and the table itself carries only the cluster's own identity. `/clusters` (Studio, §19) and `/api/topology` show devices grouped this way. REST: `GET/POST/PATCH/DELETE /api/clusters`, `POST/DELETE /:id/devices`, `POST /preview`; `GET /api/topology`.
- **`batches`** — one script run resolved across a device set (explicit list, a tag, or a cluster), optionally **paced**: `count`/`intervalMs`/`deviceIntervalMs` (plan 94 §3.7–§3.9, §4.8–§4.9, step 94.7/94.8) repeat the run on each device its own number of times, staggered once at each device's first repetition and re-armed on an interval drawn fresh (`crypto.getRandomValues`, never `Math.random`) between repetitions — enforced entirely from `jobs.notBefore`/`.batchRepeat`/`.pacedDelayMs` rows, resumed from the database alone after a restart, never a process-memory schedule. A boot-time sweep (plan 94 §5, step 94.11) closes the one gap that restart-from-rows alone cannot: a batch whose last device's last repetition already settled before a crash, leaving `batches.status` cached `queued`/`running` with zero live jobs because the crash landed between that settle and the status recompute — reconciled to its real terminal status on boot, logged, and never for a batch an operator already left `'stopping'` (a written state this sweep does not read at all). `status` is a cached projection recomputed from the member jobs, never incremented directly, **except `'stopping'`** — a state, not a derived value, written only by `POST /:id/stop` and held until every member has actually settled. REST: `POST/GET /api/batches`, `GET /:id`, `POST /:id/stop`, `POST /:id/rerun-failed`, `POST /:id/rerun?only=failed|skipped` (plan 93 §3.12, §4.4, §4.6, step 93.8 — additive beside `/rerun-failed`, not a replacement; `?only=skipped` is the new capability, retargeting exactly the devices `batches.skipped` names rather than the batch's whole original target), `GET /:id/artifacts`, `GET /:id/artifacts.zip`. Both rerun routes carry the ORIGINAL batch's own priority, pacing (full `count`/`intervalMs`/`deviceIntervalMs` shape) and queue-timeout **policy** forward (plan 94 §5, step 94.11, F30, acceptance criterion 19), through one shared function so neither route can drift from the other: `priority` verbatim; the queue timeout as a re-applied **duration** (the original `expiresAt − createdAt`) from the rerun's own dispatch instant, never the stale absolute timestamp, so an already-expired original does not make the rerun expire on arrival; and pacing re-runs the FAILED (now including `expired`, deduplicated per device) devices with the batch's full original repeat count, not however many repetitions each device individually still owed — a device that failed, then succeeded, then failed again has no single well-defined "remaining" count, so a rerun redoes the whole thing. The stagger restarts from the rerun's own dispatch instant, never the original batch's `createdAt`, because `createBatch` re-derives it at dispatch time regardless of caller. (plan 93 §3.13, §4.4, §4.7, step 93.10 — the per-device files a bulk pull collected, and a stored/uncompressed zip of the same, capped by `transfer.maxArchiveBytes` and refusing **before the first byte** rather than truncating a half-written archive); pushed live over WS as `batch.status`. `POST /:id/stop` (plan 94 §3.9, §4.9, step 94.8) **replaces** the old `/:id/cancel` (00-overview §4.3 — a verb that only touched queued members was never a useful one): it marks the batch `stopping` first (so the pacer plans no further repetition, in any interleaving), cancels every queued member, aborts every running one through the SAME `JobService.cancel()` a standalone job cancel uses (no second abort path), and reports `{ cancelled, aborted, refused, refusedDeviceIds }` — gated **per member** by `canCancelJob` (device ownership or `job.cancel.any`), so an operator without rights to some of a batch's devices stops the rest and sees exactly how many, and which, were refused rather than a silent partial success. A schedule's `onOverlap: 'cancel-previous'` (below) routes through this exact same function.
- **`schedules`** — cron-triggered dispatch of a batch **or an AI-agent thread** (`schedule_agent_targets` is the companion row that marks a schedule as agent-targeted, checked by the dispatcher before it reads `schedules.scriptRef`), with overlap policy, a queue timeout, catch-up behaviour, jitter, and priority. REST: `POST /validate`, `GET/POST /api/schedules`, `GET/PATCH/DELETE /:id`, `GET /:id/runs`, `POST /:id/run-now`; pushed live over WS as `schedule.fired`. `schedule_runs` records one row per fire decision, including "ran nothing" outcomes (`skipped-overlap`, `skipped-missed`, `no-targets`, `error`), so a schedule's history is never a blank gap. `onOverlap: 'cancel-previous'` (plan 94 §3.9, §4.9, step 94.8) stops the previous batch through the SAME `POST /api/batches/:id/stop` function above — queued AND running members, and the pacer — never a `cancelQueuedInBatch`-only shortcut, which for a paced batch would otherwise leave it planning further repetitions forever. A schedule also carries the batch's own pacing (`repeatCount`/`intervalMinMs`/`intervalMaxMs`/`deviceIntervalMs`, plan 94 §3.7, §4.8, step 94.9) straight through to `createBatch` on every firing, exactly like `concurrency`/`order`/`priority` — a scheduled paced batch and a hand-started one are the same dispatch, through the same seam. This is a DIFFERENT knob from the schedule's own `jitterSec`: jitter shifts the whole firing before a batch exists; pacing's interval shifts each repetition once it does. `schedule_runs.jitterMs` records the value actually drawn for that firing (`0` when no jitter was configured, or the run predates this column), so a run that fired late is never ambiguous between jitter and the farm being busy.

Studio: **Clusters**, **Batches**, **Batch detail**, **Schedules**, **Schedule detail** (§19).

### 12.4 Smaller tables and operational surfaces *(added in reconciliation, 2026-08-09 — mostly code-wins following the owner's general direction for the "remaining rows," not individually ratified; see `docs/spec-divergences.md` for the row-by-row detail this section deliberately keeps brief)*

- **Durable KV store** (`kv_entries`) — a key/value store scripts and plugins can read/write across job runs, keyed by `(scope, scopeId, namespace, key)` with `namespace` runtime-injected so two plugins cannot collide. REST, admin-scoped: `GET /`, `GET /namespaces`, `GET/PUT/DELETE /entry` under `/api/kv`. *(Extended by plan 108 §3.1, §3.7, §4.5, 2026-08-17 — documented in the same pass that shipped it, not a register entry.)* **A plugin has no storage engine of its own: `kv_entries` under the plugin's own namespace *is* a plugin's store**, shared by every member script and by the plugin's screens (§11.6), so a script's scrape is what a screen reads and a screen's write is what the next job reads. The two scopes mean different things and the rule is one sentence — **if forgetting the device should forget the fact, it is device-scoped**: a `global` entry (`scope_id` `''`) is a catalogue or a farm-wide setting, bounded by `kv.maxEntriesPerNamespace`; a `device` entry is keyed on the device's `stableId` (never the adb serial), is deleted in the same transaction that forgets the device, and is additionally bounded by `kv.maxEntriesPerDevice` across all namespaces. A script may only ever write its own device's scope — the child sends no scope id and the parent resolves it from the job. A whole namespace is dropped by `DELETE /api/plugins/:name/:version?deleteKv=1`, which is the only bulk delete in the product. **`plugin.data`** is a new operator-level permission covering the five `/api/plugins/:name/data/*` routes — list, write, delete, count, and a cross-device `scan` that answers one key over every device in a single left-joined, keyset-paged statement (`stableId` plus exactly five allowlisted device fields, secrets redacted). It exists because `kv.manage` is admin-only by deliberate design and stays so: `/api/kv/entry` can return a plaintext for *any* namespace, whereas on the plugin routes **the namespace is never supplied by the caller** — it is the `:name` path segment, there is no request shape that can name another, and the route refuses unless a plugin of that name is currently active or holds a dev slot. The boundary bought is between plugin data and the rest of the database, not between operators: an operator can already publish and run a script inside any plugin, which reaches the same data. KV answers *"what does device X have"* and cannot answer *"which devices have Y"* without a scan — the moment a plugin needs the second as a query, or ordering by value, or a join, that is the case for real relational storage. *(Extended again 2026-08-18: `GET /api/kv/namespaces` is the **index** — `{namespace, entries, secrets}` per scope, one `GROUP BY`, metadata only and never a key, value or hint. It exists because there was no way to enumerate namespaces at all, so Studio's KV panel was a search box with no directory and a farm holding five entries read as empty. **The whole storage model — the three axes `scope`/`namespace`/`key`, the `secret` flag and the narrow thing it actually guarantees, and which credential tables are deliberately not this one — is written up in `docs/feat/kv-storage.md`**, because an owner reading this section reasonably expected four separate stores and there was nowhere to find out otherwise.)*
- **`script_param_sets`** *(added in reconciliation, 2026-08-12, plan 95)* — a named, reusable set of script parameters ("Aggressive", "Conservative"), keyed on the script's **name** (never a `scripts.id`) and unique per `(scriptName, name)`: a saved set is standing intent about a script, the same "reference on the standing thing" shape §12.3 draws between `schedules.scriptRef` and `jobs.scriptId`, so it outlives the specific version it was written against and is reconciled against whichever version it is later applied to (dropped/reset/invalid/missing fields reported, never silently reshaped). Applying a set to the run dialog or a new schedule copies its `params` in at that moment; nothing downstream re-reads this table for that job or schedule afterward. REST, filed under the script name: `GET /api/scripts/:name/param-sets` (`script.view`), `POST /api/scripts/:name/param-sets` (`job.run`), `PATCH/DELETE /api/scripts/:name/param-sets/:id` (`job.run`).
- **`device_endpoints`** *(added directly by plan 88 §3.2/§4.3, 2026-08-12 — new product surface, documented in the same pass that shipped it, not a register entry)* — the address book that closes a real blind spot: adb has no memory of a TCP device's address once it disconnects, and until this table, neither did Enkaku, so a wired or wireless phone that came back on a new DHCP lease was unreachable by any code path in the repo. Keyed on `(stableId, address)` — `stableId` alone matching the keying rule this section already sets for `blocked_devices`/`discovered_devices` above, so a remembered address survives a serial change, a forget/re-admit cycle, and a move between transports. `address` is the exact `host:port` string adb uses as a serial for that transport, never re-derived; `medium` and `source` (`observed | declared | scanned`) record how the address was learned, and `conflictStableId` marks an address that answered as a *different* phone — never adopted here, only routed through the ordinary admission gate below. Bounded to `discovery.endpointsPerDevice` (default 4) rows per device by eviction inside the store, not a CHECK constraint, since the cap is a live setting, not a schema fact. `packages/core/src/registry/endpoints.ts`'s `EndpointStore` is the only code that touches this table; see §7.5 below for the reconnect ladder it feeds.
- **Device readiness** — a second state axis beside `DeviceStatus` (§12), `asleep|awake|hot`, with a blocked-reason enum (`offline|quarantined|hot_budget_full|locked|error`) that implies a fleet-wide "hot" resource budget. REST: `GET/PUT /api/devices/:id/readiness`; pushed live over WS as `device.readiness` (server) and set via `device.readiness.set` (client).
- **`GET /api/settings/device-schema`** exposes the `DeviceSettings` JSON Schema (§12) for the per-device settings form — the same schema-driven pattern as the registry (§8).
- **`job_nodes`** *(added directly by plan 99 §4.6, 2026-08-12/13 — new product surface, documented in the same pass that shipped its publish route, not a register entry)* — one row per **node execution** (not per node — a loop makes a workflow's step count exceed its node count) within a workflow job (§11.7). Modelled on `schedule_runs`' own "never a blank gap" rule (§12.3): status, attempts, the resolved `script@version` actually run, the node's capped output, and — for a gate — the resolved operands and the branch taken, so a workflow's history is answerable from the row alone. `artifacts.nodeId` (nullable) groups a node's own artifacts the same way, with no new artifact table. `GET /api/jobs/:id/nodes` (`job.view`, plan 99 §3.5/§4.9, step 99.8) reads it back as `{ items, finalized }` — one entry per row (nested `duration`/`attempts`/`output`, the last carrying its own `truncated`/`error`/`verdict` so a capped or failed node is distinguishable from a clean one), plus whether the PARENT job has settled (the same terminal check `resume` gates on). Never a 404 for "no nodes yet" — only a missing job is.
- **`job_resumes`** *(added directly by plan 99 §3.5, §4.9, 2026-08-13 — new product surface, documented in the same pass that shipped its route, not a register entry)* — one row per job created by `POST /api/jobs/:id/resume` (`job.run` plus the same device-ownership check `job.cancel` uses), keyed on the NEW job's own id: `resumedFromJobId`, `resumedFromNode`. A resume never mutates or restarts the original job — it enqueues a brand-new one for the SAME **resolved** `scriptId` the original ran (copied off the row verbatim, never re-resolved through `@latest`, so a pipeline resumed a week later runs the exact code it started with), refusing with `409` while the original job has not settled and `400` when the requested node never actually ran in it (a node a gate steered around does not count). `fromNode` may be omitted — the server defaults to the last node the job actually attempted, if it did not succeed; naming one explicitly always wins. Kept off `jobs` itself deliberately (a side table, not two more columns) so the change carries no cost for the many places in the tree that already build a `jobs` row by hand.
- **`device_numbers`** / **`sequences`** *(added directly by plan 89 §4.1/§4.2, step 89.1, 2026-08-13; wired into the protocol and the API by step 89.2, 2026-08-14 — new product surface, documented in the same pass that shipped it; plan 89's Phase B — the physical wallpaper/lock-screen label §4.4–§4.6 describe — landed 2026-08-14 too, see the "Physical labelling" paragraph above; only its own hardware-verification pass remains open)* — a short, human-facing number for every farm device, so an operator standing in front of 20–100 physically identical phones can tell them apart (§7.5's admission problem, one layer further: admission answers *whether* a phone joins the farm, this answers *which one it is on the rack*). `device_numbers` is keyed on `stableId`, not `devices.id` — the same keying rule §12's `blocked_devices`/`discovered_devices` and §12.4's `device_endpoints` already follow — so the number is a reservation that survives Forget, Block, unblock, and re-admission; it is released only by an explicit operator action, never automatically. `number` carries its own `UNIQUE` index, which is the actual duplicate-prevention guarantee, not the allocator's arithmetic. `sequences` is a one-row-per-name monotonic-counter table (`device_number` today) standing in for SQLite `AUTOINCREMENT`, which is unavailable here because `devices.id` is a text UUID rather than an `INTEGER PRIMARY KEY`. The number is allocated inside `admitDevice()`'s own transaction — the one place a `devices` row is born (§7.5) — never at the literal first adb connection, so a colleague's phone charging in the Discovered tray never burns a number. `packages/core/src/registry/device-number.ts` (`allocateDeviceNumber`, `setDeviceNumber`, `releaseDeviceNumber`, `compactDeviceNumbers`) is the only code that writes either table. `DeviceInfoSchema.number` (§7.5) is now populated on every production path that builds a `DeviceInfo` — the REST list (`GET /api/devices`, default-sorted by it), the single-device read, the topology map, an admitted device's own `device.added` broadcast, a script's `ctx.listDevices()`/`ctx.getDevice()`, and a cluster's device list — except a cloud-node-owned device (`tunnel/registry.ts`'s `syncDevices` creates that row directly, not through `admitDevice`, so no reservation is ever created for it; a pre-existing gap this step did not close). REST: `PATCH /api/devices/:id` (`number?: number`, `409 E_NUMBER_TAKEN` naming the holder), `POST /api/devices/numbers/compact` (now re-pushing every moved device's label in the same request, §7.5), `DELETE /api/devices/numbers/:stableId`. `devices.labelFingerprint`/`devices.labelState` (two more columns on `devices`, §12, plan 89 §4.1) hold the physical-label cache §7.5's "Physical labelling" paragraph describes — `labelState` is `DeviceLabelStateSchema` JSON (`@enkaku/protocol`), never trusted over a live `label.status`. Studio (step 89.3, done 2026-08-14) renders `number` on every list, tile, card, header, and picker surface — see §19's Dashboard and Device detail rows.
- **Assist / co-control** — the full shape (what it grants, what it explicitly does not, and its lifetime) is §10.5; the trust-model statement of its reach is §11.3's third actor. In brief: a non-lease-holder reaching into a device a job or another operator already controls, without taking it: five narrow input verbs (tap/swipe/gesture/key/text), gated by `device.assist` plus the farm's `coControl.mode`. Every accepted assist action is recorded as an `input`-stream `device_events` row and increments `jobs.assistCount`, the headline number on `GET /api/jobs`/`GET /api/jobs/:id`. `GET /api/jobs/:id/assists` (`job.view`, plan 91 §3.5/§4.9) answers the detail — who, when, and (in `meta`) exactly what — as an indexed range scan over `device_events` bounded by the job's own run window, `[]` for a job that never started. **Mirror** (controlling many devices at once) rides on the same grant mechanism rather than a new lock — §10.5's closing paragraph.

Everything above is intentionally terse; nothing here changes how the well-documented parts of this spec behave, and each item has a full write-up with file:line citations in the divergence register.

### 12.5 The command console — fleet commands, saved commands, and history *(added directly by plan 93 §3.3, §3.4, §3.9, §3.10, §4.2, step 93.2, 2026-08-13 — new product surface, documented in the same pass that shipped its schema; the runner, the REST surface, the WS events, saved commands, and `/console` have since all shipped — see the "Built as of" notes below; plan 93 step 93.11's Studio bulk-transfer surfaces (`BulkTransferDialog` and the download/archive routes) have not)*

The request this table set answers, in the owner's own words: *send an adb command to one device or all of them; save it; keep a history.* Three tables, plus one additive column on `batches`:

- **`command_runs`** — one fleet command: the text (`cmd`, redacted at write time by the same `redactShellCommand` pass `device_events` already uses — log hygiene, not a security control), the target as asked for (`{deviceIds} | {clusterId} | {tags}`, before resolution), who ran it and when, and a run-level status (`running | awaiting-continue | ok | failed | cancelled`) derived from its members' own statuses, never incremented directly — the same "cached projection, recomputed" shape `batches.status` above already uses. **A single-device terminal command is a run with exactly ONE member** — there is one history, not "terminal history" and "console history", and a command re-run from history does not care where it originally came from.
- **`command_run_members`** — one row per device the run actually targeted, keyed on `(runId, deviceId)`: `pending → running → ok | failed | skipped | cancelled`, exit code, duration, the retained stdout/stderr (capped, never an artifact — a fleet command is a survey, not a capture), and an output hash that groups identical results together in a report. `skipped` is a first-class outcome, not an absence: the device-lease check's own refusal code and message are stored **verbatim**, never paraphrased, so "another client is controlling this device" reads the same in history as it did on screen.
- **`saved_commands`** — a farm-scoped, owned command (name, description, the command text, an optional prefilled default target), on the same "team asset, not a personal bookmark" shape `clusters` and `scripts` already use: visible to everyone, editable and deletable by the owner or an admin, name unique per farm. Carries no `dangerous` flag — whether a command is high-consequence is derived fresh from its text by a shared guard at both render and run time, never cached, so an edited command cannot go stale against a stored boolean.

**Why three tables and not one.** A run is the *event* — what was asked, of whom, when. A member is the *per-device outcome* of that event — one event can have one member or a thousand. A saved command is *unrelated to either* — a reusable prompt that has run zero or many times, with no foreign key back to any particular run. Collapsing run and member into one table would mean a JSON array column standing in for what is properly a one-to-many relation, losing the ability to page and filter one device's outcome across many runs (`?deviceId=`) with an index instead of a table scan of every run's array.

**Why this is NOT `device_events`.** `device_events` (§18, §12 above) already records every shell command with its actor, cwd, exit code, byte count and duration — it is a fair question why a second history exists at all. The answer is that the two tables answer different questions, for different readers, with different retention. `device_events`' `input` stream is a short-lived (`retention.eventInputDays`, default **3 days**) audit trail, redacted, with no user dimension and no cross-device query — it exists so "what touched this device recently" is answerable per device. `command_runs`/`command_run_members` is the operator's own **14-day** (`retention.commandRunDays`), per-user, re-runnable record, capped at `shell.commandRunsPerUser` (default 500, oldest trimmed first on insert) and queryable *across* devices — it exists so "what did I run, on what, and what happened" is answerable without a live socket and without waiting on a 3-day window. A fleet command writes to **both**: the `device_events` audit row is unchanged — the console records through it exactly as the interactive terminal already does — and the run/member rows are the new, separate history sitting beside it. Folding one into the other was considered and rejected: raising a high-volume audit stream's retention tenfold to serve a low-volume feature is the wrong trade at exactly the wrong table. The full reasoning is plan 93 §3.3; the same sentence is carried into the schema's own table-doc comment (`packages/core/src/db/schema.ts`) so a future reader does not have to find this section to get the answer.

**`batches.skipped`** *(a plain additive JSON column on the existing `batches` table above, not a new table)* — every device that was in a batch's resolved target but never received a job row, with a reason (offline, quarantined, no longer exists). `createBatch` already computed this at dispatch time and previously discarded it into an audit `meta` field, so no Studio surface could ever say "17 of 20 ran — 3 were offline"; the column exists so that becomes representable. Closes a real defect (plan 93's finding F11): a batch could silently forget the devices it did not target.

Retention for all three tables follows `retention.commandRunDays` (`command_runs`/`command_run_members`, a cascading sweep — members are deleted with their run, never orphaned) and is **NOT gated by `retention.enabled`**, for the same reason `eventMainDays`/`eventInputDays` above are not: an unbounded, ever-growing command history is a disk-filling bug, not an opt-in convenience.

**Built as of step 93.4** (2026-08-13, in the same pass that shipped the runner's REST surface): the runner that actually dispatches a fleet command (`command-console/runner.ts`, step 93.3), the shared protocol shapes (`packages/protocol/src/command/target.ts`, `messages/command.ts`, step 93.4), `POST/GET/DELETE /api/command-runs` plus `.../cancel`, `.../continue`, `.../rerun`, `.../members/:deviceId/output` (`packages/core/src/api/command-runs.ts`, step 93.4), and the live `command.*` WS events, subscriber-scoped per §13's own entry (`command.subscribe`/`command.unsubscribe`, `ws-handlers.ts`'s `commandTargets(runId)`).

**Built as of step 93.6 (2026-08-13)**: saved-command CRUD — `GET/POST/PATCH/DELETE /api/saved-commands[/:id]` (`packages/core/src/api/saved-commands.ts` + `packages/core/src/command-console/saved.ts`) — the unique-name index, the `savedCommandLimit` cap, and owner-or-admin enforcement on edit/delete. `savedCommandRoutes` is mounted on `HttpDeps`/`daemon.ts` and reachable on a real boot (closed after step 93.6 itself, per `saved-commands-mount.test.ts`). **Built as of step 93.7**: `/console` (`packages/studio/src/app/console/page.tsx`, wired into the main nav) and its five components under `packages/studio/src/components/command/` — `TargetPicker` (device/cluster/tag targeting with a client-side admission preview), `RunReport` (outcome-first, grouped-by-identical-output results, a per-device output drawer, retry failed/skipped), `ConfirmFanout` (the high-consequence-plus-multi-device typed confirmation), `SavedCommands`, and `CommandHistory`.

### 12.6 The job trace — one event stream per run, and the frames that go with it *(added directly by plan 128 §3.1–§3.7, §4.1–§4.5, steps 128.1–128.7, 2026-08-26 — new product surface, documented in the same pass that shipped it, not a register entry)*

A job's history has always answered *whether* it failed and, since plan 60, *which phase*. It has never answered **what the phone was doing at the moment it went wrong** — the log says `find refused: not-found (sel={"text":"Post"})` and nothing about what was on the screen, so reconstructing the failure meant re-running the script on the same device and watching. This table set removes that loop.

- **`job_events`** — one append-only row per thing that happened during a job, on a single time axis: `kind` is `phase | action | log | artifact | progress | assist | error`, and one row carries `name` (the `DeviceCall` method for an action, the level for a log line, `start`/`end` for a phase), `durationMs`, `ok`, `errorCode`, a kind-specific `meta`, the `attempt` it belongs to (a rebound job has more than one), the `phase` it fell inside, plan 99's `nodeId` axis, and the content addresses of whatever was captured beside it (`frameHash`, `uiHash`) plus a `frameStatus` saying what happened if nothing was.

**`at_ms` is unix MILLISECONDS, and it is the only column in this schema that is.** Every other timestamp in the product is integer unix seconds (`docs/plans/00-overview.md` §4.2, and every `{ mode: 'timestamp' }` column in §12 above). A timeline cannot live in seconds: two taps 180 ms apart are the entire point of the table, and a seconds column would collapse them onto the same instant, making the scrubber and the film-strip meaningless. The carve-out is stated on the column itself, in `JobTraceEventSchema`, and in plan 128 §3.3, so it is not "fixed" back into line with its neighbours by a later reader who has only seen the convention.

**`seq` is what orders events; `at_ms` is what places them.** `seq` is a per-job monotonic integer assigned by the recorder — the single authority, seeded lazily from the highest `seq` already stored for that job, so an infra-retried job's second attempt continues the first's sequence rather than restarting at 1 and colliding on `uniqueIndex(job_id, seq)`. It is also **arrival order, not event order**: an `action` row is held until its screenshot settles while a `log` line emits immediately, so an action whose capture took 200 ms reaches the recorder after a log line that happened during it. That makes `seq` a correct keyset cursor and the wrong display axis — `GET /:id/trace` pages and orders by `seq`, and **every consumer sorts by `(at_ms, seq)` to render**. The skew is bounded by capture latency; it is local reordering, never a scrambled trace.

**Where the events come from: one tee, at the `device.call` boundary.** A job's child process never opens adb itself, so `@enkaku/session`'s local runner is the single place every action a script takes is visible, in order, with its arguments already Zod-parsed. The tee observes and never alters — `begin()`/`end()` are synchronous, neither throws, and every async consequence is started inside `end()` and never awaited by the call site. The script-facing API is byte-identical: `ScriptContext` gains nothing, no published bundle changes behaviour, and no setting has to be switched on. A **node-owned (cloud) job's action lane is therefore empty** — the tee lives in the local runner — while its phase, log and artifact events are recorded through the remote job bridge; the Timeline says so rather than showing a gap.

**The capture policy is derived from the inspector engine, never configured** (§7.9's inspector layer). `ui-server` talks JSON-RPC over an `adb forward` socket and never takes a slot in the per-device adb queue, so it can afford **a frame beside every action, with no sampling and no cap**; every other named engine (`uiautomator-dump` and anything added later) falls back to capturing **only on the failing action**, because its `screencap` runs through that queue and a background capture inserted between two script calls adds its full duration to the script's next one. With no inspector at all, nothing is captured. A UI-tree snapshot is stored for free wherever the call already produced one (`dump`, `find`, `waitFor`) and captured for the failing action. Captures are **bounded at four outstanding per job, dropped and never queued at that ceiling**. A single slot was the first design and was wrong: a script is quicker than a screenshot, so most actions recorded `skipped-busy` and no frame at all, defeating the one-action-one-frame rule. It is bounded rather than unlimited because on `ui-server` a screenshot travels the same on-device RPC channel as the script's own `find` and `click`, which uiautomator serves one call at a time — captures piling up there would put the script behind its own debugging. A saturated ceiling drops the frame but **never the free tree**: a `dump`/`find`/`waitFor` has already returned its tree, so it is stored anyway and the event is marked `meta.frameDropped: 'busy'`. Statuses stay honest — `skipped-busy` at the ceiling (never `skipped-policy`, which would claim the engine was never going to take a picture), `failed` when a capture throws or times out — so a trace never omits a frame silently, and no capture can fail a job. The number four is not measured on hardware. The resolved policy rides on every `phase` `start` event's `meta` (`inspectorEngineId`, `framePolicy`), per phase rather than per job, because the `ui-server` watchdog can declare the engine dead mid-run and the session fall back — so a job that failed in `prepare` with zero actions can still say why its action lane is empty.

**Arguments are stored, redacted.** `meta.args` carries the action's arguments — a `find` is useless without its selector — with `type` and `clipboard.set` reduced to `{ length: n }` (a script types passwords, and a script that knows better pastes them) and any single value over 512 bytes replaced by a truncation marker naming its size. Same rules `device_events`' input stream already applies.

- **Frames and UI trees live in one directory per job**, content-addressed by the SHA-256 of their own bytes: `<dataDir>/traces/<jobId>/<sha256>.png` and `<sha256>.json.gz`. Two actions on an unchanged screen write one file and produce two events both naming that hash — every action has its own screenshot, the bytes are stored once. Deliberately **not** `agent_blobs` (§12.1): that store's GC scans `agent_messages` and nothing else, so a trace frame parked there would be an orphan the moment it was written and would be swept once it cleared `retention.blobOrphanGraceHours` — every trace screenshot gone 24 hours later. The price of the separate home is that identical frames in two different jobs are stored twice; it is paid deliberately, in exchange for a lifetime rule that cannot be got wrong.

**REST** (`packages/core/src/api/jobs.ts`):

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/jobs/:id/trace` | `job.view` | A keyset page of the stream — `?after=` (or `?cursor=`) on `seq`, `?limit=`, `?kind=` repeatable. `[]` for a job that recorded nothing, never a 404; only a missing job 404s. |
| `GET` | `/api/jobs/:id/trace/frames/:hash` | `job.view` | `image/png`, `Cache-Control: private, immutable` — the URL names the content, so it can never go stale, but the content is a screenshot of somebody's phone and must never sit in a shared cache. 404 when the frame was never captured or has been swept. |
| `GET` | `/api/jobs/:id/trace/ui/:hash` | `job.view` | The UI tree, gunzipped and re-validated on the way out, so what Studio renders is the shape a live dump gives it. A truncated or unparseable snapshot is `E_TRACE_CORRUPT`, never a `null` that would read as "gone". |
| `DELETE` | `/api/jobs/:id` | `job.run` **plus** the per-job device-ownership check `POST /:id/cancel` already applies | The whole cascade below. `409 job_not_settled` while the job is `queued`/`running` — cancel it first, since deleting a job whose recorder is still flushing would race that flush. |
| `POST` | `/api/jobs/history/clear` | **`job.history.purge`** | Body `{ before?, deviceId?, status? }`, all optional and ANDed; no body means every settled job. Returns the same cascade counts plus `skipped` — matched jobs that were still queued or running and were left alone, reported rather than silently dropped. |

`:id` and `:hash` both arrive from a URL and both become path segments, so both are validated against their own pattern **before any path is built**, once, at the store that touches the filesystem — never sanitised after the fact and never a second, looser copy of the check in the route.

**`job.history.purge` is a new admin-level permission, deliberately outside the operator set**, on the same precedent `kv.manage` already carries. `DELETE /:id` keeps the looser per-job ownership gate — erasing one run must not be a stricter check than stopping it, and it is a run the operator can already see and cancel. `POST /history/clear` selects by **filter**, not by a device the caller owns: on `job.run` it would have let any operator erase every run on every device in the farm, including runs owned by someone else and the trace frames that are the only record of what they did. The asymmetry is the point. *(Decided, not asked — recorded in plan 128 §9 Q4 so the owner sees it as the ACL change it is; widening it later is a one-line change to the operator set plus its guard test.)*

**One cascade, three callers.** `deleteJobsWithHistory` (`packages/core/src/jobs/purge.ts`) deletes, in this order: the `job_events` rows, the `traces/<jobId>/` directory, every artifact **file** and then its `artifacts` rows, the `job_nodes` rows, and finally the `jobs` rows — files before the rows that name them, so a failure can at worst leave a row pointing at a file that is gone (already a 404 on the artifact routes) rather than orphaned bytes nothing in the database can find. `DELETE /api/jobs/:id`, `POST /api/jobs/history/clear` and device removal's `deleteHistory` all go through it rather than each deleting what it happens to remember — which is exactly how device removal came to delete artifact rows while leaving their files on disk.

**Retention: `retention.traceDays`, default 30, and NOT gated by `retention.enabled`** — the same distinction `eventMainDays`/`eventInputDays`/`commandRunDays` already draw (see §12.5's closing note and §18): an unbounded, append-only, one-row-per-device-call table with a screenshot beside each row is a disk-filling bug, not an opt-in convenience. The lifetime rule above is the *correctness* rule (a trace lives exactly as long as its job's history) but it is not a *bound* — nothing deletes finished jobs on its own except the device-removal cascade — so this second lever exists. **A trace is swept whole, per job, never per row**: the sweep groups by `job_id`, takes `MAX(at_ms)` as the trace's age, and deletes rows and directory together or neither. Ageing rows individually would strand a straddling job's surviving recent rows in front of a directory the same sweep had just deleted — a torn timeline with 404ing thumbnails, worse than keeping the whole thing a few hours longer.

---

## 13. The Core ⇄ Studio protocol

Message-based over WebSocket. Categories:

- **Device events**: `device.added`, `device.removed`, `device.status` (from `adb track-devices`, not polling).
- **Enrollment**: `device.unauthorized`, `device.pairing.request`, `device.pairing.code` (§15.1).
- **Control** (manual): `input.tap`, `input.swipe`, `input.key`, `input.text` → the core validates the lease and rejects while `busy`.
- **Video**: on a LAN, a stream of H.264 bytes (scrcpy) → the browser's WebCodecs `VideoDecoder`. In the cloud, WebRTC negotiation (§5.3).
- **Queue/job**: `job.enqueue`, `job.status`, `job.log`, `job.artifact`, `job.waiting` — a job that cannot be claimed yet says why: `{ jobId, deviceId, waiting, heldBy, remainingSec, reason }`, `reason` either `'quiet'` (the per-device quiet period between jobs) or `'paced'` (plan 94 §3.8, §4.9, step 94.6 — waiting on its own `jobs.notBefore`, the pacer's stagger or inter-repetition delay). `job.status` gains an optional `node` block for a workflow job (§11.7) — `{ id, seq, total, kind, script, status }`, absent for every non-workflow job — so a running pipeline's "node 2/4" is live, not only visible after settle. `job.progress` — a live, unpersisted snapshot pushed while a job runs (`ctx.progress()`); never stored, never validated, never readable after the job ends. **`job.trace`** *(plan 128 §4.2, step 128.5)* — the job trace's live tail (§12.6), `{ jobId, event }`, one message per `job_events` row, published as the recorder publishes it and **before** the row is written, so the Timeline feels instant and an unflushed batch lost to a hard crash costs a tick rather than a stall. The `/ws` contract is unchanged: still no snapshot replay, so the Timeline tab fetches `GET /api/jobs/:id/trace` and then subscribes, exactly as the Logs tab already does with `/logs` and `job.log`.
- **Registry/tools**: introspection plus tool operations.
- **Presence**: `hello`, `device.viewers` — who else is watching a device right now.
- **Device readiness**: `device.readiness` (push), `device.readiness.set` (client) — see §12.4.
- **Clipboard**: `clipboard.get`/`clipboard.set` (client), `clipboard.value`/`clipboard.ok` (server).
- **File transfer**: `transfer.progress`, `transfer.done` (server), `transfer.cancel` (client) — progress for the lease-scoped install/push/pull endpoints (§11.3). **Scoped to viewers of the device, never farm-wide** (F27, closed by plan 93 step 93.9): `daemon.ts`'s `transferBroadcast` calls a `broadcastTransferEvent` forward-ref, resolved once `attachWsRouter` runs, to `ws-handlers.ts`'s own `broadcastTransfer` — reusing the same `deviceTargets(deviceId)` presence set every other device-scoped push already fans out through, rather than `hub.broadcast`. **`GET /api/transfers`** (plan 107 §3.1, §3.4, §4, step 107.2) — a REST snapshot, not a WS message: install/push/pull mint a `transferId` and stream progress over the socket above, but until this endpoint existed nothing let a client that missed the start (a second tab, or the same tab after a reload) discover that one was running at all. Backed by an in-memory registry (`packages/core/src/device/transfer-registry.ts`), fed from the same `transferBroadcast` object as the WS events, not a database row — the smaller of the two options plan 107 §3.4 weighed, chosen because it needs no schema change and can be swapped for a durable `transfers` table later without changing this response shape or any client reading it. **What that costs, stated plainly: a core restart forgets every entry**, including a transfer whose `adb push`/`pm install` is still running on the phone — the endpoint answers "what is this process aware of right now," never "what has ever run." Returns `sent`/`total` as a point-in-time snapshot from the single poll, never a repeated push, so it does not reintroduce the per-chunk farm-wide broadcast F27 closed — a client still gets live byte-level progress only through the device-scoped `transfer.progress` channel above, using this endpoint only to learn which device(s)/transferId(s) to subscribe to.
- **The action recorder** (plan 94 §3.10, §4.9, step 94.3): `recording.start`/`.stop`/`.cancel` (client → core, gated by the same `checkInputAllowed` lease check `input.*` already uses) and `recording.state`/`recording.step` (core → client) — one active recording per device, held by the lease holder. `recording.state` carries `active`, `stepCount`, `startedAt`, and — when the recording ended on its own rather than by an explicit `recording.stop` — a `stoppedReason` (`max-steps` \| `max-duration` \| `lease-lost`). `recording.step` carries the new step's `kind` and whether it got a candidate selector.
- **Scheduling subsystem**: `batch.status`, `schedule.fired` — live pushes for the cron dispatcher described in §12.3, not §10's job-queue picker.
- **Notifications**: `notification.created` — the bell (§12.2).
- **AI agent chat**: `agent.run.*`, `agent.delta`, `agent.message*`, `agent.tool.*`, `agent.approval.*`, `agent.child.*` (server); `agent.subscribe`/`agent.unsubscribe`/`agent.run.cancel` (client) — the agent conversation protocol (§12.1).
- **Session startup progress**: `session.progress`, carrying a phase (`connecting|waking|starting-video|waiting-frame|ready`) before the first video frame arrives.
- **Liveness**: `heartbeat` (server, one-way) — a beat every 15s so the Studio client can tell an open-but-silent socket from an idle one and force a reconnect after missing three in a row (plan 85 §3.6).
- **adb server and discovery** (server): `scan.progress` — live counts (`scanned`/`total`/`answered`) while a bounded subnet sweep runs (§7.5); `adb.server.phase` — one push per phase of an adb drain/stop/start/reattach/reconcile cycle, shared by the version swap and the operator's Restart adb server action (§7.7, §10.4); `adb.health` — the "is adb stuck" verdict, broadcast only when its `status` transitions (`ok`/`degraded`/`stuck`), never on a timer.
- **The command console** (plan 93 §3.17, §4.3, step 93.4): `command.started`, `command.progress` (coalesced at most every 250ms, carrying only the deltas since the last tick), `command.output` (once per DISTINCT output hash, never once per device), `command.stage`, `command.finished` (server); `command.subscribe`/`command.unsubscribe` (client) — `POST /api/command-runs` is the only way to START a run, including for one device from the console; the socket carries events only, and a client must `GET` the run first (no snapshot replay). **Subscriber-scoped, deliberately unlike `transfer.progress`/`transfer.done` above (plan 93 §0 finding F27)**: a fleet command's output can contain anything a device printed, so `ws-handlers.ts`'s `commandTargets(runId)` fans these out only to connections that asked for that run, never every connected tab.

*(The nine bullets above added in reconciliation, 2026-08-09. Presence/readiness/clipboard/transfer/batch-status/schedule-fired follow the owner's general direction for the "remaining rows," not individually ratified; the AI agent chat protocol follows the owner's 2026-08-03 `ai_agents` decision; session-startup-progress was accepted as uncontroversial by the audit. DIV-044/045/046/047/049/050/051/052/072. The `heartbeat` bullet was added directly by plan 85 §85.9, 2026-08-09, describing new product surface in the same pass that shipped it — not a register entry. The adb-server-and-discovery bullet was added directly by plan 88 §4.6, 2026-08-12, describing new product surface in the same pass that shipped it — not a register entry. It lists three of the plan's four designed messages: `device.cutover` is not yet shipped, since the OTG cutover wizard it belongs to (§7.5) is still in progress.)*

REST handles ordinary request-response (script and tool CRUD). WebSocket handles streaming and realtime. The contract lives in `packages/protocol` (Zod), shared and type-safe.

---

## 14. Security and isolation

- **Server-authoritative**: leases, resource conflicts, and ACL live in the core.
- **Auth (REVISED in v0.2):**
  - Local single-user (the non-expert mode): may **auto-create an admin** and skip login for zero-config — BUT only when bound to `localhost`.
  - Server/cloud mode: login is **mandatory** (argon2 hashes), with session tokens. Sessions are their own table (`sessions`) — only the sha256 of the raw token is ever persisted, alongside `userId`, `expiresAt`, `lastUsedAt`, `userAgent`, and `ip` *(table name added in reconciliation, 2026-08-09, DIV-007 — accepted as uncontroversial by the audit)*. The node tunnel uses a token (the process was called an "agent" before plan 61 renamed it — see §4).
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
| Video FPS (Control) | ≥ 24 fps (may drop while idle) | **Manual control (device page) only** — `control` presets ship at 20–30 fps (`packages/session/src/video-profile.ts`'s `CONTROL_PRESETS`). Depends on the phone and Android version. |
| Video FPS (Wall) | ≥ 18 fps (`balanced`, the shipped default) | The Wall is a deliberately lower-fps, many-tiles view and is **not held to Control's floor** — it has its own target instead of an exemption (plan 100 step 100.8). Its presets ship 10–22 fps (`WALL_PRESETS`: `minimal` 10, `light` 14, `balanced` 18, `detailed` 22), deliberately kept below Control's 24 fps floor so the two views stay visibly distinct, while still reading as smooth motion at the small size a tile actually renders. **These numbers are themselves an interim raise, not a measured ceiling**: they were raised from plan 100 §3.4's own first-pass table (5–15 fps) once step 100.3 made a loopback/LAN wall's tile budget decode-bound rather than bandwidth-bound, so extra fps stopped costing live tiles — but no hardware decode-capacity measurement has been taken (plan 100 §7.3/H-1, procedure written out in that plan's step 100.7). Revisit this row once that ladder has run. |
| Inspector query (`ui-server`) | < 200 ms per find | versus 0.5–2 s for `uiautomator dump` |
| First-run provisioning | < 90 seconds | downloading adb, scrcpy, ui-server |
| Max devices per host (Intel N100, 4 GB) | 10–15 | I/O-bound; scrcpy encodes on the phone |
| Max devices per host (SBC, 1–2 GB) | 4–6 | adb-only edition, wireless ADB |
| Job overhead (spawn → prepare) | < 3 seconds | child process plus attaching ui-server |

Marketing angle: *"10 devices on a ~$150 mini-PC."*

---

## 17. Positioning and acceptable use (the QA framing)

> **Withdrawal note** *(2026-08-12, owner direction).* The second bullet below previously read "The acceptable-use policy is a product default, not just a document. Farm traffic instrumentation and tagging is on by default," and cited `docs/acceptable-use.md` §7 for the marker's exact boundary. That document (added `ecdc24a`, deliberately deleted `d184063`) was recreated by an MVP-readiness audit that misread its own absence as a gap; the owner has confirmed the original deletion was correct and ordered the document, and every reference to it, removed again — see §9.4's own withdrawal note for the fuller account. Enkaku states no acceptable-use position. The device marker itself is unaffected by any of this: it ships, defaults on, and is described below on its own terms.

- **The positioning is a QA / test-automation device farm** (BrowserStack-style), not "undetectable social media bots". The QA framing is safer legally and in ToS terms, the market is larger, and the customer is a developer testing *their own* app.
- **The device-under-automation marker is a product default, on by default.** §9.4's marker — a device-scoped system property, `packages/session/src/farm-tag.ts` — is **on by default** *(implemented in reconciliation, 2026-08-11, plan 87; it marks the device, never a packet, and is described precisely, not implied to be wire-level coverage)*. This is a disclosure a device makes about itself, not an acceptable-use policy (see the withdrawal note above). Timing jitter and UHID input are documented in the context of *test realism* (exercising the app's real path), not evasion.
- **Testing your own detectors**: instrumentation beats blind evasion. A farm ⇄ detector feedback loop (§9.4).
- **The network layer (§7.9) is a single operator-set route per device, and deliberately nothing more** *(corrected in reconciliation, 2026-08-11 — §17 previously said "per lease" and "lease-scoped", contradicting §7.9 rule 1's device-scoped revision; no `DIV-` row in `docs/spec-divergences.md` covers this contradiction)*. There is no proxy pool, no rotation, and no binding of a route to an account or persona — the absence of those abstractions is a design decision, not a missing feature. A route that is explicit, device-scoped, and written to the device event log serves every QA use case listed in §7.9; rotation serves only the goal of stopping a third-party platform from clustering accounts by network origin, which §17 places outside the product.
- **When sold**: default features are aimed at testing your own apps; the real-device advantage (§9.2) becomes a legitimate QA selling point.

---

## 18. Housekeeping and business plumbing (NEW in v0.2)

Things that will certainly happen and that often stall indie products:

- **Artifact retention and GC**: per-job screenshots and video pile up fast. This needs a policy: a per-device or global quota, a TTL, or a max size with LRU eviction. `artifacts.sizeBytes` is already in place.
- **Job trace retention** *(added directly by plan 128 §3.7, step 128.7, 2026-08-26)*: `retention.traceDays` (default **30**) bounds `job_events` and the `traces/<jobId>/` directories that go with it (§12.6). Unlike the artifact policy above and like `eventMainDays`/`eventInputDays`/`commandRunDays`, it is **not** gated by `retention.enabled` — a per-action event stream with a screenshot beside each row is a disk-filling bug when left unbounded, not an opt-in convenience. The sweep is per **job**, aged on that job's newest event, deleting rows and directory together or neither, so a long-running or rebound job's timeline is never half-swept. Content-hash dedupe cuts the common case hard (a script tapping through a static screen writes one file, not twenty); the tail is what this setting bounds. The 30-day default matches `maxAgeDays` and is **unverified against a real farm's disk** — plan 128 §8 R2 estimated 10–40 GB/day for a 200-device farm, and §9 Q3 asks for it to be revisited once a real usage figure has been observed.
- **Licensing and redistribution**: audit before selling — adb/platform-tools (Google's ToS), scrcpy (Apache-2.0 ✅), redroid, npm dependencies. Write a `LICENSES.md`.
- **Business plumbing (if selling seriously)**: docs and onboarding, licence keys and activation, opt-in telemetry, a support channel, an update channel. This is a real milestone (M7.5).
- **A cloud security boundary**: multi-tenancy needs isolation between customers plus a container or microVM per job (§11.3). Do not promise safe multi-tenancy before that exists.

---

## 19. Studio — screen spec

| Screen | Contents |
|---|---|
| **Dashboard** | *(amended, plan 92 §1, §3.10, §9 Q1; number added plan 89 §3.1, §3.3, §5 step 89.3; physical labelling's fleet action added plan 89 §3.7, §5 step 89.8)* **Opens on the Wall, unconditionally** — every device's screen live in a grid, at a low-rate quality profile — for every farm, with no setting anywhere (farm-wide or per-browser) that changes what a fresh session lands on. List is one click (or a `?view=list` link) away and is remembered for that browser tab only; a `?view=` query parameter always wins. A device grid (optional live thumbnails), status (idle/manual/busy/offline/quarantined), owner, **battery and temperature badges**. Every tile and list row leads with the device's short number (`#7`), rendered beside `label` — never concatenated into it — and the list defaults to sorting by number rather than label (`?sort=number|label`). *(amended, plan 124 §1, §3.2, §5, 2026-08-25 — this row and the Device detail row below claimed universal number rendering from plan 89 §5 step 89.3 onward; a sweep found the number reached four render sites out of roughly seventy, and plan 124 is the pass that made the claim true.)* It now holds across dialogs, toasts, bulk reports, the operations tray, the command console and **plugin UIs** — one formatter (`formatDeviceName`) and one component (`DeviceName`), both exported from `@enkaku/ui` so a plugin composes the name the same way the core screens do, defended by a mechanical check in `packages/studio/src/design-rules.test.ts`. This screen's own search box matches the number too (`7` and `#7` alike), alongside label, stableId, tag, adb serial and connection address. A **Renumber fleet…** overflow action compacts the numbering to `1..n` in list order. The multi-select toolbar gains **Apply labels**, applying whatever `labelling.mode` is already set on each selected device and reporting the result grouped by outcome (never a flattened "N failed") — *(amended, plan 124 §4.6)* a device whose mode is `off` is reported as **skipped** with that reason, never counted as a success, which is what it used to do and which made the button a silent no-op on a farm that had never opted in. Beside it, **Set number as wallpaper** (plan 124 §4.6) sets `labelling.mode` to `wallpaper` on every selected device and applies in one press, reporting `applied`/`partial`/`unavailable` grouped and never rounded up. The Discovered tray's admission dialog gains one **Label this phone's screen** switch, reflecting the farm's default and stated in full — that it writes to the phone and, on many Android versions, cannot read back the original wallpaper to restore later. Quick actions: control / run. `/topology` is a dead route kept only as a redirect into this screen's wall view grouped by cluster (`?view=wall&group=cluster`), for old bookmarks — it has no content of its own. |
| **Enrollment wizard** | Detects `unauthorized` and wireless pairing, visual instructions, pairing code input (§15.1). |
| **Device detail / live control** | Video stream plus click input, a driver selection panel (dropdowns, validated by capabilities and locks), **input mode choice uhid/sdk/aoa**, per-device settings (schema-driven), a prep button. While `busy`: input disabled, video still running, an "automation running" badge. The header title composes the device's short number with its name (`#7 Pixel 5`, plan 89 §3.3, §5 step 89.3) — the number itself is never baked into the label. The header also carries a **label state badge** (plan 89 §3.5, §5 step 89.8) — `Labelled`/`Stale`/`Partial — <reason>`/`Unavailable — <reason>`, renders nothing for `off`/`unknown` — never a single colour standing in for all four outcomes. Tabs: Control, Jobs, Monitor, Crashes, Terminal, Files, Network, **Agent**, Identity, Logs, Storage, Settings (Terminal/Files conditionally hidden per farm settings; Terminal and Monitor are the operator-facing shell and live streams described in §11.3). The **Agent** tab (`docs/plans/90-m55-unified-guest-agent.md` §5 step 90.6) is the guest agent's own lifecycle — state, version, capabilities grouped into the four §7.10 facets, and one primary action (Install/Retry/Update/Remove) — split out of Network, which keeps only a one-line summary linking there. Settings' General section gains a hand-authored **Number** field (not schema-driven — the number lives in its own `device_numbers` table, never on `DeviceSettingsSchema`) with inline collision feedback on a 409 and a **Release number** action. The device popup's **action list** gains one row, **Set number as wallpaper** (plan 124 §3.5, §3.6, §4.6, §5 step 124.6) — the one-press path that used to take six clicks through two nested dialogs: it PATCHes `labelling.mode` to `wallpaper` and calls `label/apply`, then reports the resulting state **verbatim** (`applied` succeeds, `partial` warns naming which surface took, `unavailable` errors naming the reason — never rounded up), and is disabled with a stated reason when the device has no number, is offline, or has no guest agent. Settings also gains a **Physical labelling** section (plan 89 §3.4–§3.6, §3.8, §5 step 89.8, `x-enkaku.group`-derived like every other section — spec §19's rendering principle): the schema-driven `mode`/`showName` controls, a CSS **content preview** explicitly captioned as a preview of the words and layout only (the real image is rendered on the device itself, by its own font — this workspace ships no font or rasteriser, §7.5), the live state badge, and **Re-apply label** / **Clear label** actions — Clear offers "Restore the original" only when the service reports it was actually captured, otherwise stating plainly that it resets to the system default. |
| **Scripts** | List, editor, versioning, enable/disable, run (parameter form generated from Zod), job history, publish button. |
| **Workflows** *(added directly, 2026-08-13, plan 99 §5 step 99.9; canvas view added plan 102 §5 step 102.6; canvas editing added plan 102 §5 step 102.4/102.5)* | List (grouped by name, node count, last run, New workflow); the list-editor (§11.7) — node rows with drag-reorder, a branch rail, a script+version picker, a bindings sub-form, the plain-language "starts from" line, `onFailure`, a workflow-parameter editor with Promote, and Validate. The list stays the default and the editor of record. A **List / Canvas** toggle (persisted per browser, `localStorage`) reveals a graph view — pan/zoom, backward `goto` jumps drawn distinctly, an `unreachable` badge on any node nothing reaches — laid out from the document itself (`next`/`onFailure`/`then`/`else`; the document stores no coordinates and no separate `edges` array, so layout is computed on open and never written back, and a node's position is never editable). Selecting a node on the canvas opens the *same* node editor the list uses, in a side panel beside the canvas — a scoped exception to this section's rendering principle below: the canvas is a second **view** of the one schema-driven form, not a second **implementation** of it. Dragging a connection from one node's handle onto another — or reconnecting or deleting an existing one — edits the SAME `next`/`onFailure`/`then`/`else` fields the list editor's own outcome pickers already write, never a separate edge list. |
| **Recordings** *(added directly, 2026-08-13, plan 94 §5 step 94.5)* | List (name, step count, recorded time, a status badge for published/detached/not-published/corrupt). The review panel (`?slug=…`, §11.8) — a screenshot, the gap in ms, and a candidate selector with its match count and anchor age per step; Promote (disabled unless the candidate is a unique match, naming the actual count in the disabled reason); trim/reorder/delete a step; parameterise a typed-text step, or revert one back to a literal; `speed`/`maxGapMs`/`cleanup` editing under the document's own compare-and-swap; Publish as script; and a one-way Detach. Every unparameterised typed-text step names, next to its value, that the literal is stored regardless of `logInputText` (§11.8). |
| **Job / run detail** | Status, realtime logs, artifacts (screenshots and video per step), result or error. *(amended, plan 97 §4.8, §11.9, 2026-08-13)* A script that declared a `result` renders it as values — through the same `x-enkaku` vocabulary and resolver `params` renders with, never a second one — with one of three banners above it (`invalid`: the paths that broke its own promise; `partial`: "this run failed — these are the values it had reached"; `oversize`: the byte count and `ctx.artifact.file` named as the fix) or none at all for `valid`/`undeclared`. A script that declared nothing still gets today's raw `<pre>`, unchanged. *(Amended, plan 128 §4.6, step 128.8, 2026-08-26.)* A **Timeline** tab renders the job trace (§12.6): a millisecond time axis with lanes — phase bands, one tick per device action (red where `ok === false`), log density, and a film-strip of captured frames at their true time positions — a scrubber that resolves to the frame and log window at that instant (`←`/`→` step one event, `Home`/`End` jump to the ends), and a detail panel per action showing its method, its **redacted** arguments, its duration, its outcome and error code, its before/after frames, and its UI tree rendered through the same `InspectorPanel` a live dump uses. Fetch-then-subscribe, so it renders for a running job as well as a finished one, and a failed job opens with the playhead already on the failing event. The resolved capture policy is stated in words (`Frames: per action (ui-server)` / `Frames: on failure only`) — an empty action lane, on a remote job or a fallback engine, is explained rather than left to read as a bug. The header gains **Delete job** (an `AlertDialog` confirm, matching `Cancel job`'s pattern) and the job list a **Clear history** action; both run the §12.6 cascade, and Clear history is admin-only (`job.history.purge`). |
| **Tools (Toolchain)** | Per tool: installed versions (with an active badge) plus available ones, install/update/activate/delete, progress, health check, manifest refresh. **scrcpy-server appears as "managed by core" (read-only).** |
| **Settings** | Four groups: Devices, Jobs, AI Agents (defaults, connectors, webhooks, spend — §12.1/§12.2), and Farm (blocked devices, KV store, users and ACL, audit log). Farm-wide defaults (driver, timing, default input mode) and retention policy live here too. *(Added, plan 92 §3.6, §4.1)* **Devices gains a Video group**: two quality profiles (device-page picture, wall-tile picture), each a named preset plus an Advanced reveal of the three underlying numbers (size/fps/bitrate), rendered entirely by the schema-driven form renderer — no bespoke slider or form component. It carries a live projection of the wall's tile budget as the draft changes, a measured readout of what the farm is actually spending right now, and an **Apply to live sessions** action that restarts only the sessions whose resolved numbers changed, skipping any device with a job running. The per-device Settings tab gets the same block for a device's own optional overrides. Backup is **not a Studio screen** — it is the `enkaku backup` CLI command (§18), because a correct backup must run against a stopped-or-quiescent core and hold `secrets.key` alongside the database, neither of which a browser button expresses well. |
| **AI agents** | Roster, approvals inbox, per-agent workbench (chat/config), run history (§12.1). |
| **Clusters, batches, schedules** | Cluster membership and preview; batch list and per-batch detail (member jobs, **Stop** — a dialog naming what happens to queued/running members and, for a paced batch, that no further repetition is planned — rerun-failed); schedule list, per-schedule detail (its **last run**, with the same Stop control and dialog) and run history, run-now (§12.3, plan 94 §3.9/§4.9 step 94.8). |
| **Plugins** *(amended, plan 108 §0.2, §3.10, §5 step 108.9, 2026-08-17)* | A failed-plugins-first list (verbatim error and code), dev-slot badges, rollback/reload/disable (§11.6). Four capabilities that existed on the server and had no way in are reachable here: **Install** (a dialog that names the plugin's title, description, and declared scripts and asks for an explicit confirmation before staging — a consent step, not a notice), **Disable**, **Drop dev slot**, and **Remove with its stored data** (the dialog reads `GET /api/plugins/:name/data/count` first and offers a checkbox stating the real entry count — "also delete this plugin's stored data (N global, M device entries)" — wired to `?deleteKv=1`; if the count cannot be read, the checkbox still renders and says so, rather than hiding the only way to delete the data). |
| **Plugin view** *(added directly, plan 108 §3.5, §4.4, §5 steps 108.7/108.8/108.10, 2026-08-17; the tier-B half amended by plan 111 §3.6, same day)* | The one page every plugin-declared screen renders through: `/plugins/view?name=<plugin>&view=<viewId>` — a query parameter, not a dynamic route segment, the same static-export precedent `/device?id=…` set, nested under the existing `/plugins` so it owes no nav entry of its own. Tier A renders the declared table through Studio's own `Table`, each column planned by `planField`/`formatValue`, with a toolbar and row actions running through `ActionRunner` (confirm → `SchemaForm` → POST → toast → refresh) and the declared empty state; tier C mounts the React component the plugin shipped into this page's own tree, behind an error boundary that turns a component that throws into a named error rather than a blank page (§11.6). Loading, empty, and error are all real states: a plugin disabled while its view is open renders an error **naming the plugin**, never an empty table. The sidebar carries plugin entries in their **own labelled group below the static nav** — so installing or removing a plugin never moves Jobs or Devices to a different place — read from `GET /api/plugins/ui` alongside the failed-plugin count `AppShell` already fetches; a dev-slot entry carries a `DEV` chip, an unrecognised icon name falls back rather than throwing, a failed read leaves the static nav untouched and adds no group, and collapsed the entry is an icon with a tooltip. |
| **Workspace** | A file tree plus editor over the AI agent's virtual filesystem (`workspace_files`, §12.2), compare-and-swap saves. *(Amended, plan 115 §4.4, 2026-08-18.)* **Upload** (a multipart `POST /api/workspace/file`, real sizes rendered through the byte formatter) and per-file **Rename** (using the row's own content hash as the compare-and-swap token) join the page's existing create, edit and delete. *(Amended, plan 116 §3.2, §3.3, §4.2, 2026-08-18.)* A file opens through a **presenter** chosen from its content type: text views and edits; image and video view only (each streamed from a real `GET /api/workspace/file`, with `Range` support so video seeks), stating why editing is unavailable rather than leaving an unexplained missing Save button — view-only is a declared capability, not an omission. A type with no presenter is named, sized and offered as a download rather than left blank, and each presenter's own size ceiling falls back to the same metadata-and-download treatment for a file too large to open here. |

The rendering principle: every config panel is rendered from a schema through the schema-driven form renderer — no hardcoded UI per component.

*(This section's rows corrected and added in reconciliation, 2026-08-09. Device detail's tab list and the Settings row's factual correction: accepted as uncontroversial, DIV-060; the Settings row's "DB backup and restore" claim was first removed as a deliberate withdrawal (DIV-059), then **corrected again on 2026-08-11**: the withdrawal's reasoning — that a SQLite backup is "copying one file" — was disproven by this codebase's unconditional WAL mode plus a separate `secrets.key`, so `enkaku backup` was built and the row now describes it. The record of both turns is in `docs/spec-divergences.md`; the Settings row's overall grouping follows the owner's general direction for the "remaining rows," not individually ratified, DIV-058; AI agents follows the owner's 2026-08-03 `ai_agents` decision, DIV-053; Clusters/batches/schedules follows the owner's 2026-08-09 Cluster B ruling, DIV-054; Plugins and Workspace follow the owner's general direction, not individually ratified, DIV-056/DIV-057; the Dashboard row's topology footnote is accepted as uncontroversial, DIV-062.)*

---

## 20. Roadmap / milestones

> **Replaced in reconciliation, 2026-08-09 (Plan 84 §4.5, mandatory).** This section used to carry its own milestone table, running to roughly M8/M9. That table is gone — not amended, replaced — because two competing roadmaps is exactly how this document drifted from the shipped product in the first place (see `docs/spec-divergences.md`'s 72-row account of the result). **The roadmap now lives in one place only: `docs/plans/00-overview.md`**, which indexes every milestone plan (M0 through the current one, past M40 as of this reconciliation) and is kept current as plans land, in a way a static table in this document cannot be. If this section and `docs/plans/00-overview.md` ever disagree about what milestone the project is on, `00-overview.md` is authoritative.
>
> The early milestone shape (M0 Foundations → M1 Toolchain → M2 Basic control → M3 Session/lease/queue → M4 Script framework → M4.5 ui-server → M5 Studio complete → M6 scrcpy → M7 Multi-user/packaging → M7.5 Business plumbing → M8 Cloud/extra drivers) is preserved here only as history: it explains the ordering logic referenced elsewhere in this document (**M3 before M4** — get queue and lease right with a fake job before debugging queue and automation together; **M4.5 and the M6 input work** — inspector speed and input realism are this product's two main axes of differentiation). It is not a live plan of record.

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
