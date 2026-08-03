# Plan 43 — M15b : `enkaku-guest-agent` and the `vpn-helper` network engine

> **Status:** not started.
> **Depends on:** Plan 33 (M15 — the network layer, its engine interface, lease-scoped apply/revert, and the event-log kinds). Do not start this before 33's acceptance criteria pass.
> **Spec references:** §7.9 (network layer), §7.10 (first-party agent), §7.2/§7.3 (Toolchain Manager and manifest), §7.4 (the `ui-server` provisioning precedent), §17 (positioning).
> **Research:** `docs/research/android-guest-agent.md` — every platform claim in this plan is sourced there. **Read it before step 5.1.** Where this plan states a platform behaviour without a source, the source is in that document.

---

## 0. Scoping decision (recorded, not open)

The agent is built **for internal and development use on our own farm devices**. It is not published to Google Play, and no consumer installs it themselves.

This closes the research document's §8 risk (Google's developer verification, enforcement from September 2026) for the current scope. Record the boundary rather than the conclusion: **if the agent is ever shipped to customers as part of the sold product, that question reopens and must be answered before distribution** — and it applies equally to the existing `ui-server` APK, which is in the same position today.

---

## 0b. Coordination with the M17 series (plans 35–41)

Those plans are being worked **in parallel by other builders**. Three of them touch ground this plan also stands on, so the boundaries are stated here rather than discovered in a merge:

- **Plan 39 (M17e — file transfer and APK install)** is the nearest collision. It owns *user-facing* APK install: an operator pushing an arbitrary app under test onto a device. This plan owns the *agent's own* provisioning, which is a different thing — it is toolchain-managed, sha256-pinned, and followed by an app-op grant and a bootstrap launch that a generic installer has no business knowing about. **If 39 lands first, reuse its transfer primitive rather than duplicating it; do not fold the agent into its UI.**
- **Plan 41 (M17g — toolchain integrity and doctor)** owns manifest verification. The new `guest-agent` manifest entry must satisfy whatever integrity rules 41 establishes; if 41 lands first, read it before step 5.5.
- **Plan 34 (M16)** repairs the `ui-server` launcher this plan mirrors. Copy the pattern *after* 34 lands, or copy the repaired version — not the version with the defect 34 exists to fix.

Files this plan owns outright and no other plan should touch: `apps/guest-agent/**`, `scripts/build-guest-agent.sh`, `packages/drivers/src/network/guest-agent/**`, `packages/protocol/src/guest-agent.ts`.

## 1. Goals

Once this plan is done, all of the following are TRUE:

1. `apps/guest-agent/` builds a signed APK headlessly with `bash scripts/build-guest-agent.sh`, with no Android Studio.
2. The APK exposes a versioned control channel over a `localabstract` socket, carrying typed request/response — not fire-and-forget intents.
3. The host can provision a device unattended: install, pre-grant, clear the stopped state, forward, and handshake — with no human touching the phone.
4. The `vpn-helper` engine from plan 33 flips from `available: false` to a working `NetworkRoute`, routing device traffic through an authenticated SOCKS5 upstream that apps cannot opt out of.
5. `observe()` and `probe()` are answered by the agent from on-device truth (VPN up/down, egress IP) rather than inferred from an adb command's exit code.
6. The agent reports its capabilities at handshake; the host never assumes a capability that was not advertised.
7. Lease-scoped teardown from plan 33 applies unchanged — the route dies with the lease, including on reaper expiry and device offline.
8. A per-release smoke test pins the three undocumented platform behaviours this design depends on, and fails loudly when one changes.

## 2. Non-goals

- **Replacing the `ui-server` inspector.** The agent may absorb it later; that is §9 Q3, not this plan.
- **Per-app routing** (`addAllowedApplication`/`addDisallowedApplication`). The manifest permission is declared so it is possible later, but the API surface stays device-wide here.
- **Always-on VPN across reboots.** Requires either an unverified secure-settings write or a device-owner DPC; see §9 Q2.
- **HTTPS interception.** Permanently out of scope (spec §7.9 rule 6).
- **Pools or rotation.** Excluded by spec §17. The agent routes to one operator-set upstream per lease.
- **Publishing the APK anywhere public.** See §0.

