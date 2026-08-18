# Enkaku — Codebase Overview

> **Read this first.** One document, written to answer four questions in order: *what is this product*, *how is it put together*, *how does it actually work at runtime*, and *where in the tree does each part live*. It is an as-built map of `main`, not a plan.
>
> It deliberately does **not** replace the three documents it points at:
>
> | Document | What it is | When you need it |
> |---|---|---|
> | [`docs/spec.md`](spec.md) | The product spec, **single source of truth**. If code and spec disagree, the spec wins. | Deciding what something *should* do. |
> | [`docs/plans/00-overview.md`](plans/00-overview.md) | Immutable stack decisions (§3), repo/TS/API/test conventions (§4), Definition of Done (§7), and the index of all ~116 milestone plans. | Before touching any plan, or asking "why is it like this". |
> | [`CLAUDE.md`](../CLAUDE.md) | The rules that get broken when you don't know them. | Before your first commit. |
>
> Other deep dives: [`docs/design.md`](design.md) (design system), [`docs/feat/`](feat/) (as-built subsystem analyses), [`docs/guide/`](guide/) (user-facing guides), [`docs/spec-divergences.md`](spec-divergences.md) (where code and spec knowingly differ).

---

## 1. What Enkaku is

**Enkaku** (遠隔 — "remote, at a distance"; repo codename `openpf`) is a **self-hosted Android device farm platform**. It turns a pile of physical Android phones into a fleet you can:

1. **See and touch from a browser** — live H.264 video with low-latency input, one device or a whole wall of them at once.
2. **Automate** — type-safe TypeScript scripts that run on their own, in a per-device queue, under a lease, with logs, artifacts and a declared result contract.
3. **Operate** — enrollment, health, battery/thermal, toolchain provisioning, ACLs, audit, scheduling, batching, notifications.

The governing product promise is **install → run → it works**: no manual `adb` install, no PATH surgery, no terminal knowledge. The core downloads and sha256-verifies its own toolchain on first boot (~15 s) into an app-local directory; the system `adb` on `PATH` is never used.

**Two audiences** (spec §1): an internal team that needs many real devices under one pane of glass, and a sellable QA/test-automation farm — a self-hostable, cheap BrowserStack.

**Why it exists** (spec §6): STF/DeviceFarmer is an ageing architecture effectively capped around Android 9; `ws-scrcpy-web` is *mirroring only* — no lease, no queue, no script framework, no multi-user. Nobody had combined modern remote control + orchestration + automation into one zero-config package.

### 1.1 Design principles (non-negotiable, spec §2)

| Principle | Concretely |
|---|---|
| **Zero-config** | First run provisions every tool, detects devices, opens the browser. No mandatory manual step. |
| **Self-contained** | Never depends on tools already on the host. Everything is downloaded into the app data dir. |
| **Schema-driven UI** | Every component describes its config as a schema; Studio *renders* the panel from it. A new component gets a settings UI with no new UI code. |
| **Server-authoritative** | Leases, conflicts, ACL are enforced in the core. The client is never trusted. |
| **Pluggable** | Transport, display, input, inspection and network are independent layers — except pairs that are genuinely coupled (the scrcpy rule, §5.4). |
| **Portable runtime** | One daemon, running on macOS, Linux x64/arm64, Windows, in a container, or on an SBC. |

### 1.2 Scale of the codebase

| Metric | Value |
|---|---|
| TypeScript / TSX files (excl. `node_modules`, build output) | ~1,480 |
| Colocated `*.test.ts(x)` files | ~575 |
| Lines of TS/TSX | ~344,000 |
| Workspace packages | 13 `packages/` + 2 `apps/` + 3 `plugins/` + `examples` |
| SQLite tables | 46 |
| Drizzle migrations | 61 |
| Milestone plans | 116 documents (M0 → M81) |

Runtime and package manager: **Bun** (not Node/npm). Tests: `bun test`, colocated in `src/`.

---

## 2. Mental model — the ten nouns

Everything below is built out of these. Learn them and the rest of the codebase reads itself.

| Noun | One sentence |
|---|---|
| **Device** | A physical (or redroid) Android phone, identified by a **`stableId`** (`ro.serialno` → ANDROID_ID fallback). The adb serial is only a transport address and may change. |
| **Session** | A live attachment to a device: adb transport open, video streaming, input engine ready. A device may hold **two** session entries — one `wall` (low-rate tile) and one `control` — so opening a device never tears down its tile. |
| **Lease** | The exclusive right to *drive* a device, held by exactly one client or one job, heartbeated, reaped when it expires. |
| **Co-control grant (Assist)** | A second, much narrower authorisation keyed `(deviceId, clientId)` that admits **five input verbs and nothing else** into a device someone else already holds. Never changes device status, never a takeover. |
| **Job** | One unit of queued work bound to one device: `queued → running → success \| failed \| cancelled \| expired`. |
| **Script** | A `run()` (plus optional `prepare()`/`finish()`) with a Zod `params` schema and an optional declared `result` schema. |
| **Plugin** | The **only** publishable unit — one TypeScript project bundling N scripts, optionally a long-lived **service**, optionally a Studio **surface** (screens). |
| **Workflow** | A `scripts` row of `kind: 'workflow'` whose bundle is a JSON graph of script nodes and gates, run as **one job under one lease**. |
| **Capability** | A registered, schema-typed operation (`device.tap`, `fs.read`, `job.run`, …) — the single vocabulary that AI agents, MCP clients and plugin services all act through. |
| **Node** | A cloud-mode mini-core running next to the phones, dialling an outbound WebSocket tunnel to the control plane. |

Two vocabulary traps worth knowing on day one:

- **"plugin" means two unrelated things.** `definePlugin` (`@enkaku/sdk`, public, authored by users) is the subject of most of this document. `defineAgentPlugin` (`packages/core/src/agent/plugins/`, core-internal) merely groups the AI agent's built-in capabilities into system-prompt sections. They never meet, and they have deliberately *opposite* failure policies — the agent registry throws at boot on a duplicate id; the plugin runtime **never throws because a user plugin is broken**.
- **"agent" means three things.** The **cloud node** (called "agent" until plan 61 renamed it), the **AI agent** (`ai_agents`), and the **guest agent** (the on-device Kotlin APK). The package on disk is `packages/node`; `apps/guest-agent` is the APK; `ai_agents` is the LLM feature.

Two words this project refuses:

- **"Sandbox."** Job isolation is **crash containment**, not a security boundary. A script runs in a child process so a crash cannot take the core down — it is *not* prevented from touching the host. Plugin services run **in the core's own process** and can `import('node:fs')`. What `ctx.farm` narrows is only what a plugin reaches *through the context*.
- **"Verified."** A network route advertising a `probe` capability is not the same as one that passed it. `deriveHealth` reports `unverified` until an egress check actually passes, and `unverified` is never worded as success.

---

## 3. Architecture at a glance

Three artifacts, one message contract:

- **Core** — the Bun + Hono daemon. Device registry, drivers, session/lease/queue, script runner, toolchain manager, plugin runtime, AI agent runtime, REST + WebSocket. It must run **near the devices** (USB or LAN).
- **Studio** — the Next.js web UI (static export). Served by the core itself on the same origin, or hosted in the cloud.
- **SDK** — `@enkaku/sdk`. `definePlugin`, `defineService`, `defineRecording`, the typed `ScriptContext`, and the `enkaku init | publish | dev` CLI.

```
                         ┌──────────────────────────────────────────┐
   browser               │            Studio (Next.js)              │
   ───────               │  wall · device popup · scripts · jobs    │
                         │  workflows · plugins · agents · settings │
                         └───────┬───────────────────────┬──────────┘
                        REST /api│                 WS /ws│ (JSON + binary frames)
                                 ▼                       ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │                          CORE  (Bun + Hono)                             │
   │                                                                         │
   │  registry ── admission ── discovery ── identity ── preparation          │
   │  session manager ── lease manager ── co-control ── mirror groups        │
   │  queue/scheduler ── job executors ── artifact store                     │
   │  script registry ── plugin runtime ── workflow executor ── recordings   │
   │  capability registry ── AI agent runner ── harness ── MCP server        │
   │  toolchain manager ── KV store ── workspace store ── secrets            │
   │  auth/ACL/audit ── notifications ── webhooks ── telemetry ── doctor     │
   │                                                                         │
   │  SQLite (Drizzle, WAL)  ·  artifacts/  ·  workspace-content/  ·  tools/ │
   └───────┬─────────────────────────┬───────────────────────┬───────────────┘
    drivers│                  adb    │                tunnel │ (cloud only)
           ▼                         ▼                       ▼
   ┌───────────────┐        ┌────────────────┐      ┌──────────────────┐
   │ scrcpy-server │        │  adb server    │      │  node (mini-core)│
   │ ui-server APK │◄──USB/─┤  :5037         │      │  outbound WS     │
   │ guest agent   │   TCP  └────────────────┘      └──────────────────┘
   └───────────────┘
      on-device
```