## 3. Context and design decisions

### 3.1 Why a first-party APK rather than a third-party VPN app

Two findings from the research kill the third-party route, and both are worth restating because they are counter-intuitive.

**`adb shell am` cannot reach components declared `exported="false"`.** Only root and system bypass the export check; shell is uid 2000 and is neither. Worse, `am broadcast` fails *silently* — it prints `Broadcast completed: result=0` and exits 0 while the receiver is skipped. So a device farm cannot drive an app that does not deliberately export an entry point, and it cannot even tell that it failed.

**Real candidates export nothing usable.** SocksDroid's manifest exports only its launcher activity; its VPN service and boot receiver are both unexported. There is no intent contract to declare — not an undocumented one, none at all.

Beyond that: a third-party VPN app is the highest-privilege thing installable on a device, seeing all traffic from every app; auditing someone else's binary in that position is not feasible, and pinning our own sha256 for an artifact we build is.

### 3.2 Why one general agent rather than a proxy shim

Provisioning cost is per-app, not per-feature: one install, one app-op grant, one stopped-state kick, one foreground service, one boot receiver, one manifest entry, one signing key, one CI job. A second app later doubles all of it, while the control channel — a `localabstract` socket carrying typed request/response — is identical whatever it carries.

So the agent is scoped as a general on-device helper with **negotiated capabilities**, and SOCKS routing is its first. This mirrors what the driver registry already does for engines: advertise, do not assume.

Declaring a `VpnService` does not start one. The service stays dormant until asked, and `ACTIVATE_VPN` is granted only on devices that need routing — so the agent can be installed fleet-wide while only a subset ever routes traffic.

### 3.3 Why `localabstract` and not a TCP port

`adb forward localabstract:<name>` reaches a `LocalServerSocket` in an ordinary installed app; SELinux permits it explicitly (`adbd.te` allows `adbd` → `appdomain:unix_stream_socket connectto`, present for `ndk-gdb`). Debuggability is irrelevant — `adbd` connects to the socket, it does not `run-as`.

It beats `tcp:<port>` on four counts: no `INTERNET` permission, no device-side port collision between phones, unreachable from any network interface, and no filesystem artifact to clean up.

The **host** port is still shared across devices, so the ownership check in `packages/drivers/src/inspector/ui-server/launcher.ts:57-71` is reused verbatim — a host port silently rebound to another device would route the wrong phone.

The control channel also survives VPN lockdown: netd's VPN routing rules all sit at priority ≥ 10000 while the kernel `local` table owns `127.0.0.0/8` at priority 0, and the BPF lockdown drop is gated on `skb->ifindex != 1`. Android 17's local-network permission does not apply either — loopback is outside its normative address list.

### 3.4 Why `hev-socks5-tunnel`

MIT, actively maintained (2.16.0, July 2026), already 16 KB-page-clean, SOCKS5 username/password auth plus UDP, four-method JNI taking the TUN fd directly, and four ABIs declared in its own `Application.mk`. It is what v2rayNG ships, so the integration path is exercised by a 60k-star app.

The whole GPL column — sing-box, sing-tun, mihomo, NekoBox, ClashMetaForAndroid — is excluded on licence: copyleft on a redistributed APK triggers source disclosure for the combined work. That constraint holds even under §0's internal-use scope, because the product is intended to be sellable and reversing the choice later would mean replacing the engine.

### 3.5 What the platform forces on us

Three behaviours are non-negotiable and each has bitten someone before:

- **Entry components must be `exported="true"`.** Guard them with a token in the payload, not a `signature`-level `android:permission` — shell is not signed with our key and would be blocked too.
- **A freshly installed app is in the stopped state and receives no broadcasts at all**, including `BOOT_COMPLETED`. The host must launch a component once after install, or the agent never restarts after the first reboot. The same applies after any `force-stop`.
- **The VpnService consent dialog is pre-granted with `appops set <pkg> ACTIVATE_VPN allow`**, which writes byte-for-byte the state the dialog writes. This is `@hide` and undocumented — it is pinned by the §7 smoke test, never assumed.

---

## 4. Technical design

### 4.1 Where everything lives