**Core ⇄ Studio is message-based over WebSocket, not REST-first** — deliberately, so the transport can move to a relay/tunnel model for cloud without changing the message contract. REST exists alongside it for CRUD and for anything a script or external tool needs.

### 3.1 Deployment modes (spec §5)

| Mode | Core runs | Devices | Video transport | For |
|---|---|---|---|---|
| **Local self-host** | The user's machine (one compiled binary, double-click) | Local USB/WiFi | WS + WebCodecs | Solo devs, non-experts |
| **Headless server** | A mini-PC / SBC / VM as a systemd service or Docker | Local USB/WiFi | WS + WebCodecs | An office with ~10 devices |
| **Cloud split** | Control plane in the cloud + a **node** next to the phones | Local, tunnelled | **WebRTC** | SaaS |
| **Cloud devices** | Cloud | redroid containers | WebRTC | Throughput testing without hardware |

The key constraint: the core must be near the devices; only the *control plane* can move.

**Why WebRTC for cloud, not WS.** WebSocket is TCP — on the internet one lost packet triggers head-of-line blocking and the whole picture freezes until the retransmit lands. The relay therefore terminates WebRTC and repackages scrcpy's H.264 as RTP (`packages/core/src/relay/`). LANs stay on WS + WebCodecs, which is simpler and needs no STUN/TURN.

---

## 4. Repository map

```
openpf/
├── packages/
│   ├── protocol/      Zod schemas for EVERYTHING at a boundary. WS envelope + messages,
│   │                  REST bodies, driver types, binary framing, settings, workflows,
│   │                  recordings, plugin surface/service, tunnel protocol.
│   ├── adb/           adb smartsocket client, `track-devices`, per-device queue,
│   │                  scaling global semaphore, timeouts, shell framing.
│   ├── toolchain/     Tool provisioning: manifest, download with MANDATORY sha256,
│   │                  version dirs, `active` pointer, health, platform detection.
│   ├── scrcpy/        Version-LOCKED scrcpy protocol client: H.264 demuxer, control
│   │                  messages, absolute HID pointer. Never fork the Java side.
│   ├── drivers/       The five engine layers (transport/display/input/inspector/network)
│   │                  plus `descriptors.ts` — the registry Studio renders from.
│   ├── session/       Everything that happens once a device is attached: session,
│   │                  wake, orientation, input arbiter, text-input ladder, reset,
│   │                  video profile, and the JOB RUNNER (child spawn, IPC, kv/jobs clients).
│   ├── core/          The daemon. See §5.
│   ├── studio/        The Next.js UI (static export, `output: 'export'`).
│   ├── ui/            `@enkaku/ui` — 30 shared components + `theme.css`, the ONE
│   │                  definition of the design tokens. Read by Studio AND by plugins.
│   ├── harness/       The AI agent loop: VFS, file tools, compaction, resilience,
│   │                  session/message stores, streaming runtime.
│   ├── node/          The cloud mini-core: enrollment + outbound tunnel + adb relay.
│   ├── sdk/           `@enkaku/sdk` — definePlugin/defineService/defineRecording,
│   │                  the typed context, and the `enkaku` CLI.
│   └── probe-server/  The self-hosted egress/geo/DNS probe endpoint.
├── apps/
│   ├── desktop/       Tauri shell (Rust): native window, tray, core as a child process.
│   └── guest-agent/   The on-device APK (Kotlin): control channel, SOCKS5 full tunnel
│                      (vendored hev-socks5-tunnel), IME, mock location, screen labelling.
├── plugins/           First-party packs: networking, proxy-manager, tiktok-automation-pack.
├── examples/          Example automation scripts (a script author's project, mirrored).
├── scripts/           Build, release, typecheck, spec-check, device smoke test, benches.
├── deploy/            systemd unit + coturn config.
└── docs/              spec, plans, design, guides, feature deep-dives, research.
```

### 4.1 Two TypeScripts, on purpose

The root uses **TypeScript 7** with `tsconfig.base.json` (bun types, `verbatimModuleSyntax`). `packages/studio` is deliberately standalone on **TypeScript 5** with a tsconfig that does *not* extend the base — Next needs the TS 5 compiler API. **Do not unify them.**

### 4.2 Import rules

- Cross-package imports always go through the package name (`@enkaku/...`), never a relative path across packages.
- WS message types and string constants come **only** from `@enkaku/protocol`. Never hardcode a message type elsewhere.
- External input (WS, HTTP bodies, JSON DB columns, config files) is validated through **Zod 4**. Never `as`-cast at a boundary.

---

## 5. The core daemon

`packages/core/src/daemon.ts` (~4,100 lines) is the composition root: it constructs every subsystem, wires their dependencies explicitly, mounts the HTTP routes and starts the Bun server. `server/http.ts` is the route table; `server/ws.ts` + `ws-handlers*.ts` are the WebSocket side.

### 5.1 Subsystem directory map

| Directory | Owns |
|---|---|
| `registry/` | Device registry, admission, discovery reconcile, reconnect, sweep, cutover, tags, short numbers, engine descriptors |
| `device/` | Health, battery/thermal, readiness, preparation, labelling, crash watcher/parser, monitors, shell sessions, transfers, adb metrics/scaling, host adb |
| `session/` | Adapters onto `@enkaku/session`'s manager |
| `lease/` | `lease-manager.ts` + `co-control.ts` (Assist grants) |
| `mirror/` | Mirror groups — one operator driving many devices |
| `queue/` | `scheduler.ts` (the per-device claim), `job-store.ts`, expiry, the claim-race worker |
| `jobs/` | Executors (`script`, `workflow`, `install`, `push`, `pull`, `sleep`, `remote`), failure classification, log buffer, result store, triggers |
| `scripts/` | Script registry (the merge point), ref resolution, server-side build, bundle cache, param sets, routes |
| `plugins/` | Plugin runtime (stage/verify/activate/rollback/disable/reload), dev slots, runtime host, service routes/sockets/webhooks, farm broker, surface registry, asset store, embedded pack seeding |
| `recording/` | Action recorder: session, anchors, compile-to-script |
| `capability/` | The capability registry and its ~50 declared operations, plus the invoke path |
| `agent/` | AI agents: store, runner, providers, threads, runs, approvals, blobs, the run tree, connectors |
| `mcp/` | The MCP server endpoint (`POST /mcp`) |
| `clusters/` | Cluster membership/resolve, batch dispatch, the **pacer**, status recompute |
| `schedules/` | Cron parsing + the schedule runner |
| `command-console/` | Fleet shell commands, saved commands, run history |
| `network/` | Route service, route checks, credential store, reverse-proxy registry |
| `tunnel/` | Cloud: node auth, registry, router, RPC, remote sessions, adb-remote, device proxy, channel allocator |
| `relay/` | WebRTC: peer, RTP/H.264 packetiser, ICE credentials |
| `tools/` | Toolchain store, provisioning, the adb swap, and `adb-server-control.ts` |
| `auth/` | Service, routes, middleware, ACL, audit |
| `kv/` | The durable KV store + the runner-side port |
| `workspace/` | The virtual filesystem store and its content drivers |
| `secrets/` | AES-256-GCM encrypted credential storage |
| `settings/` | The single-row farm settings store |
| `doctor/` | Environment checks: toolchain integrity, adb reachability, egress |
| `backup/`, `maintenance/`, `licensing/`, `telemetry/`, `notify/`, `events/`, `identity/`, `enroll/`, `util/` | Exactly what they say |

### 5.2 Boot sequence (what happens on `bun run dev`)

1. `loadConfig()` — **env > file > default**. An invalid config **fails the boot** (`E_BAD_CONFIG`) and must never silently fall back.
2. `resolveAuthMode()` — derived from the bind address. Non-loopback ⇒ **server mode** ⇒ TLS required unless `ENKAKU_ALLOW_INSECURE=1`. `assertTlsPolicy()` enforces it.
3. Data dir resolve + exclusive `enkaku.lock`.
4. SQLite open (WAL), Drizzle migrations applied from the embedded migration set.
5. `buildCoreCapabilityRegistry()` — a duplicate capability id or an unconvertible schema **throws and the process does not start**.
6. Toolchain provisioning — adb, `ui-server`, `ui-server-test`, `scrcpy-server` downloaded and sha256-verified if missing (`adb` is the only *critical* one).
7. Embedded plugin packs seeded (staged, never auto-activated).
8. Plugin runtime loads enabled plugins; services start.
9. adb `track-devices` starts; the reconcile sweep begins.
10. HTTP + WS server binds; Studio is served from the embedded static export; the browser opens unless `ENKAKU_NO_OPEN`.