**Android source** — `apps/guest-agent/`, matching the `apps/desktop/` precedent (a non-JS toolchain driven from a shell script):

```
apps/guest-agent/
  package.json                     # minimal + private; satisfies the apps/* Bun workspace glob
  settings.gradle.kts
  build.gradle.kts
  gradle.properties
  gradlew  gradlew.bat
  gradle/
    libs.versions.toml
    wrapper/gradle-wrapper.jar          # a binary blob in git; unavoidable
    wrapper/gradle-wrapper.properties   # set distributionSha256Sum — the repo's pinning idiom
  app/
    build.gradle.kts
    src/main/AndroidManifest.xml
    src/main/kotlin/dev/enkaku/guestagent/
      BootstrapActivity.kt        # exported; exists solely to clear the stopped state
      ControlService.kt           # foreground service, owns the localabstract socket
      control/                    # request/response codec + handlers
      route/RouteVpnService.kt    # VpnService + hev JNI
      BootReceiver.kt
    src/main/jni/                 # ndk-build glue for hev-socks5-tunnel
  third_party/hev-socks5-tunnel/  # git submodule, MIT
  README.md
```

**The project is scaffolded with Google's official CLI, never by hand.** `gradle init` has no Android project type and never has; Android Studio's wizard was the only official path until Android CLI reached stable 1.0 in May 2026. The exact command used:

```bash
brew tap android/tap && brew install --cask android-cli
android create --name="Enkaku Guest Agent" --minSdk=26 -o apps/guest-agent empty-activity
```

Then three deliberate departures from the template: the package renamed to `dev.enkaku.guestagent` (matching `dev.enkaku.desktop`), the sample navigation code deleted, and `MainActivity` replaced by `BootstrapActivity`.

**Versions are whatever the official template pins**, not the newest available — drifting from them without a reason is how builds break:

| | Version |
|---|---|
| Android Gradle Plugin | 9.0.1 |
| Gradle | 9.1.0 (wrapper, with `distributionSha256Sum` set) |
| Kotlin | 2.3.20 |
| compileSdk / targetSdk | 36 |
| minSdk | 26 |
| Java toolchain | 17 |

Note JDK 17 is the minimum **and** the default for AGP 9 — a newer JDK is not a drop-in substitute. Install it keg-only (`brew install openjdk@17`) rather than as the `temurin@17` cask, which needs `sudo` and so cannot be provisioned non-interactively.

**Build output** — the Gradle convention, gitignored:
`apps/guest-agent/app/build/outputs/apk/release/app-release.apk`

**Distribution** — a GitHub release asset, with its sha256 pinned in `packages/toolchain/manifest/enkaku-tools.json` as a new tool:

```json
{
  "id": "guest-agent",
  "displayName": "Enkaku guest agent (on-device helper)",
  "swappable": false,
  "format": "raw",
  "versions": [{
    "version": "0.1.0",
    "releasedAt": "…",
    "compatibleCoreRange": "…",
    "platforms": { "*": { "url": "https://github.com/…/releases/download/guest-agent-v0.1.0/enkaku-guest-agent.apk",
                          "sha256": "…", "sizeBytes": … } }
  }]
}
```

`swappable: false` — the control protocol is versioned with the core, so the APK is core-managed exactly like `scrcpy-server` and `ui-server`.

**Runtime path on a user machine** — `<dataDir>/tools/guest-agent/<version>/guest-agent.apk`, which needs one new `case 'guest-agent': return 'guest-agent.apk'` in `packages/toolchain/src/entrypoints.ts:6`.

**The dev path needs no new mechanism.** `resolveToolPath` (`packages/toolchain/src/manager.ts:134-137`) already derives an override key as `ENKAKU_${toolId.toUpperCase().replace(/-/g,'_')}_PATH` and logs a warning when it is used. So a developer who has just built locally runs:

```bash
ENKAKU_GUEST_AGENT_PATH=$PWD/apps/guest-agent/app/build/outputs/apk/release/app-release.apk bun run dev
```

**Do not commit the APK to the repo.** The download-and-verify discipline is the whole point of the Toolchain Manager, and a binary in git defeats it. Build once, publish, pin the published artifact — the same model already used for `adb` and `ui-server`.

**`guest-agent` must NOT join `REQUIRED_TOOLS`** (`packages/core/src/daemon.ts:78`). It is provisioned on demand the first time a device selects the `vpn-helper` engine; most farms never will, and gating daemon startup on it would break every install.

**Host-side driver code** — `packages/drivers/src/network/guest-agent/`, mirroring `packages/drivers/src/inspector/ui-server/` file for file:

```
launcher.ts   # isInstalled / ensureInstalled / start / stop + host-port ownership check
client.ts     # the control protocol client over the forwarded socket
watchdog.ts   # reuse the ui-server state machine
README.md
```

**Wire contract** — `packages/protocol/src/guest-agent.ts` (Zod), because every boundary contract lives in `packages/protocol` and both core and the cloud agent need it.

**Build script** — `scripts/build-guest-agent.sh`, modelled on `scripts/build-desktop.sh`, plus a root `"build:guest-agent"` script.

**`.gitignore` additions**:
```
apps/guest-agent/local.properties
apps/guest-agent/**/build/
apps/guest-agent/.gradle/
*.jks
keystore.properties
```

### 4.2 The control protocol

Newline-delimited JSON over the `localabstract` socket, each frame Zod-parsed on both ends. Request/response correlated by `id`, mirroring the WS envelope convention (`00-overview.md` §4.3).

```ts
// packages/protocol/src/guest-agent.ts
export const GUEST_AGENT_SOCKET = 'enkaku-guest-agent'   // localabstract name
export const GUEST_AGENT_PROTOCOL = 1                     // bumped on any breaking change

export const GuestAgentCapabilitySchema = z.enum(['socks5-route', 'egress-probe', 'vpn-status'])

export const GuestAgentHelloSchema = z.object({
  protocol: z.number().int(),
  appVersion: z.string(),
  capabilities: z.array(GuestAgentCapabilitySchema),
  androidSdkInt: z.number().int(),
})

export const GuestAgentRequestSchema = z.discriminatedUnion('method', [
  z.object({ id: z.string(), method: z.literal('hello'), token: z.string() }),
  z.object({ id: z.string(), method: z.literal('route.start'), config: Socks5RouteConfigSchema }),
  z.object({ id: z.string(), method: z.literal('route.stop') }),
  z.object({ id: z.string(), method: z.literal('route.status') }),
  z.object({ id: z.string(), method: z.literal('egress.probe'), url: z.string().url() }),
])
```

`route.status` returns on-device truth — whether `establish()` currently holds a TUN, the engine's own stats, and the last error — which is what makes plan 33's `observe()` honest instead of inferred. `egress.probe` answers `probe()` from the device's own vantage point.

**The token.** Because the entry components must be exported (§3.5), authorisation lives in the payload: the host writes a random token with `am start ... --es token <t>` at bootstrap; the agent stores it in memory only and rejects every request that does not carry it. It is regenerated on each `ensureStarted`, so a stale token from a previous session is useless.

**Version handshake.** The host sends `hello` first and refuses to proceed on a `protocol` mismatch, surfacing a coded error rather than degrading silently.

### 4.3 The `vpn-helper` engine

Implements plan 33's `NetworkRoute` against the client:

| Method | Behaviour |
|---|---|
| `apply(cfg)` | ensure installed → ensure app-op → ensure started → forward + ownership check → `hello` → `route.start` |
| `observe()` | `route.status`, mapped into `NetworkObservation` |
| `probe()` | `egress.probe` against the configured, self-hostable endpoint |
| `revert()` | `route.stop`, then remove the forward — **idempotent**, tolerating an already-stopped agent or a vanished device |

Capabilities advertised to the registry: `{ auth: true, enforcing: true, udp: true, probe: true }`. Credentials continue to travel as a `credentialRef` and are resolved host-side immediately before `route.start`; the agent holds them in memory for the lifetime of the route and never writes them to disk.

### 4.4 Manifest shape

Foreground service type is mandatory from Android 14. Use **`specialUse`** — its runtime prerequisites are "None", it is not on Android 15's list of types a `BOOT_COMPLETED` receiver may not start, and it is not subject to Android 15's 6h/24h FGS timeout.