### 5.3 Data directory

```
<dataDir>/
  enkaku.db  enkaku.db-wal  enkaku.db-shm   SQLite (WAL mode, always)
  secrets.key                               AES-256-GCM master key — NOT in the DB
  network-credentials.key                   proxy credential key
  enkaku.lock                               single-instance guard
  tools/<toolId>/<version>/…  + active      the provisioned toolchain
  artifacts/<job-id>/…                      screenshots, logs, files a job produced
  workspace-content/<xx>/<sha256>           non-inline workspace file bytes (content-addressed)
  plugins/                                  staged/activated plugin packages
  cache/  logs/
```

Locations: macOS `~/Library/Application Support/Enkaku`, Windows `%APPDATA%\Enkaku`, Linux `~/.local/share/enkaku` (service: `/var/lib/enkaku`), overridable with `ENKAKU_DATA_DIR` (dev uses `.dev-data/`).

> **Backup caveat, worth stating loudly.** `enkaku backup` archives the database **and** `secrets.key`. It does **not** archive `workspace-content/`. Restoring only the database leaves non-inline workspace rows pointing at bytes the restore did not bring back.

---

## 6. Devices

### 6.1 Identity — `stableId`, not the serial

A device is identified by `stableId` (`ro.serialno`, falling back to ANDROID_ID). The adb serial (`ABC123` or `10.20.0.37:5555`) is **only a transport address**: it changes when a phone moves from USB to WiFi, and two different transports can address the same phone. Everything durable — jobs, KV device scope, tags, numbers, events — keys on `stableId`.

Devices also carry a **short number** (`#7`) in its own `device_numbers` table, rendered *beside* the label and never concatenated into it, with a fleet-wide "renumber" compaction.

### 6.2 Lifecycle

```
discovered ──admit──▶ registered ──▶ offline ⇄ idle ⇄ { manual | busy }
     │                                              └─ quarantined (e.g. too hot)
     └──block──▶ blocked_devices
```

- **`discovered_devices`** — seen by adb but not admitted. Studio shows a tray; admission is an explicit dialog (it can also apply a screen label).
- **`blocked_devices`** — explicitly refused; never re-offered.
- **`deleted_devices`** — forgotten, with their device-scoped KV deleted in the same transaction.
- **`manual` and `busy` are mutually exclusive.** While `busy`, control messages are **rejected by the core**, not merely disabled in the UI — the one exception being a co-control grant (§7.2). Video keeps running throughout.
- **Quarantine** — the battery monitor polls temperature (`battery.pollIntervalSec`, default 60 s) and pulls a device over `tempThresholdC` (default 45 °C) out of the queue, so job results stay trustworthy.

Discovery is **reconciled, not merely event-driven**: a periodic pass (`discovery.scanIntervalSec`, default 10 s) recovers devices the live `track-devices` stream missed, with an offline grace and a recovery cooldown.

### 6.3 Preparation — a visible, resumable state machine

On-device components (guest agent APK, ui-server APK, …) are provisioned through a **per-component registry** (`device/preparation/`) so each one has its own named state, its own failure reason, and its own retry — surfaced in the device popup. Deliberately **not a gate**: a phone with one failed component still streams and still runs work that does not need it.

### 6.4 The five driver layers

The driver subsystem has **five** layers, not four (spec §7.9). Engines declare capabilities and *locks* so incompatible pairs cannot be selected together; `packages/drivers/src/descriptors.ts` is the registry Studio renders its dropdowns from.

| Layer | Engines | Notes |
|---|---|---|
| **transport** | `adb-usb`, `adb-tcp` | adb over cable or over the network. `adb-tcp` deliberately does **not** claim "wireless" — adb cannot tell a switch port from a radio. |
| **display** | `scrcpy` (H.264, low latency), `screencap-loop` (~2–3 fps fallback) | The screencap fallback is retried, not permanent, and is reported live. |
| **input** | `scrcpy-uhid` (hardware-like, wireless-friendly), `scrcpy-sdk` (InputManager, broad compat), `scrcpy-aoa`, `adb-input` (fallback) | |
| **inspector** | `ui-server` (persistent on-device server, target <200 ms per find), `uiautomator-dump` (restarts UiAutomation per query — slower fallback), `appium` | The persistent-server pattern is borrowed from uiautomator2. |
| **network** *(optional)* | `none` (default), `adb-proxy`, `adb-reverse-proxy`, `vpn-helper` | See §11. |

**The scrcpy rule (spec §7.6, immutable).** Enkaku uses Genymobile's **vanilla** `scrcpy-server.jar`, unmodified, with the host multiplexing its TCP sockets into one WebSocket and the browser demuxing/decoding. The consequence is that `packages/scrcpy` (the protocol client) is ours to maintain and is **version-locked to the core**: `packages/scrcpy/src/version.ts` is the only source of that version, scrcpy-server shows in the Tools page as "managed by core" (read-only), and **the Java side is never forked**.

### 6.5 The guest agent (`apps/guest-agent`)

A first-party Kotlin APK the core installs onto a farm device. It exposes a `localabstract` control channel over adb and serves four facets:

- **route** — a SOCKS5 **full tunnel** (`RouteVpnService` + vendored `hev-socks5-tunnel`), with an IPv6 leak guard, a dead-man's switch, and a real egress probe *through* the tunnel. This is the only network engine an app under test cannot bypass.
- **input** — `EnkakuIme`, a farm IME that makes unicode text entry correct (the top rung of the text ladder).
- **identity** — mock location provider.
- **label** — renders a physical screen label onto the lock screen or wallpaper, so you can tell which phone on the rack is `#7`.

**APK resolution is three tiers, first match wins:** `ENKAKU_GUEST_AGENT_PATH` → a local Gradle build under `apps/guest-agent/app/build/outputs/apk/` → the sha256-pinned artifact from the Toolchain Manager. **It is never auto-built** (Gradle needs a JDK and the Android SDK and takes minutes) — a missing APK fails with instructions.

After cloning you must run `git submodule update --init --recursive`, or the Android build fails on a missing `Android.mk`.

### 6.6 adb discipline

- A **per-device command queue** — one device runs one adb command at a time.
- A **global semaphore that scales with fleet size**: `auto = min(24, max(6, ceil(nonOfflineDevices × 0.75)))`. `adb.maxConcurrent = 0` means auto; an operator can pin it, effective immediately with no restart.
- A **separate streaming lane** for long-lived commands (`logcat`, `top`, the crash watch, ui-server instrumentation) so a stuck stream cannot park an exec slot: `adb.maxStreams` auto = `min(64, max(8, ceil(nonOfflineDevices × 2.5)))`. Over-limit requests are refused immediately (`E_ADB_STREAM_LIMIT`), never queued.
- Host `adb` CLI processes (install/push/forward) go through a bounded helper (`adb.maxHostConcurrent`, default 4) with a stricter install/push sub-limit (`adb.maxInstallConcurrent`, default 2).

> **`adb kill-server` is forbidden everywhere except `packages/core/src/tools/adb-server-control.ts`'s `cycle()`.** Port 5037 is shared with Android Studio and every other adb consumer on the machine. `cycle()` has exactly two audited entry points — the Toolchain Manager's adb version swap, and the operator's "Restart adb server" button. Both drain sessions, leases and (only on explicit override) running jobs first, and reattach every remembered network address afterwards. A workspace-wide test asserts the literal string appears in exactly that one non-test file.

---

## 7. Control — session, lease, queue

### 7.1 Lease + heartbeat

The holder heartbeats roughly every 15 s to extend the lease. An expired lease fails the job and force-releases the device — without it, one stuck script (ANR, freeze, disconnect) means a dead device until restart. A reaper also releases idle manual leases.

### 7.2 Co-control (Assist) and Mirror

A **co-control grant** is a third authorisation object beside the lease. It admits exactly five verbs — `input.tap`, `input.swipe`, `input.gesture`, `input.key`, `input.text` — into a device someone else already holds, and **nothing else**. The gate (`checkAssistAllowed`) is a separate function consulted only after the lease gate has already refused; every other input-adjacent surface (`shell.exec`, `inspect.*`, `clipboard.set`, install/push/pull, the adb endpoint) calls only the lease gate and was never given the fallback. That is proven structurally by a test that grants Assist and then watches all five of those surfaces refuse while `input.tap` succeeds.