> ⚠️ Do **not** declare `systemExempted` on the strength of the docs. The research found a genuine contradiction between the published FGS-types page and a second AOSP source about whether the `ACTIVATE_VPN` app-op unlocks it. `specialUse` is correct either way; step 5.3 resolves the question on a real device and records the answer.

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE"/>
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES"/>

<activity android:name=".BootstrapActivity" android:exported="true"/>

<service android:name=".ControlService" android:exported="true"
         android:foregroundServiceType="specialUse">
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
              android:value="device_farm_control_channel"/>
</service>

<service android:name=".RouteVpnService"
         android:permission="android.permission.BIND_VPN_SERVICE"
         android:foregroundServiceType="specialUse" android:exported="false">
    <intent-filter><action android:name="android.net.VpnService"/></intent-filter>
</service>
```

`BIND_VPN_SERVICE` is an `android:permission` **attribute on the service** — the system holds it, we do not. `RouteVpnService` stays unexported because only our own process starts it. `QUERY_ALL_PACKAGES` is declared for future per-app routing (§2) and is unrestricted for us since we never face Play review.

`VpnService.protect()` must be called on the socket carrying tunnel traffic to the upstream, or its packets re-enter our own default route and loop forever.

### 4.5 Studio: agent status, install, and repair

The agent must be visible and manageable from the web UI. An operator should never need a terminal to find out whether a device has the agent, nor to put it there.

**Per-device status** on the device page, rendered from a single `GET /api/devices/:id/guest-agent`:

| State | Meaning | Action offered |
|---|---|---|
| `not-installed` | package absent | **Install** |
| `installed` | present, but the app-op or bootstrap step is missing | **Repair** |
| `ready` | installed, pre-granted, handshake succeeds | — |
| `outdated` | installed version older than the provisioned one | **Update** |
| `unreachable` | installed and bootstrapped, but the control channel does not answer | **Restart** |
| `unsupported` | device cannot run it (SDK below minSdk) | — with the reason shown |

`installed` versus `ready` must stay distinct for the same reason plan 33 separates declared from observed: a package being present says nothing about whether it can actually be driven, and collapsing the two would report a broken device as healthy.

**Fleet view.** A column on the device list plus a filter, so "which devices lack the agent" is one glance rather than an audit. Install is offered as a bulk action over the current selection, reusing the batch machinery.

**Progress.** Install reuses the existing tool-provisioning progress channel (`tool.install.progress`, `packages/core/src/tools/provision.ts`) rather than inventing a second one — the first install on any farm also downloads the APK, and that download is already modelled there.

Endpoints, gated by `device.network` and a held lease exactly as plan 33's are:

```
GET    /api/devices/:id/guest-agent     → status above
POST   /api/devices/:id/guest-agent     → install or repair (idempotent)
DELETE /api/devices/:id/guest-agent     → uninstall
```

Uninstall must state plainly in the UI that it clears the `ACTIVATE_VPN` app-op — the grant is tied to the uid and does not survive a true uninstall, so a reinstall needs the whole provisioning sequence again.

Every transition is written to the device event log as `guest-agent.installed` / `.repaired` / `.removed` / `.unreachable`, with the same Studio label wiring plan 33 §4.9 describes.

### 4.6 Host provisioning sequence

```bash
adb -s <serial> install -r -g <guest-agent.apk>
adb -s <serial> shell appops set dev.enkaku.guestagent ACTIVATE_VPN allow
adb -s <serial> shell dumpsys deviceidle whitelist +dev.enkaku.guestagent
adb -s <serial> shell am start -n dev.enkaku.guestagent/.BootstrapActivity --es token <t>
adb -s <serial> forward localabstract:enkaku-guest-agent
adb -s <serial> forward --list          # ownership check before any request
```

Notes verified against AOSP rather than the docs: `-r` is a modern no-op (replace is the default); `-g` grants runtime and development permissions only, **not** `ACTIVATE_VPN`, which is a pure app op and needs the separate call; the app-op survives `install -r` and reboot but is cleared on true uninstall, so it must be re-applied after any reinstall.

For install verification use **`cmd package path <pkg>`** (fixed `package:` prefix, exit 1 when absent), not `pm list packages <pkg>` — that filter is a substring match, so `com.foo` also matches `com.foo.bar`.

---

## 5. Implementation steps

**5.1 Read the research.** `docs/research/android-guest-agent.md` in full, and confirm the §0 scoping decision still holds. → no code.

**5.2 Gradle skeleton. ✅ DONE.** Scaffolded with `android create` per §4.1; package renamed; sample navigation removed; `BootstrapActivity` exported and documenting why. `apps/guest-agent/package.json` satisfies the `apps/*` workspace glob, `scripts/build-guest-agent.sh` resolves the JDK and prints the artifact's sha256, and `apps/guest-agent/.gitignore` covers the signing material. Verified: `./gradlew assembleDebug` → `BUILD SUCCESSFUL`, `app-debug.apk` produced. Release signing (a keystore in CI) is still outstanding and lands with 5.11.

**5.3 Control channel, no routing yet. 🟡 DEVICE-SIDE DONE, UNVERIFIED ON HARDWARE.** `ControlService` is a `specialUse` foreground service owning `localabstract:enkaku-guest-agent`, speaking newline-delimited JSON with `hello` and `ping`, token-authorised via `Pairing` (memory only, constant-time compare). `BootstrapActivity` starts it with the token; `BootReceiver` restarts it after boot, deliberately unpaired. Manifest verified after merge: the service carries `foregroundServiceType="specialUse"`, and `FOREGROUND_SERVICE_SPECIAL_USE`, `RECEIVE_BOOT_COMPLETED` and `POST_NOTIFICATIONS` are all present. Build green.

  **Still outstanding on this step, and it needs a physical device:** no handshake has ever run. Nothing has confirmed that `adb forward localabstract:` actually reaches the socket, that `startForeground` with `specialUse` is accepted at runtime, or whether `systemExempted` would also have been accepted (§4.4). Until a device runs it, treat this step as written-but-unproven.

**5.4 Host launcher + client.** `packages/drivers/src/network/guest-agent/{launcher,client,watchdog}.ts` and the protocol schemas. Reuse the `ui-server` ownership check verbatim. → an integration test drives install → bootstrap → handshake against a real device.

**5.5 Toolchain wiring.** The manifest entry, the `entrypoints.ts` case, and confirmation that `ENKAKU_GUEST_AGENT_PATH` resolves a locally built APK. Do **not** add it to `REQUIRED_TOOLS`. → a fresh core with no release published still boots; a device selecting `vpn-helper` provisions on demand.

**5.6 The tunnel engine. ✅ DONE.** `hev-socks5-tunnel` added as a submodule at `apps/guest-agent/third_party/`, **pinned to tag 2.16.0** (not `master`), with its own nested submodules (`yaml`, `lwip`, `hev-task-system`, `src/core`) initialised. Licence verified from the file: MIT. `ndk-build` wired through Gradle `externalNativeBuild`, restricted to the `hev-socks5-tunnel` shared-library target so the unused standalone executable is not built, with `-DPKGNAME=dev/enkaku/guestagent/route -DCLSNAME=Tun2Socks`. NDK r29 installed via `android sdk install "ndk;29.0.14206865"`.

  Verified after build: `libhev-socks5-tunnel.so` is packaged for `arm64-v8a` (323 KB), `armeabi-v7a` (200 KB) and `x86_64` (326 KB), and `llvm-objdump -p` reports `align 2**14` — 16 KB pages, as upstream's `Android.mk` intends with its explicit `-Wl,-z,max-page-size=16384`.

  **Two corrections to earlier assumptions, both found by reading the C source rather than the docs:**
  - The JNI surface has **three** methods, not four. `src/hev-jni.c` at 2.16.0 registers `TProxyStartService(String,int)`, `TProxyStopService()` and `TProxyGetStats()[J`. There is no `TProxyIsRunning`, despite integration guides that show one. `Tun2Socks.kt` matches the source.
  - **minSdk moved from 26 to 29.** Upstream's `Application.mk` pins `APP_PLATFORM := android-29`, which is the floor they actually test. Devices below it report `unsupported` in Studio (§4.5) rather than failing at runtime.

  Note the coupling this creates: `hev-jni.c` resolves its peer with `FindClass(PKGNAME "/" CLSNAME)` at load time, so renaming or moving `Tun2Socks` breaks the native library **with no compile error**. The class carries a comment saying so.

**5.7 `RouteVpnService`. 🟡 WRITTEN, UNVERIFIED ON HARDWARE.** `Builder` → `establish()` → the fd handed to `TProxyStartService` on a dedicated thread; `Socks5Config` renders upstream YAML matching `conf/main.yml` at 2.16.0, written to private storage with the world-read bit cleared and deleted on teardown, because it carries the upstream password. `onRevoke()` tears down rather than leaving status claiming a route that carries nothing. `RouteState` publishes observed state — up/down, upstream host:port only, last error, `TProxyGetStats()` counters — so `route.status` answers from observation, not from what the host last asked. `route.start` / `route.stop` / `route.status` are wired into the control channel, and `E_NOT_PREPARED` is a distinct error from an unreachable upstream so Studio can offer the right repair. Manifest verified after merge: `BIND_VPN_SERVICE` as the service's `android:permission` attribute, the `android.net.VpnService` intent-filter, `exported="false"`, `specialUse`.

  **Not done and needing a device:** nothing has established a TUN, so `establish()`, the JNI handoff, and whether traffic actually reaches a SOCKS5 upstream are all unproven. Two known gaps in the code itself: `protect()` is exposed as `protectOutbound` but no caller uses it yet — it becomes load-bearing when the egress probe lands, and the probe is deliberately absent from the advertised capabilities until then; and the DNS server is hardcoded to `1.1.1.1` rather than taken from the route config.

**5.8 Engine implementation.** The `NetworkRoute` from §4.3; flip `vpn-helper` from `PLANNED`/`available: false` to a real descriptor in `packages/drivers/src/descriptors.ts`. → selecting it in Studio routes a real device.

**5.8b Studio agent management.** §4.5 — the status endpoint, the device-page card with its six states, the fleet column plus filter, bulk install over a selection, and the event-log kinds. → an operator installs the agent onto a fresh device from the browser alone, and a device whose control channel is dead reads `unreachable`, not `ready`.

**5.9 Lease teardown.** Confirm plan 33's four revert sites drive `revert()` here unchanged; add nothing new. → killing a job mid-run leaves no VPN up.

**5.10 The pinning smoke test.** Per §7 — the three undocumented behaviours, gated behind `ENKAKU_TEST_DEVICE=1`.

**5.11 CI + release.** A job on `ubuntu-latest` with JDK 17 + `sdkmanager`, keystore from a base64 secret; publish the APK as a release asset and record its sha256 in the manifest. Extend `.github/workflows/release.yml`'s checksum sweep.

**5.12 Docs.** `apps/guest-agent/README.md` (build, sign, provision, protocol), a `docs/guide/` page for operators, and the package README updates required by the global Definition of Done.

---

## 6. Acceptance criteria

1. A clean machine with only JDK 17 and cmdline-tools builds a signed APK via `bash scripts/build-guest-agent.sh`.
2. A factory-reset device is provisioned end to end by the §4.5 sequence with **no human touching the phone**, and the handshake reports the expected capabilities.
3. `VpnService.prepare()` returns `null` after the `appops` call — the consent dialog never appears.
4. After a **reboot**, the agent's service is running again and the host can reconnect without reinstalling.
5. Traffic from the device reaches an authenticated SOCKS5 upstream; an app that ignores `http_proxy` is nevertheless routed — the property `adb-proxy` cannot provide.
6. UDP and DNS traverse the tunnel.
7. `route.status` reflects reality: killing the VPN from Settings makes `observe()` report drift within one poll.
8. `probe()` returns the upstream's egress IP as seen from the device.
9. Releasing the lease tears the route down; so does lease expiry via the reaper, and so does the device going offline.
10. Revert called twice on an already-clean device does not throw.
11. No credential is written to device storage, the `jobs` table, artifacts, or the event log.
12. A protocol-version mismatch produces a coded error, not a silent degradation.
13. An unauthenticated request on the control socket is rejected.
14. An operator installs the agent onto a fresh device **from Studio alone**, with no terminal, and sees live progress.
15. A device with the package present but the app-op missing reads `installed`, not `ready`; killing the agent makes it read `unreachable`.
16. The device list shows agent state per device and can filter on it; bulk install works over a selection.
17. `bun run typecheck` clean, `bun test` green; the §7 smoke test passes on every supported Android version.

## 7. Test plan

**Unit (host)** — protocol codec round-trip; token rejection; version-mismatch handling; `revert()` idempotency; ownership-check rejection when `forward --list` shows another serial; capability gating (a method refused when not advertised).

**Instrumented (device, `ENKAKU_TEST_DEVICE=1`)** — the pinning suite for the three undocumented behaviours, which must fail loudly rather than degrade:

```bash
# 1. The app-op really does pre-grant consent
adb shell appops set dev.enkaku.guestagent ACTIVATE_VPN allow
adb shell appops get dev.enkaku.guestagent ACTIVATE_VPN     # expect allow
# then assert prepare() returned null via the control channel

# 2. exported=true is genuinely required — assert the negative
#    a build variant with ControlService exported=false must FAIL to start from am,
#    proving the export requirement rather than assuming it

# 3. The stopped state really does block BOOT_COMPLETED
adb install -r -g guest-agent.apk        # do NOT launch it
adb reboot && # wait
adb shell dumpsys activity services dev.enkaku.guestagent   # expect: nothing running
adb shell am start -n dev.enkaku.guestagent/.BootstrapActivity --es token t
adb reboot && # wait
adb shell dumpsys activity services dev.enkaku.guestagent   # expect: running

# 4. Loopback survives lockdown (API 37+)
adb shell am compat enable RESTRICT_LOCAL_NETWORK dev.enkaku.guestagent && adb reboot
# assert the control channel still answers
```

**Manual smoke** — provision a device, point the route at a SOCKS5 server with auth, confirm egress IP from `probe()`, run a script that asserts the IP mid-job, then let the job time out and confirm the route is gone.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **An undocumented behaviour changes in a new Android release** (app-op pre-consent, export rules, stopped state) | The §7 pinning suite runs per supported version and fails loudly; each has a documented fallback — tapping the consent dialog with our own input engine is the backstop for the app-op |
| Agent killed by the low-memory killer or vendor battery management | Reuse the `ui-server` watchdog state machine; the Doze whitelist is applied at provisioning; `route.status` surfaces the gap rather than hiding it |
| A route leaks past its lease | Plan 33's four revert sites, unchanged, plus reconcile-on-idle; `revert()` is idempotent by contract |
| Host port rebound to another device | The `forward --list` ownership check, reused verbatim from `ui-server` |
| Third language toolchain slows CI | The Android job runs only when `apps/guest-agent/**` changes; the APK is a pinned release artifact, so ordinary contributors never build it |
| Reproducible-build expectations | Explicitly not attempted (research §7): build once, publish, pin the published artifact's sha256 |
| Scope drift toward pools/rotation | Spec §17; `Socks5RouteConfig` has no pool field to grow into |
| §0 assumption silently outlived | §0 states the reopening condition; revisit before any customer distribution |

## 9. Open questions

1. **Which Android versions form the supported matrix**, and therefore how many devices the §7 suite must run against per release?
2. **Always-on VPN across reboots** — does writing `settings put secure always_on_vpn_app` actually take effect (research marks it UNCONFIRMED), or is a device-owner DPC required? Affects whether a farm device can hold a route across a reboot at all, which interacts with lease scoping.
3. **Does the agent eventually absorb `ui-server`?** Two on-device apps with overlapping lifecycles is a maintenance cost worth deciding deliberately. If yes, the control protocol should be designed now with that in mind rather than retrofitted.
4. **Where do SOCKS5 credentials live host-side?** Inherited from plan 33 §9 Q2 and still unanswered; this plan assumes a `credentialRef` resolved immediately before `route.start`.
5. **Does the cloud path need anything extra?** The agent-side host runs the adb commands, so it should work unchanged — confirm against `packages/core/src/tunnel/` before 5.4, and prove it by running acceptance criterion 5 through a cloud agent.