- It never changes `DeviceStatus`; the device really is `busy` throughout.
- It is never a takeover — the primary holder is always reported `takeable: false` through this path.
- Gated by `coControl.mode` (`off | admin | operator`, default `operator`) **plus** the `device.assist` permission.
- Lives `coControl.grantTtlSec` (default 300 s), refreshed on each accepted action, and ends through **five** independent paths: TTL expiry, the assisting socket closing, voluntary release, the primary hold ending normally, and the primary hold being taken over (wired separately, because a takeover's compare-and-swap never calls the ordinary release path).
- Every accepted assist increments `jobs.assistCount`, writes an `input`-stream device event, and is audited.

**Mirror** — one operator driving many devices from one focused view — rides on exactly this mechanism. Each selected device resolves independently (idle ⇒ ordinary manual lease; already held ⇒ ordinary grant), with one reported outcome per device and never a silent drop. There is no multi-device lock anywhere.

### 7.3 The queue

The queue is **per device**, because the device is the constraint. A single-writer `BEGIN IMMEDIATE` transaction claims the next `queued` job for an `idle` device, ordered by priority then creation time, and stamps a lease expiry. `runtime.maxConcurrent` is enforced **inside that same SQL transaction**, proven against 8 racing OS processes.

SQLite is retained by explicit decision (zero setup); Drizzle is the ORM; the driver stays abstracted in case Postgres is ever needed.

### 7.4 Video pipeline

```
device  ── scrcpy-server (vanilla .jar, version-locked)
        ── H.264 over adb-forwarded TCP sockets
core    ── packages/scrcpy demuxer  →  binary WS frames
           [1B channel | 1B streamId | 1B codec+keyframe | u16 w | u16 h | u32 seq | payload]
browser ── WebCodecs VideoDecoder  →  canvas         (LAN)
        ── WebRTC (RTP/H.264 repackaged by the relay) (cloud/WAN)
```

Session startup announces five phases over WS (`session.progress`): `connecting → waking → starting-video → waiting-frame → ready`, each with a human detail string — so an operator watching a tile sees *why* it is slow, not merely that it is.

**Two quality profiles**, `control` and `wall`, each a named preset (`sharp/balanced/light`, `detailed/balanced/light/minimal`) plus an Advanced reveal of size/fps/bitrate. The wall's tile budget is a **decode-bound ceiling** intersected with a bandwidth bound that only binds on cloud/WAN — bandwidth was never the real constraint on loopback. `POST /api/video/reprofile` restarts only the sessions whose resolved numbers actually changed, carrying subscribers across the restart, and skips any device currently `busy`.

### 7.5 Input realism

Input is not a naive `input tap`. A gesture is a cubic-Bézier path with configurable curvature and easing (`linear`, `easeOutQuad`, `easeInOutCubic`), `scroll` ends at low velocity while `fling` ends at high velocity and lets the list coast, and taps carry a configurable jitter range. The farm-wide `natural` timing profile is the default; `instant` bypasses it. An **input arbiter** serialises everything into three lanes — pointer, keys, text — so two sources can never interleave one gesture.

Text entry is a **ladder**, and the chosen rung is reported back to the script as `via`: `ui-server-set-text` (element-scoped, unicode-clean, tried first when a selector makes it applicable) → `agent-ime` → `scrcpy-text` → `adb-ascii`.

The positioning here is explicit and matters (spec §9, §17): this is **instrumentation for testing your own detectors**, not blind evasion. Real devices beat emulators for that; realistic input timing is standard QA practice.

---

## 8. Automation — scripts, plugins, workflows, recordings

### 8.1 The one decision the rest follows from

> **A plugin is a grouping and build concept, not an execution concept.**

Publishing a plugin writes **one `plugins` row** and **N ordinary `scripts` rows**, one per member, all pointing at the *same* bundle text. Nothing about the queue, the lease, the executor, the runner, job pinning, batches, or schedules learns what a plugin is. `jobs.scriptId` still points at a concrete script entry, and a queued job still runs exactly the bytes it was enqueued against.

Two consequences carry the whole design:

1. **One bundle, N entries.** A published bundle is ~674 KB, almost all of it inlined `zod` + `@enkaku/sdk`. Twenty scripts published individually ≈ 13 MB of duplicated dependency graph; as one plugin it is ~700 KB plus the members' own code.
2. **The child needs to know which member to run** — that is `ENKAKU_SCRIPT_EXPORT_ID`.

Since plan 110, **`defineScript` no longer exists**. A script cannot be published outside a plugin; `definePlugin` is the only authoring entry point.

### 8.2 The script shape

```ts
import { definePlugin, defineService, ui } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'my-pack',            // [a-z0-9-] — also the KV namespace
  version: '1.0.0',         // stamped onto every member
  title: 'My pack',
  scripts: [
    {
      id: 'open-settings',
      params: z.object({ query: z.string().default('') }),
      result: z.object({ opened: z.boolean() }),   // the OUTPUT CONTRACT
      runtime: { timeoutMs: 60_000, retries: 1, maxRssBytes: 512e6, maxConcurrent: 4 },
      async prepare(ctx) { /* get the device ready; may fail and retry */ },
      async run(ctx)     { /* the real work */ return { opened: true } },
      async finish(ctx)  { /* ALWAYS runs — must be stateless and idempotent */ },
      reset: { packages: ['com.android.settings'], clearData: false },
      assist: 'allow',
    },
  ],
  service: defineService({ permissions: ['device.network.set'], setup: async (ctx) => {/* … */} }),
  surface: { /* nav entries, views, actions — see §9.4 */ },
})
```

**Three phases.** `prepare` (retryable), `run` (the work), `finish` (always). **`finish()` must be stateless and idempotent** — after a timeout kill the core runs it again in a fresh process.

**`ScriptContext` — what a script can reach** (`extends PluginContext`, so `storage`/`log`/`farm` are the same members from both ends):

| Member | What |
|---|---|
| `ctx.device` | `tap`/`swipe`/`scroll`/`fling`/`longPress`/`gesture`, `key`, `type`, `find`/`waitFor`/`dump`, `screenshot`, `install`/`push`/`pull`, `launch`, clipboard, `wake`/`sleep`, network |
| `ctx.params` | The parsed, typed params (from the member's Zod schema) |
| `ctx.artifact` | `screenshot()`, `file()` — writes into `artifacts/<job-id>/`, returns an id `device.push` can consume |
| `ctx.kv` | `{ device, global }` — the durable KV store, namespace injected server-side |
| `ctx.jobs` | List the queue, enqueue a child job (a job can start a job) |
| `ctx.job` | `{ id, attempt, deviceId }` |
| `ctx.progress(v)` | Streams progress to the job detail screen |
| `ctx.onAssist(cb)` | React to a human assisting mid-run (optional; an assist never aborts a job) |
| `ctx.log`, `ctx.storage`, `ctx.farm` | Inherited from `PluginContext` |

**Coordinate-space rule, and it bites.** `tap`/`swipe`/`scroll`/`fling`/`longPress` take **device pixels**. `tapNorm`/`swipeNorm`/`gesture` take **normalised 0..1** and exist for the *recording replay interpreter alone*. `Point` and `NormPoint` are structurally identical `{x,y}` shapes — **nothing type-checks the difference**, so handing a fraction to `tap()` lands near the top-left corner on every device, every time.

### 8.3 The runtime envelope and the output contract

- **`runtime: { sdk, timeoutMs, retries, maxRssBytes, maxConcurrent }`** is a *restriction, never a permission*. It is persisted on the `scripts` row so a job pins the declaration that was **reviewed**, not the bundle's own self-report. A per-job override is checked against the farm ceiling **before the job row is even written**, and is **refused outright rather than clamped** when it exceeds it. Memory is a self-reported-RSS sampler with an immediate SIGKILL and no grace.
- **`result`** makes "did this actually succeed" a declared five-state outcome (`jobs.result_status`) written once at settle — `valid`, `invalid`, `partial`, `oversize`, `undeclared` — instead of something read out of a free-text log. The job detail screen renders each with its own banner; a script that declared nothing still gets the raw `<pre>`.

### 8.4 Execution — what actually happens

```
enqueue ─▶ jobs row (queued, pinned bundle + runtime + scriptExportId)
        ─▶ scheduler claims it inside BEGIN IMMEDIATE (device idle? concurrency free?)
        ─▶ executor (script | workflow | install | push | pull | sleep | remote)
        ─▶ SessionManager attaches the device, lease acquired, heartbeat starts
        ─▶ job-runner spawns the CHILD:
              dev:      bun packages/session/src/runner/child-entry.ts
              compiled: <binary> --job-child
        ─▶ child imports the bundle, picks the member by ENKAKU_SCRIPT_EXPORT_ID,
           runs prepare → run → finish, streaming log/progress/artifacts over IPC
        ─▶ settle: result validated, result_status written, lease released, reset applied
```

**Isolation modes** (`ENKAKU_JOB_ISOLATION`): `child-process` (default) or `container` (`ENKAKU_JOB_IMAGE`, `ENKAKU_JOB_CPUS`, `ENKAKU_JOB_MEMORY_MB`, `ENKAKU_OCI_RUNTIME`). Again: **crash containment, not a sandbox.**

**Retries** are classified, not blind — `jobs/failure-class.ts` separates a transient device hiccup from a script defect, with backoff.

### 8.5 Workflows

A workflow is a `scripts` row with `kind: 'workflow'` whose `bundle` column holds a `WorkflowDoc` JSON instead of ESM. It runs as **one job under one lease**, on one device, with `job_nodes` recording per-execution history.

- **Nodes** are either `script` (a member ref + bindings + optional `reset`) or `gate` (a closed predicate).
- **Predicates are closed** — `ValueExpr` is `{const} | {param} | {node output path} | {run: 'summary'}`, and `GATE_OPS` is a fixed operator list combined with `all`/`any`/`not`. A gate cannot compute.
- **Outcomes** are `continue | stop | fail | goto <node>` — `goto` may jump **backward**, so the graph is not a DAG.
- The document stores **no coordinates and no edges array**. Edges are implicit in `next`/`onFailure`/`then`/`else`; the canvas view computes a cycle-tolerant layout on open and never writes it back. That is what keeps the "no migration" promise — the price, accepted explicitly, is that hand-arranging nodes does not persist.
- The **list editor is the editor of record**; the canvas reuses its node forms rather than growing parallel ones.

### 8.6 Action recordings

Record a real device session; it compiles to an **ordinary script**. There is no third artifact type.

- A `.recording.json` in the workspace, with every position **normalised 0..1** — because it is captured on one device and replayed on a device of a different size.
- A pointer trace is replayed **sample for sample**, never collapsed into a synthesised Bézier: the curvature and velocity are the human's who recorded it.
- Each step keeps a **selector candidate** with its match count and anchor age. "Promote" turns a raw point into a selector, and is disabled unless the candidate is a unique match — naming the actual count in the disabled reason.
- The review panel supports trim/reorder/delete, parameterising a typed-text step (or reverting it to a literal), and `speed`/`maxGapMs`/`cleanup` under the document's own compare-and-swap. Publishing produces a plain `kind: 'script'` row via `defineRecording`; Detach is one-way.

### 8.7 Batches, clusters, schedules

- **Cluster** — a *container*, not a selector: a device belongs to at most one (`devices.clusterId`).
- **Batch** — one script run resolved across a device set (explicit list, tag, or cluster), optionally **paced**: `count` / `interval[min,max]` / `deviceInterval`. Every draw is materialised on the `jobs` row it governs (`notBefore`, `batchRepeat`, `pacedDelayMs`) using `crypto.getRandomValues`, **never `Math.random`** — so a restart resumes from the database alone, never from process memory. A boot-time sweep reconciles a batch whose last job settled during a crash. `POST /:id/stop` marks it `stopping` first (so the pacer plans nothing further), cancels queued members, aborts running ones through the *same* `JobService.cancel()` a standalone cancel uses, and reports `{ cancelled, aborted, refused, refusedDeviceIds }` — gated **per member**, so a partial success is never silent.
- **Schedule** — cron-triggered dispatch of a batch **or an AI-agent thread**, with overlap policy, queue timeout, catch-up, jitter and priority. `schedule_runs` records one row per fire decision *including* the "ran nothing" outcomes (`skipped-overlap`, `skipped-missed`, `no-targets`, `error`), so a schedule's history is never a blank gap. `jitterSec` shifts the whole firing before a batch exists; pacing's interval shifts each repetition once it does — two different knobs.

### 8.8 The command console

Fleet-wide shell commands with a target model, per-device output, saved commands, and a run history (`command_runs`, `command_run_members`, `saved_commands`), pushed live over WS (`command.started/stage/progress/output/finished`). High-consequence commands are recognised and confirmed.

---

## 9. The plugin system in depth

`docs/feat/plugin-and-script.md` is the full as-built analysis; this is the shape.

### 9.1 Lifecycle A — publishing

```
stage ──▶ verify (a bounded 15s CHILD process imports the bundle and reports
          id/version/members/schemas) ──▶ activate ──▶ (rollback | reload | disable | remove)
```

The runtime **never throws because a plugin is broken**. A bad plugin is recorded `failed` with a verbatim error and code, contributes zero scripts, and changes nothing about any other plugin. Studio's Plugins page is failed-plugins-first for exactly that reason.

Name conflicts are reported as a conflict, not a crash. Removing a plugin offers `?deleteKv=1` with a real entry count read from `GET /api/plugins/:name/data/count` — and if the count cannot be read, the checkbox still renders and says so rather than hiding the only way to delete the data.

### 9.2 Lifecycle B — dev slots

`enkaku dev` builds locally, pushes, and watches. A dev slot is **in-memory, never a DB row** — that is the feature. Studio badges it `DEV`, and "Drop dev slot" is one click.

### 9.3 Lifecycle C — embedded packs

`bun run build:packs` bundles `plugins/*` into `packages/core/packs/`, embedded into the compiled binary. On boot they are **staged once, never auto-activated**.

### 9.4 A plugin's three optional halves

| Half | Declared with | Runs | Isolation |
|---|---|---|---|
| **Scripts** | `scripts: [...]` | In a job, in a child process, on a leased device | Crash containment |
| **Service** | `service: defineService({ permissions, setup })` | For as long as the plugin is enabled | **In the core's own process — not a sandbox** |
| **Surface** | `surface: { nav, views, actions }` | In Studio's browser tab | Tier A rendered from the manifest; tier C is the plugin's own React |

**The service** gets `onStop`, TCP/UDP listeners, farm events, HTTP/WS/query handlers and inbound webhooks (HMAC-signed via `x-enkaku-signature`, rate-limited, body-capped). Its load-bearing piece is **`ctx.farm` — the capability broker** — and the *ordering* of its two checks: a capability absent from `defineService({ permissions })` is refused **before** `invoke()` is entered, so an undeclared call can never act and then be reported as refused. Every call is audited under a `plugin:<name>` principal, and a plugin's authority is its publisher's, resolved live.

**The surface** has two live tiers (tier B, a sandboxed iframe, was built and then deleted the same day by plan 111):

- **Tier A — declarative.** `nav` entries, `views` with a `table` fed by a closed `DataSource` (`kv.scan` / `kv.list` / `handler`), columns stated as ordinary JSON Schema nodes and drawn by the *same* `planField`/`formatValue` resolver the run dialog uses, and `actions` (`job` / `batch` / `kv.set` / `kv.delete` / `form`) that read a row through a closed `Binding` language. **Nothing an author writes is an expression** — a tier-A surface cannot compute. A data source can only ever read the declaring plugin's own KV namespace, taken from the URL path *server-side*.
- **Tier C — React.** A view states `react: { entry, apiVersion }`; Studio mounts the plugin's own component into its own tree behind an error boundary, with the host's live `@enkaku/ui` components and the operator's own session. React is shared through an import map so a plugin cannot bring a second copy and hit "Invalid hook call". The farm's UI major is `PLUGIN_UI_API_VERSION` — a constant in `@enkaku/protocol`, not read from a package file, because a `--compile` binary cannot read a workspace file at runtime.

Every plugin screen renders through **one page**: `/plugins/view?name=<plugin>&view=<viewId>` — a query parameter, not a dynamic route (the same static-export precedent `/device?id=…` set). Plugin nav entries live in their **own labelled group below the static nav**, so installing a plugin never moves Jobs or Devices.

### 9.5 A plugin's storage — the KV store *is* the store

There is no per-plugin storage engine. `kv_entries` under the plugin's own namespace **is** the plugin's store, shared by every member script *and* by its screens: a script's scrape is what a screen reads, and a screen's write is what the next job reads.

**One table, three axes, one flag:** `(scope, scopeId, namespace, key)` + `secret`.

- **`namespace`** is **injected, never chosen** — the child sends no namespace, the parent resolves it from the plugin. Two plugins cannot collide.
- **`scope`** is one sentence: **if forgetting the device should forget the fact, it is device-scoped.** A `global` entry (`scopeId = ''`) is a catalogue or a farm setting, bounded by `kv.maxEntriesPerNamespace`. A `device` entry keys on `stableId`, is deleted in the same transaction that forgets the device, and is additionally bounded by `kv.maxEntriesPerDevice` across all namespaces. A script may only ever write its own device's scope.
- **`secret: true`** stores a credential the admin UI masks; revealing it is **one route, admin-only, audited**.
- The only bulk delete in the whole product is `DELETE /api/plugins/:name/:version?deleteKv=1`.
- Operator access to a plugin's data goes through the `plugin.data` permission and the `/api/plugins/:name/data/*` routes: list, write, delete, count, and a cross-device `scan` that answers one key across the whole fleet in a single join.

`GET /api/kv/namespaces` exists so the KV panel can be a picker rather than a guess.

### 9.6 The shipped packs

| Pack | Version | What it demonstrates |
|---|---|---|
| `plugins/networking` | 2.2.0 | The simple case — scripts only |
| `plugins/proxy-manager` | 0.6.0 | Tier C React UI, a real `service/` with both SOCKS5 and HTTP diallers and listeners, a supervisor, a versioned record with a two-key split, a shipped npm dependency (`socks`) inside the `.enkaku` package, and `ctx.farm.call('device.network.set', …)` — asking the farm, never touching a phone directly |
| `plugins/tiktok-automation-pack` | 1.12.0 | A long real-world automation: screen recognition, modal handling, account switching, search-follow, and a file-based post queue |

---

## 10. AI agents, capabilities, MCP

### 10.1 Capabilities — one vocabulary, many callers

`packages/core/src/capability/` declares ~50 operations across `device.*`, `fs.*`, `files.*`, `script.*`, `job.*`, `skills.*`, `agent.*`, `notify.*`. Each is a schema-typed, named operation with a permission. Adding one is a single entry in its own file's array **and nothing else**; a duplicate id or an unconvertible schema throws at boot.

The same registry is what an **AI agent**, an **MCP client** (`POST /mcp`), a **plugin service** (`ctx.farm.call`), and `GET /api/v1/cap` all act through. There is no second door.

### 10.2 AI agents

An **AI agent** is a stored, editable configuration — model, provider connector, system prompt, context budgets, tool allowlist, device grants (empty = all devices), workspace scope, permissions — that runs conversations (`agent_threads`), executes turns (`agent_runs`) and exchanges messages (`agent_messages`, with images stored content-addressed in `agent_blobs`).

- **`connectors`** — farm-level, admin-managed LLM endpoints (Anthropic, OpenRouter, …) with an AES-256-GCM-encrypted credential. **Load-bearing**: an agent cannot run without one.
- **`agent_approvals`** — a destructive capability call can pause for a human decision, persisted so a core restart resumes the run exactly where it paused.
- **`agent_inbox`** — a message sent to a busy agent queues until the next turn boundary.
- **`agent_spawn_grants`** — one agent may spawn another, opt-in per pair, defaulting to none.
- **`packages/harness`** is the loop itself: a virtual filesystem, file tools, compaction, resilience, session/message stores and a streaming runtime. Agent output streams to Studio over WS (`agent.delta`, `agent.tool.started/finished`, `agent.run.*`, `agent.approval.*`).
- **`workspace_files`** is the agent's virtual filesystem — deliberately *not* the real OS filesystem, since an agent reading attacker-controllable device screens runs under crash containment, not a sandbox. SQLite holds only the catalogue (path, size, hash, content type, `storage`, `locator`); bytes over `workspace.inlineMaxBytes` (64 KiB) go to the content-addressed `fs` driver under `workspace-content/`. A rename is therefore a row update, identical bytes are stored once, and no operator-supplied filename is ever joined to a path.
- **`webhook_endpoints`** — an agent chooses a webhook **by name**, never a raw URL, so `notify.send` cannot leak farm data to an arbitrary address. `notifications` (the bell) is written *before* delivery is attempted, so the record survives a failed delivery.

---

## 11. Networking — routing a device's traffic

Four engines behind two operator-facing words, and the plan's central job was **refusing to present them as equals**:

| Engine | Mechanism | Escapable? | Credential |
|---|---|---|---|
| `none` | — | — | default |
| `adb-proxy` | `settings put global http_proxy` at a proxy the phone can reach | **Yes** — advisory; WebView and many HTTP libraries honour it, an app with its own sockets ignores it | none (Android's setting carries `host:port` and **no credential at all**, world-readable on-device) |
| `adb-reverse-proxy` | The same setting pointed at the phone's own loopback over `adb reverse` | **Yes** — same advisory nature | works — the account **stays on the farm** |
| `vpn-helper` | The guest agent's SOCKS5 **full tunnel** | **No** | sent to the phone |

Consequences the code enforces rather than merely documents:

- `enabled` reads **`asked`**, not `yes`, for the advisory rungs.
- `deriveHealth` is pinned at **`unverified`** for both HTTP rungs, forever.
- The device's *existing* proxy is captured and restored, which is not the same as resetting to `:0`.
- The mode selector states the difference **at the point of choice**, including that VPN mode sends the upstream password to the phone — which is precisely what the reverse rung exists to avoid.
- Egress verification is a real probe **through** the tunnel. With `ENKAKU_NETWORK_PROBE_URL` unset, checks degrade to `skip` — never to a false `ok`. `packages/probe-server` is the self-hosted endpoint.

---

## 12. Data model

46 SQLite tables, 61 Drizzle migrations. Timestamps are integer unix **seconds** (`mode: 'timestamp'`). Generate a migration with `bun run --cwd packages/core db:generate` after changing `src/db/schema.ts`.

| Group | Tables |
|---|---|
| **Devices** | `devices`, `device_tags`, `device_endpoints`, `device_events`, `device_numbers`, `discovered_devices`, `blocked_devices`, `deleted_devices`, `network_credentials` |
| **Work** | `jobs`, `job_nodes`, `job_resumes`, `artifacts`, `scripts`, `script_param_sets`, `plugins`, `plugin_webhooks` |
| **Dispatch** | `clusters`, `batches`, `schedules`, `schedule_runs`, `schedule_agent_targets` |
| **Console** | `command_runs`, `command_run_members`, `saved_commands` |
| **AI** | `ai_agents`, `agent_threads`, `agent_runs`, `agent_messages`, `agent_approvals`, `agent_inbox`, `agent_spawn_grants`, `agent_blobs`, `connectors` |
| **Platform** | `users`, `sessions`, `audit_log`, `farm_settings`, `tool_installs`, `nodes`, `kv_entries`, `workspace_files`, `notifications`, `webhook_endpoints`, `sequences`, `migration_markers` |

Every farm-wide setting lives as JSON in a single **always-exactly-one-row** table, `farm_settings` (`id = 1`), whose shape is `FarmSettingsSchema` in `@enkaku/protocol` — 27 top-level groups: `defaults`, `labelling`, `battery`, `retention`, `adb`, `discovery`, `guestAgent`, `monitor`, `health`, `adbControl`, `shell`, `coControl`, `mirror`, `job`, `workflow`, `session`, `display`, `video`, `wall`, `readiness`, `transfer`, `network`, `workspace`, `kv`, `agentDefaults`, `scheduledAgents`, `recording`. Studio's Settings screens are **rendered from that schema** — that is the schema-driven-UI principle in practice.

---

## 13. The protocol

### 13.1 WebSocket (`/ws`)

One envelope, ~120 message types, all defined in `packages/protocol/src/messages/`. Families:

`hello` · `lease.*` · `assist.*` · `mirror.*` · `input.*` · `inspect.*` · `stream.*` · `session.progress` · `clipboard.*` · `shell.*` · `transfer.*` · `job.*` · `log.*` · `command.*` · `monitor.*` · `device.*` (battery, event, viewers, pairing, cutover, unauthorized, inspector status) · `adb.*` · `tool.*` · `scan.progress` · `batch.status` · `schedule.fired` · `notification.created` · `plugin.log` · `recording.*` · `agent.*`

Binary frames ride the same socket with a 1-byte channel prefix: `VIDEO 0x01`, `AUDIO 0x02`, `CONTROL 0x03`, `SNAPSHOT 0x04`.

> **There is no snapshot replay.** A client must `GET /api/devices` first, *then* subscribe. This trips people up constantly.

### 13.2 REST (`/api/*`)

Mounted in `packages/core/src/server/http.ts`:

```
/api/auth  /api/nodes  /api/devices  /api/guest-agent  /api/transfers  /api/tags
/api/clusters  /api/topology  /api/batches  /api/command-runs  /api/saved-commands
/api/schedules  /api/settings  /api/artifacts  /api/workspace  /api/adb/stats
/api/video  /api/doctor  /api/jobs  /api/scripts  /api/workflows  /api/recordings
/api/plugins  /api/agents  /api/connectors  /api/kv  /api/notifications  /api/webhooks
/api/v1/cap  /api/v1/threads  /api/v1/runs  /api/v1/approvals  /api/v1/agent-commands
/api/v1/blobs  /api/health  /api/registry  /api/openapi.json  /mcp
```

`GET /api/openapi.json` is generated from the same Zod schemas the routes validate with. `GET /api/registry` is what Studio renders its engine dropdowns from.

**Conventions** (plans overview §4.4): plural resource nouns, POST for actions, errors as `{ code, message }` with a stable `E_*`/snake code, cursor pagination for anything unbounded.

---

## 14. Security and operations

### 14.1 Auth

- **Auth mode derives from the bind address.** Loopback ⇒ `local`; non-loopback ⇒ `server` ⇒ **TLS required** unless `ENKAKU_ALLOW_INSECURE=1`. An invalid combination fails the boot.
- Session cookies + a `POST /api/auth/ws-ticket` handshake for the WebSocket.
- **Two roles: `admin` and `operator`**, over a flat `Permission` union (`device.view/control/settings/enroll/quarantine/owner.set/shell/adb/files/network/assist`, `fs.read/write`, `agent.view/manage/run`, `notify.send`, `script.view/publish/delete`, `job.view/run/cancel.any`, `tool.view/manage`, `settings.view/manage`, `user.manage`, `audit.view`, `plugin.data`). `admin` implies everything.
- Several sensitive capabilities are **a farm-wide mode AND a role permission, checked together** — `shell.mode`, `coControl.mode` — rather than a second role switch. An operator who has been granted shell still cannot use it if the farm has it `off`.
- Device ownership narrows further: `canUseDevice`, `canCancelJob`.
- Everything sensitive writes to `audit_log`.

### 14.2 Secrets

`secrets.key` and `network-credentials.key` live **beside** the database, not in it (AES-256-GCM). Connector credentials, proxy credentials and `secret: true` KV entries are encrypted at rest; revealing one is a dedicated, admin-only, audited route.

### 14.3 Isolation — stated honestly

| Layer | Reality |
|---|---|
| Script / job | Child process (or container). **Crash containment.** Not a security boundary. |
| Plugin service | **In the core's process.** Can `import('node:fs')` and open the farm's database. `ctx.farm` narrows only what it reaches *through the context*. |
| Plugin tier-C UI | Runs in Studio's own tree with the operator's session. No sandbox, by design — the alternative (an iframe) was built and deleted. |
| AI agent | Same crash containment as a script, which is *why* it gets a virtual filesystem instead of the real one. |

### 14.4 Operational surfaces

- **`bun run doctor`** — toolchain integrity, adb reachability, egress.
- **`enkaku backup`** — a CLI, not a Studio button, because a correct backup must run against a quiescent core and must carry `secrets.key` alongside the database.
- **Retention** — artifacts by age and total size; device events by stream (`main` 30 d, `input` 3 d — the input stream is far higher volume) with a per-device row ceiling; command runs; orphaned agent blobs with a grace period.
- **Telemetry** and **licensing** (`editions.ts`, signed license file) exist and are opt-in / file-driven.

---

## 15. Studio

Next.js **static export** (`output: 'export'`), served by the core on the same origin. Workspace packages go in `transpilePackages`.

### 15.1 Screens

| Route | Screen |
|---|---|
| `/` | **Dashboard — opens on the Wall, unconditionally.** Every device live in a grid at the wall quality profile. List is one click (or `?view=list`) away and remembered per browser tab; `?view=` always wins. Tiles lead with the short number `#7` beside the label. |
| `/device?id=…` | Device detail / live control — **a query parameter, not a dynamic route** (static export). Tabs: Control, Jobs, Monitor, Crashes, Terminal, Files, Network, Agent, Identity, Logs, Storage, Settings. Much of this is progressively moving into a floating **device popup** over the wall (M68). |
| `/scripts`, `/scripts/detail` | Script library, versions, enable/disable, run (parameter form generated from the Zod schema), publish |
| `/workflows`, `/workflows/editor` | List; the list editor (editor of record) with a List/Canvas toggle |
| `/recordings`, `/recordings/detail` | Recording list + the step review panel |
| `/jobs`, `/jobs/detail` | Status, realtime logs, artifacts, the declared result with its contract banner |
| `/batches`, `/batches/detail`, `/clusters`, `/schedules`, `/schedules/detail` | Dispatch |
| `/console` | The command console |
| `/plugins`, `/plugins/detail`, `/plugins/view` | Failed-plugins-first list; install/disable/rollback/reload/remove-with-data; **the one page every plugin screen renders through** |
| `/agents`, `/agents/detail`, `/agents/thread`, `/agents/runs`, `/agents/approvals` | AI agents |
| `/workspace` | Tree + editor over the virtual filesystem, with upload, rename, and per-content-type **presenters** (text edits; image/video view-only with `Range` streaming; anything else is named, sized and offered as a download rather than left blank) |
| `/tools` | Toolchain manager. scrcpy-server shows as "managed by core" (read-only) |
| `/settings` | Devices · Jobs · AI Agents · Farm — rendered from `FarmSettingsSchema` |
| `/nodes`, `/topology`, `/login`, `/setup`, `/dev/tools` | Cloud nodes, cluster topology (a redirect into the wall grouped by cluster), auth, first-run, dev tools |

### 15.2 Design system

`docs/design.md` is the authority. `packages/ui/src/theme.css` is the **one** definition of the design tokens — read by Studio *and* by every plugin's own Tailwind build.

Two rules that fail **silently** if broken:

- **Tailwind v4 colour classes are written `bg-surface`, `text-fg-muted`.** The v3 bracket form (`bg-[--color-surface]`) compiles to nothing in v4 and fails with no error.
- **Internal links must use `next/link`.** A plain `<a>` triggers a full document navigation that remounts React, drops the WebSocket, and kills the live video.

Also: `backdrop-filter` is forbidden on anything repeated per device — the wall's GPU decode budget is exactly what the realtime work was built to win back.

---

## 16. Cloud mode

```
   ┌──────────────── control plane (ENKAKU_MODE=orchestrator) ────────────────┐
   │  Studio · orchestrator · WebRTC relay · nodes registry · enrollment      │
   └──────────────▲──────────────────────────────────────────────────────────┘
                  │ ONE outbound WebSocket (no port forwarding, NAT is a non-issue)
   ┌──────────────┴──────────┐
   │  node (packages/node)   │  mini-core beside the phones
   │  tunnel · adb-raw ·     │
   │  shell · clipboard      │
   └──────────┬──────────────┘
              │ USB / LAN
          the phones
```

- `POST /api/nodes` mints an enrollment token; `ENKAKU_CP_URL` + `ENKAKU_ENROLL_TOKEN` enroll the node once, after which `bun run dev:node` is enough.
- `packages/core/src/tunnel/` carries node auth, a registry, a router, an RPC layer, remote sessions, a channel allocator, remote adb and a device proxy. Jobs on node-owned devices run through the `remote` executor.
- `packages/core/src/relay/` terminates WebRTC and repackages H.264 as RTP. `GET /api/nodes/ice-config` serves STUN/TURN config (`deploy/coturn/` has a working turnserver config).
- **Cloud devices** — redroid containers over `adb-tcp`. Useful for throughput; poor for anything that needs a "real device", since plenty of naive detection flags an emulator immediately.

---

## 17. Configuration

**Precedence: env > file > default.** An invalid config fails the boot and never silently falls back. `.env.example` at the root is the reference for every variable the code reads; `docs/guide/install.md` has the prose.

Selected variables (56 total in `.env.example`):

| Group | Variables |
|---|---|
| Core | `ENKAKU_MODE`, `ENKAKU_BIND`, `ENKAKU_PORT`, `ENKAKU_DATA_DIR`, `ENKAKU_CONFIG`, `ENKAKU_PUBLIC_URL`, `ENKAKU_NO_OPEN`, `ENKAKU_LOG_LEVEL`, `ENKAKU_LOG_JSON` |
| Auth / TLS | `ENKAKU_AUTH_MODE`, `ENKAKU_ALLOW_INSECURE`, `ENKAKU_TLS_MODE`, `ENKAKU_TLS_CERT`, `ENKAKU_TLS_KEY`, `ENKAKU_TRUST_PROXY`, `ENKAKU_TOKEN` |
| Tools | `ENKAKU_ADB_PATH`, `ENKAKU_TOOLS_MANIFEST_URL`, `ENKAKU_GUEST_AGENT_PATH`, `ENKAKU_UI_SERVER_PORT_RANGE` |
| Jobs | `ENKAKU_JOB_ISOLATION`, `ENKAKU_JOB_IMAGE`, `ENKAKU_JOB_CPUS`, `ENKAKU_JOB_MEMORY_MB`, `ENKAKU_OCI_RUNTIME`, `ENKAKU_CONTAINER_RUNTIME` |
| Lease / queue | `ENKAKU_LEASE_HEARTBEAT_MS`, `ENKAKU_LEASE_JOB_TTL`, `ENKAKU_LEASE_MANUAL_IDLE_TIMEOUT`, `ENKAKU_LEASE_REAPER_MS`, `ENKAKU_SCHEDULER_INTERVAL_MS` |
| Cloud | `ENKAKU_CP_URL`, `ENKAKU_ENROLL_TOKEN`, `ENKAKU_NODE_NAME`, `ENKAKU_STUN_URL`, `ENKAKU_TURN_URL`, `ENKAKU_TURN_USER`, `ENKAKU_TURN_PASSWORD`, `ENKAKU_TURN_SECRET` |
| Network | `ENKAKU_NETWORK_PROBE_URL`, `ENKAKU_NETWORK_PROBE_DNS_ZONE`, `ENKAKU_NETWORK_SESSION_TEMPLATE`, `ENKAKU_REVERSE_DEVICE_PORT_RANGE` |
| AI | `ENKAKU_ANTHROPIC_API_KEY`, `ENKAKU_OPENROUTER_API_KEY` |
| Misc | `ENKAKU_LICENSE_FILE`, `ENKAKU_LICENSE_PUBKEY`, `ENKAKU_TELEMETRY_URL`, `ENKAKU_FEED_URL`, `ENKAKU_PUBLISH_TOKEN`, `ENKAKU_STUDIO_DIST`, `ENKAKU_TEST_DEVICE`, `ENKAKU_SMOKE_PROXY` |

> **The `.env` trap that costs an hour.** Bun loads the root `.env` automatically for anything it runs *as code* (core, node, `scripts/`), but does **not** expand it inside `package.json` script strings — so `dev:studio`'s `${NEXT_PUBLIC_ENKAKU_CORE_URL:-…}` never sees it. Studio's variables belong in `packages/studio/.env`, which Next loads itself.

---

## 18. Working on it

### 18.1 Commands

```bash
bun install
git submodule update --init --recursive   # required — the guest agent vendors hev-socks5-tunnel

bun run dev            # core on :7700, data in .dev-data/
bun run dev:studio     # Next dev on :3001, pointing at the core on :7700
bun run dev:cloud      # control plane (ENKAKU_MODE=orchestrator, .dev-cloud/)
bun run dev:node       # cloud node (needs ENKAKU_CP_URL)
bun run dev:desktop    # Tauri (needs Rust; usually ENKAKU_CORE_BIN=<path>)

bun run typecheck      # every package — cheap, run it freely
bun run build:studio   # static export → packages/studio/out (served by the core)
bun run build:packs    # bundle plugins/* → packages/core/packs/ (embedded in the binary)
bun run build:guest-agent   # the on-device APK (needs JDK 17 + Android SDK)
bun run doctor         # environment check
bun run reset          # delete .dev-data / .dev-cloud / .dev-node
bun run --cwd packages/core db:generate   # a Drizzle migration after editing schema.ts
```

### 18.2 Testing — the one hard rule

Tests are `bun test`, colocated `*.test.ts` in `src/`. Device-dependent tests are gated behind `ENKAKU_TEST_DEVICE=1`.

> **Never run a full test suite. Run only the tests for the files you changed.** This is a hard rule.
>
> ```bash
> bun test packages/core/src/plugins/binding.test.ts    # yes — one file
> bun test packages/core/src/plugins/                    # yes — the directory you touched
> bun test                                               # NO
> bun run --cwd packages/studio test                     # NO
> ```
>
> Why it is not fussiness: Studio's `test` script passes `--isolate`, which is **required** (without it a `mock.module` from one file leaks into every file after it). That means ~170 fresh processes, each building a complete `happy-dom`. One run is ~80 s; **four agents running it concurrently took over six minutes and pinned every core.** It compounds; it does not divide. Also: never run two test invocations at once — they share `packages/sdk/src/cli/.test-fixtures` and report fictional failure counts.
>
> If you cannot scope a run to what you touched, **skip testing and say so.** A named gap is cheaper than a cooked laptop.

**Three separate invocations exist, on purpose.** A bare `bun test` from the root never runs `packages/studio` — `bunfig.toml`'s `pathIgnorePatterns` excludes it, because Studio's component tests need `happy-dom` preloaded and Bun's preload is a single global list for the whole invocation; preloading it globally broke core tests that stub `globalThis.fetch` themselves. So:

```bash
bun test                              # packages/* except studio      ) owner
bun run --cwd packages/studio test    # ~170 isolated processes, ~80s ) and
bun run --cwd packages/ui test        # @enkaku/ui components         ) CI only
```

There is still **no linter and no formatter**. The observed style is: no semicolons, single quotes, two-space indent.

### 18.3 CI and release

- **`ci.yml`** — `bun run typecheck`, `bun test`, and (separately) the Studio suite, on every push and PR; plus a path-conditional `android` job that builds the guest agent APK when `apps/guest-agent/**` changes. **Neither job touches a physical device.**
- **That gap is `bun run smoke:guest-agent`** — `scripts/smoke-guest-agent.ts` drives one real phone through install, bootstrap, token rotation, routing and uninstall over adb, gated behind `ENKAKU_TEST_DEVICE=1` and requiring an explicit `--serial`. It exists because the six defects it checks for were all found by hand on hardware and none showed up in `bun test`.
- **`release.yml`** — on a `v*` tag, builds per-OS binaries, **boots each one and checks `/api/health`** before publishing. Studio, the migrations and the example packs are embedded, so a release is one self-contained file. It does **not** yet build or pin the guest agent APK.
- **`scripts/spec-check.ts`** validates that every table, screen and route named in the code exists in `docs/spec.md` or `docs/spec-divergences.md`. **`scripts/check-plan-status.sh`** enforces plan-status honesty.

### 18.4 Traps, ranked by how often they bite

1. **`git submodule update --init --recursive`** after cloning, or the Android build fails on a missing `Android.mk`.
2. **`bun run typecheck`, never `bun run scripts/typecheck.sh`** — Bun misreads the shebang and executes the shell script as JavaScript. `bash scripts/typecheck.sh` also works.
3. **Never run `git stash`** (or any whole-tree operation) while other agents may be working. One agent stashed and wiped 203 tracked modifications plus 121 untracked files out from under three concurrent workers.
4. **Do not "unify" the two TypeScript versions.**
5. **`adb kill-server` is forbidden** outside `adb-server-control.ts`'s `cycle()`.
6. **`bg-[--color-surface]` compiles to nothing** in Tailwind v4.
7. **A plain `<a>` in Studio kills the video stream.**
8. **Do not run `bun run build:studio` while `next dev` is running** — `next build` writes into `.next` regardless of `distDir` and corrupts the dev server. The build script refuses and says so.
9. **The `/ws` protocol has no snapshot replay** — `GET /api/devices` first, then subscribe.

### 18.5 Language and commits

All documentation, code comments, identifiers, UI copy and commit messages are **English**. Commits are conventional, scoped by milestone or package: `feat(m8): …`, `fix(studio): …`.

---

## 19. Where to go next

| You want to… | Read |
|---|---|
| Know what something *should* do | [`docs/spec.md`](spec.md) |
| Understand a decision, or start a plan | [`docs/plans/00-overview.md`](plans/00-overview.md) then the plan itself |
| Write a plugin or script | [`docs/feat/plugin-and-script.md`](feat/plugin-and-script.md), [`docs/guide/scripts.md`](guide/scripts.md), `plugins/*` |
| Store plugin data | [`docs/feat/kv-storage.md`](feat/kv-storage.md) |
| Build UI | [`docs/design.md`](design.md), `packages/ui/src/theme.css` |
| Install or deploy | [`docs/guide/install.md`](guide/install.md), [`cloud.md`](guide/cloud.md), [`redroid.md`](guide/redroid.md) |
| Work on the guest agent | [`apps/guest-agent/README.md`](../apps/guest-agent/README.md), [`docs/research/android-guest-agent.md`](research/android-guest-agent.md) |
| Enroll devices, label them, spoof identity | [`enrollment.md`](guide/enrollment.md), [`physical-labelling.md`](guide/physical-labelling.md), [`identity.md`](guide/identity.md) |
| Build workflows or recordings | [`workflows.md`](guide/workflows.md), [`record-and-replay.md`](guide/record-and-replay.md) |
| Know where code and spec knowingly differ | [`docs/spec-divergences.md`](spec-divergences.md) |
| Ship a release | [`docs/guide/release-checklist.md`](guide/release-checklist.md), [`LICENSES.md`](../LICENSES.md) |
