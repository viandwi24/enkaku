# Research — `enkaku-guest-agent`: a first-party on-device helper app

> **Status: research, not a plan.** No implementation steps, no acceptance criteria. This exists so the plan that follows is written against verified platform behaviour rather than assumption.
> **Verified: August 2026.** Every claim below carries a source. Anything not verified is marked **UNCONFIRMED** — treat those as things to test on a device, never as things to build on.
> Related: spec §7.9 (network layer), §7.10 (VPN helper profiles — **this document supersedes its third-party framing**), plan 33 (M15).

---

## 0. Why this document exists

Plan 33 ships `adb-proxy` and `adb-reverse-proxy`, neither of which needs an app. The remaining rung — an *enforcing* route that an app under test cannot ignore — needs `VpnService`, which needs an APK on the device.

The question this answers is not "can we write an Android app" but **"which platform behaviours will the design depend on, and which of those are actually documented."** For a farm that provisions devices unattended, an undocumented behaviour that changes in Android 18 is an outage across the whole fleet.

---

## 1. Findings that change the design

Four results overturned working assumptions. They are listed first because everything else follows from them.

### 1.1 `adb shell am` cannot reach `exported="false"` components — and broadcasts fail *silently*

This is the most important correction, and it contradicts widespread belief.

All three of `am start`, `am start-foreground-service`, and `am broadcast` funnel into `ActivityManager.checkComponentPermission`, which bypasses the export check for **ROOT and SYSTEM only**:

```java
public static boolean canAccessUnexportedComponents(int uid) {
    final int appId = UserHandle.getAppId(uid);
    return (appId == Process.ROOT_UID || appId == Process.SYSTEM_UID);
}
```

Shell is uid 2000 and is **not** in that list. Verified byte-identical across Android 11, 13, 14, 16 and `main`. Shell holds `START_ACTIVITIES_FROM_BACKGROUND` but **not** `START_ANY_ACTIVITY` — it is trusted about *when* you may start something, never about *what*.

The three commands then fail differently, and the difference matters for tooling:

| Command | On `exported="false"` |
|---|---|
| `am start` | `SecurityException`, non-zero exit — loud |
| `am start-foreground-service` | `Error: Requires permission not exported from uid …`, non-zero exit |
| **`am broadcast`** | **prints `Broadcast completed: result=0` and exits 0** — `BroadcastSkipPolicy` returns a reason string that the caller logs and skips; it never throws |

**Never treat `am broadcast` exit 0 as delivery confirmation.** Grep logcat for `Permission Denial: broadcasting`.

Two consequences:

1. It independently explains why SocksDroid cannot be driven at all — its service and receiver are both `exported=false`, so no adb command can reach them, with or without a documented intent contract.
2. **Our own entry components must be `exported="true"`.** That is not a preference; nothing else works. Guarding them therefore has to happen *inside* the component (a token in the payload), because a `signature`-level `android:permission` would block shell too — shell is not signed with our key. **UNCONFIRMED:** that a signature-level component permission blocks shell; it follows from the permission model but was not device-tested.

Sources: [AOSP ActivityManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/ActivityManager.java), [AOSP ActiveServices.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/am/ActiveServices.java), AOSP `BroadcastSkipPolicy.java`, [AOSP Shell manifest](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/packages/Shell/AndroidManifest.xml)

### 1.2 The VpnService consent dialog *can* be pre-granted from adb

Earlier framing treated the consent dialog as the main obstacle to unattended provisioning. It is not.

`adb shell appops set <pkg> ACTIVATE_VPN allow` writes **byte-for-byte the same state** the consent dialog writes. In `Vpn.java`, tapping OK runs `setPackageAuthorization()` → `mAppOpsManager.setMode(OPSTR_ACTIVATE_VPN, uid, pkg, MODE_ALLOWED)`; `isVpnServicePreConsented()` then reads exactly that op, and `prepare()` returns `null` with no UI. `establish()` has the same gate. Shell can set it because `com.android.shell` holds `MANAGE_APP_OPS_MODES`, which is what `AppOpsService.enforceManageAppOpsModes` requires.

The public doc corroborates the contract without naming the mechanism: *"This method returns null if the VPN application is already prepared **or if the user has previously consented to the VPN application**."*

Stable since Android 5.0 — the op has existed with the same name for eleven years, and app-op names are effectively frozen because they persist in `/data/system/appops.xml`.

**But it is `@hide`/`@SystemApi` and appears in zero public docs.** Pin it and assert it in a smoke test per Android release.

Two riders:
- The op **also exempts the app from the Android 12+ background-FGS-start restriction** (`REASON_OP_ACTIVATE_VPN` in `ActiveServices`). This is absent from the [documented exemption list](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) — undocumented but present in Android 12 through 16.
- The op **survives `adb install -r` and reboot** but is cleared on true uninstall (new uid). Re-apply after any uninstall/reinstall.

Also note `OP_ACTIVATE_PLATFORM_VPN` exists and is *not* what we want — AOSP's own comment: *"This appop is insufficient to start VpnService based VPNs; OP_ACTIVATE_VPN is needed for that."*

Sources: [AOSP Vpn.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/connectivity/Vpn.java), [AOSP AppOpsManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/AppOpsManager.java), [VpnService reference](https://developer.android.com/reference/android/net/VpnService)

### 1.3 A freshly installed app is in the *stopped state* and receives no broadcasts at all

After `adb install`, the package carries `FLAG_STOPPED` and system broadcasts carry `FLAG_EXCLUDE_STOPPED_PACKAGES`. **`BOOT_COMPLETED` will never arrive**, so a boot receiver alone does not survive the first reboot. Android 15 tightened this further:

> *"Apps should only be removed from the stopped state through direct or indirect user action… the system also cancels all pending intents when the app enters the stopped state… When the user's actions remove the app from the stopped state, the `ACTION_BOOT_COMPLETED` broadcast is delivered to the app."*

**The host must explicitly launch a component once after install** (`am start` on an exported activity, or `am start-foreground-service`) to clear the stopped state. Budget for the same after any `force-stop`. `ApplicationStartInfo.wasForceStopped()` detects it in-app.

Sources: [Android 15 behavior changes — all apps](https://developer.android.com/about/versions/15/behavior-changes-all), [Intent reference](https://developer.android.com/reference/android/content/Intent)

### 1.4 The 16 KB page-size requirement is a Play policy, not a platform rule

This was previously treated as a hard cost of shipping native code. It is not.

> *"Starting November 1st, 2025, all new apps and updates to existing apps **submitted to Google Play** and targeting Android 15 (API level 35) and higher must support 16 KB page sizes."*

There is no platform enforcement and no announced date on which 4 KB-only apps stop working; Android 16 *added* a compatibility mode (`android:pageSizeCompat`), and Android 17's behaviour-changes page does not mention page size at all. No shipping device defaults to 16 KB — it is a developer toggle. And the doc is explicit that a **Kotlin/Java-only app is compliant by construction**.

Moot in practice anyway: NDK r28+ aligns to 16 KB by default, and the engine we would use is already clean (§3).

Sources: [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes), [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-all), [AOSP 16 KB page size](https://source.android.com/docs/core/architecture/16kb-page-size/16kb)

---

## 2. Platform baseline (August 2026)

| Platform | API | Codename | Released |
|---|---|---|---|
| **Android 17** | **37** | `CINNAMON_BUN` | 16 Jun 2026 |
| Android 16 QPR2 | 36.1 | — | Q4 2025 |
| Android 16 | 36 | `BAKLAVA` | 10 Jun 2025 |
| Android 15 | 35 | `VANILLA_ICE_CREAM` | 3 Sep 2024 |
| Android 14 | 34 | `UPSIDE_DOWN_CAKE` | Oct 2023 |

**Minor SDK versions are now real** (36.1, 37.1) and must be read with `Build.VERSION.SDK_INT_FULL`, not `SDK_INT`. A manifest cannot target a minor version.

**Install floor:** Android 14 blocks installing `targetSdk < 23`; Android 15 raised it to `< 24`; Android 16 and 17 added no further increment. So **targetSdk ≥ 24 installs anywhere**, regardless of source. Play's own targetSdk deadlines do not apply — this app is never published.

**minSdk recommendation: 26.** Reach at 26 is ~96.1%; dropping to 24 buys only 0.5 points, and 26 makes notification channels (mandatory for a persistent foreground service) native rather than a compat shim. Note the official distribution dashboard **no longer publishes per-API-level data** — the figures come from [apilevels.com](https://apilevels.com/) (Statcounter, April 2026) and are therefore **UNCONFIRMED at the official level**.

Sources: [uses-sdk / API levels](https://developer.android.com/guide/topics/manifest/uses-sdk-element), [Android 17 is here](https://developer.android.com/blog/posts/android-17-is-here), [Android 14](https://developer.android.com/about/versions/14/behavior-changes-all) and [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-all), [Distribution dashboard](https://developer.android.com/about/dashboards)

---

## 3. The tunnelling engine

`VpnService` hands us a TUN file descriptor. Something must read IP packets from it and forward them over SOCKS5. This is the only part that genuinely needs native code, and it is the part worth choosing carefully.

| | hev-socks5-tunnel | Outline SDK | xjasonlyu/tun2socks | badvpn | sing-tun / sing-box / mihomo |
|---|---|---|---|---|---|
| Language | C | Go (cgo/lwIP) | Go (gVisor) | C | Go |
| **License** | **MIT** | **Apache-2.0** | MIT | BSD-3 | **GPL-3.0-or-later** |
| Status | **active** (rel. 2.16.0, Jul 2026) | active (v0.0.23, beta) | active | **archived 2021** | active |
| SOCKS5 auth | **yes** | yes | yes | **no** | yes |
| UDP | **yes** (fullcone; UDP-in-UDP *and* UDP-in-TCP) | yes | yes | **no** | yes |
| Android story | **4 ABIs in `Application.mk`** | self-run `gomobile bind` | **none — no Android page, no android asset** | vendored submodule | no published AAR |
| 16 KB clean | **yes** (Jul 2025) | via NDK r28 | via NDK r28 | no | via NDK |

**Recommendation: `heiher/hev-socks5-tunnel` (MIT).** It is the only option that is simultaneously permissively licensed, actively maintained, purpose-built, already 16 KB-clean, and integrated through a small JNI surface that takes the fd directly:

```
TProxyStartService(String configPath, int fd)   TProxyStopService()   TProxyGetStats() → long[]
```

> **Corrected after integration (plan 43 step 5.6).** This section originally listed *four* methods, including `TProxyIsRunning()`. Reading `src/hev-jni.c` at tag 2.16.0 shows `RegisterNatives` is called with exactly the **three** above — there is no `TProxyIsRunning`, despite integration guides that show one. Verified by building against it. Treat the C source as the contract, never a guide.

Everything else is a YAML file we generate from Kotlin (`socks5.username`, `socks5.password`, `socks5.udp: 'udp'|'tcp'`, `tunnel.mtu`). The Java package is bound at compile time via `-DPKGNAME=… -DCLSNAME=…`, so `ndk-build` is a CI step, not a source fork.

It is also what **v2rayNG ships by default** (60k stars), so the integration path is battle-tested. Reference implementation: [heiher/sockstun](https://github.com/heiher/sockstun) (MIT, a complete Android app — read this one, it is safe to copy from).

**The GPL column is disqualified**, not on quality but on licence: sing-box, sing-tun, mihomo, NekoBox and ClashMetaForAndroid are all GPL-3.0-or-later, and copyleft on a redistributed APK triggers source disclosure for the combined work. sing-box additionally appends a naming clause outside the GPL's §7 framing; mihomo puts a naming restriction in its README rather than its LICENSE. Avoid the whole column. Note also that **nobody publishes a consumable TUN AAR** — libbox, libcore and Outline's tun2socks are all built from source in-tree, so "just add a dependency" is not on offer from anyone.

**Do not pick xjasonlyu/tun2socks** despite the clean API — its README never mentions Android, its wiki has no Android page, and its release assets contain 31 archives and not one `android-*`, `.so`, or `.aar`. We would be its first serious Android consumer.

**Pure-Java is not viable off the shelf.** No maintained pure-JVM tun2socks exists; the two interesting references ([NetBare](https://github.com/MegatronKing/NetBare-Android), [LocalVPN](https://github.com/hexene/LocalVPN)) are Apache/MIT but 6+ years stale and neither speaks SOCKS5 at all.

Sources: [hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel) · [Application.mk](https://github.com/heiher/hev-socks5-tunnel/blob/master/Application.mk) · [sockstun](https://github.com/heiher/sockstun) · [Outline SDK](https://github.com/OutlineFoundation/outline-sdk) · [xjasonlyu/tun2socks](https://github.com/xjasonlyu/tun2socks) · [badvpn (archived)](https://github.com/ambrop72/badvpn) · [sing-box LICENSE](https://raw.githubusercontent.com/SagerNet/sing-box/testing/LICENSE) · [v2rayNG .gitmodules](https://raw.githubusercontent.com/2dust/v2rayNG/master/.gitmodules)

---

## 4. The control channel

**Use `localabstract:`, not a TCP port.** `adb forward localabstract:<name>` reaches a `LocalServerSocket` in an ordinary installed app — SELinux explicitly permits it (`adbd.te`: `allow adbd appdomain:unix_stream_socket connectto`, with the in-source comment that this exists for `ndk-gdb`). Debuggability is irrelevant; `adbd` connects to the socket, it does not `run-as`.

It is better than `tcp:<port>` on four counts: no `INTERNET` permission, no device-side port collision between devices, unreachable from any network interface, and no filesystem artifact to clean up.

**Keep the host-side ownership check regardless.** The host port is still shared across devices, which is exactly the failure `ui-server/launcher.ts:57-71` already defends against. Reuse that code verbatim.

**The control channel survives VPN lockdown.** Two independent confirmations: every netd VPN routing rule sits at priority ≥ 10000 while the kernel `local` table owns `127.0.0.0/8` at priority 0, and the netd BPF lockdown drop is gated on `skb->ifindex != 1` (ifindex 1 = `lo`) with the in-source comment *"Drops packets not coming from lo"*. Android 17's new local-network permission also does not apply — its normative address list excludes `127.0.0.0/8` and `::1`, and it is scoped to broadcast-capable interfaces. **UNCONFIRMED as prose:** no doc *states* loopback is exempt; it is implied by the range list and confirmed in source. Add a `RESTRICT_LOCAL_NETWORK` smoke test on API 37+.

**`VpnService.protect()` is mandatory** on whatever socket carries tunnel traffic to the upstream SOCKS5 server, or its packets re-enter our own default route and loop forever. The docs say so explicitly.

Sources: AOSP `adbd.te` · [AOSP RouteController.h](https://android.googlesource.com/platform/system/netd/+/refs/heads/main/server/RouteController.h) · [AOSP netd.c BPF](https://android.googlesource.com/platform/packages/modules/Connectivity/+/refs/heads/main/bpf/progs/netd.c) · [Local network definition](https://developer.android.com/privacy-and-security/local-network-definition) · [VPN guide](https://developer.android.com/develop/connectivity/vpn)

---

## 5. Manifest and lifecycle

Foreground service type is mandatory from Android 14 or `startForeground()` throws `MissingForegroundServiceTypeException`.

**Use `specialUse`.** Its runtime prerequisites are "None", and the `<property>` subtype string only matters for Play Console review, which we never face. `specialUse` is also *not* on Android 15's list of types a `BOOT_COMPLETED` receiver may not start (`dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection`, `microphone`), and *not* subject to Android 15's 6h/24h timeout, which applies only to `dataSync` and `mediaProcessing`.

> ⚠️ **Flagged discrepancy — resolve on a device before writing the plan.** The two research passes disagreed about `systemExempted`. The [FGS types doc](https://developer.android.com/develop/background-work/services/fgs/service-types) lists "VPN apps" as qualifying, and `ForegroundServiceTypePolicy.java` shows `AppOpPermission(OP_ACTIVATE_VPN)` in its `anyOf` set; but a second reading of `ActiveServices.java`'s `SystemExemptedFgsTypePermission` allow-list found no `REASON_OP_ACTIVATE_VPN`, which would make `startForeground(systemExempted)` throw `ForegroundServiceTypeNotAllowedException`. **This does not need resolving to proceed — `specialUse` is safe either way — but do not declare `systemExempted` alone on the strength of the doc.**

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE"/>
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES"/>

<service android:name=".RouteVpnService"
         android:permission="android.permission.BIND_VPN_SERVICE"
         android:foregroundServiceType="specialUse"
         android:exported="true">
    <intent-filter><action android:name="android.net.VpnService"/></intent-filter>
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
              android:value="device_farm_test_route"/>
</service>
```

Note `BIND_VPN_SERVICE` is an `android:permission` **attribute on the service**, not a `<uses-permission>` — the system holds it, we do not.

`QUERY_ALL_PACKAGES` is needed only if per-app routing is wanted: `addAllowedApplication`/`addDisallowedApplication` throw `NameNotFoundException` for any package that is merely *invisible* under Android 11+ package visibility, which is indistinguishable from not installed. The docs restrict this permission for Play distribution only, which does not bind us.

Sources: [FGS types](https://developer.android.com/develop/background-work/services/fgs/service-types) · [Android 14 FGS types required](https://developer.android.com/about/versions/14/changes/fgs-types-required) · [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) · [VpnService.Builder](https://developer.android.com/reference/android/net/VpnService.Builder) · [Package visibility](https://developer.android.com/training/package-visibility)

---

## 6. Host provisioning sequence

```bash
adb -s <serial> install -r -g enkaku-guest-agent.apk
adb -s <serial> shell appops set <pkg> ACTIVATE_VPN allow      # §1.2 — pre-consent + FGS bg-start exemption
adb -s <serial> shell dumpsys deviceidle whitelist +<pkg>       # Doze exemption; shell holds the permission
adb -s <serial> shell am start -n <pkg>/.BootstrapActivity      # §1.3 — MUST clear the stopped state
adb -s <serial> forward localabstract:enkaku-guest-agent        # then verify ownership via `forward --list`
```

Notes on the flags, verified against AOSP rather than the docs:

- **`-r` is a modern no-op** — `case "-r": // ignore`; replace-existing is the default and `-R` disables it. Harmless to keep.
- **`-g` does not grant "all permissions"** despite what the doc says. It grants runtime (`dangerous`) permissions, `development`-flagged signature permissions, and `USE_FULL_SCREEN_INTENT` — nothing else. `ACTIVATE_VPN` is not a permission at all; it is a pure app op, which is why it needs the separate `appops` call.
- **`adb install` is NOT exempt from Play Protect** on a GMS device — `verifier_verify_adb_installs` defaults to 1. What adb skips is the *unknown sources* consent dialog, not the verifier. `adb shell settings put global verifier_verify_adb_installs 0` disables it (`@hide`, undocumented).
- **Unsigned APKs cannot be installed** (`INSTALL_PARSE_FAILED_NO_CERTIFICATES`); debug-signed APKs install fine on production devices.

For install verification prefer **`cmd package path <pkg>`** — fixed `package:` prefix, exit 1 when absent. Avoid `pm list packages <pkg>` for existence checks: **the filter is a substring match**, so `com.foo` matches `com.foo.bar`. (Our current `ui-server` launcher uses exactly this substring form at `launcher.ts:34-37` — safe today because the package name has no such sibling, but the new agent should use the stricter form.)

For VPN state, **have the agent report over the control channel** rather than parsing `dumpsys`. `dumpsys` output has no format contract, and `ConnectivityService` now lives in a **mainline module**, so its dump text can change via a Play system update without an OS version bump. Do not hardcode `tun0` either — the name is convention, not contract.

Optional, survives reboot: `settings put secure always_on_vpn_app <pkg>` + `always_on_vpn_lockdown 1`, then reboot (the value is read only at `Vpn` construction; there is no runtime observer). **UNCONFIRMED** that writing the secure setting directly takes effect — the documented route is `DevicePolicyManager.setAlwaysOnVpnPackage`, which requires being device owner and therefore a factory-clean device. Test before relying on it.

Sources: AOSP `PackageManagerShellCommand.java`, `PermissionManagerServiceImpl.java`, `PackageInstallerService.java`, `VerifyingSession.java` · [adb docs](https://developer.android.com/tools/adb) · [DevicePolicyManager](https://developer.android.com/reference/android/app/admin/DevicePolicyManager)

---

## 7. Build and repo cost

| Component | Current stable (Aug 2026) |
|---|---|
| AGP | **9.3.0** (Jul 2026), supports up to API 37 |
| Gradle | **9.6.1**; AGP 9.3 requires ≥ 9.5.0 |
| JDK | **17** — min *and* default for AGP 9.x |
| Kotlin | **2.4.10** |
| Build Tools | **36.0.0** (min & default for AGP 9.3) |
| NDK | r29 `29.0.14206865`; AGP 9.3 default `28.2.13676358` |

Headless builds are fully supported: `sdkmanager` + `./gradlew assembleRelease`, no Android Studio. The cmdline-tools layout is strict (`$ANDROID_HOME/cmdline-tools/latest/…`) and CI needs `yes | sdkmanager --licenses`.

**Repo integration.** `scripts/build-desktop.sh` is the precedent — a bash script that shells out to a non-JS toolchain (`cargo tauri build`); `./gradlew assembleRelease` drops into the same shape. `scripts/typecheck.sh` iterates a hardcoded package list and needs no change.

One real gotcha: **`apps/*` is a Bun workspace glob**, so `apps/guest-agent/` needs a minimal private `package.json` whose `build` script shells to `scripts/build-guest-agent.sh`, or Bun globs a directory with no manifest.

**Reproducible APK builds: do not attempt.** An APK's sha256 is not reproducible by default, and making it so is a multi-week project with permanent drag — non-deterministic ZIP entry ordering, R8 emitting a non-deterministic `pg-map-id`, JDK- and NDK-version-dependent output, embedded absolute build paths in native code, and F-Droid's report that newer `apksigner` versions break verifiable signing. **Instead: build once, publish the APK as a release artifact, and pin *that artifact's* sha256 in `packages/toolchain/manifest/enkaku-tools.json`** — precisely the model already used for `adb` and the `ui-server` APK. Build-once, pin-the-output.

Signing: `keytool` + Gradle `signingConfigs` reading a gitignored `keystore.properties`; keystore injected in CI as a base64 secret. minSdk 26 + Gradle gives v1+v2+v3 automatically, which is all sideloading needs. The v2-or-higher mandate keys off **`targetSdk >= 30`**, not minSdk — a common misreading.

Sources: [AGP 9.3.0 release notes](https://developer.android.com/build/releases/agp-9-3-0-release-notes) · [Gradle release notes](https://docs.gradle.org/current/release-notes.html) · [Kotlin releases](https://kotlinlang.org/docs/releases.html) · [NDK downloads](https://developer.android.com/ndk/downloads) · [sdkmanager](https://developer.android.com/tools/sdkmanager) · [Sign your app](https://developer.android.com/studio/publish/app-signing) · [APK signing](https://source.android.com/docs/security/features/apksigning) · [Android 11 behavior changes](https://developer.android.com/about/versions/11/behavior-changes-11) · [F-Droid reproducible builds](https://f-droid.org/docs/Reproducible_Builds/)

---

## 8. 🚩 Strategic risk — Android developer verification

Google's [developer verification](https://developer.android.com/developer-verification) programme requires apps installed on **certified Android devices** to come from verified developers, with enforcement beginning **September 2026** in selected regions. There is a "limited distribution" tier capped at *"up to 20 devices that end-users have explicitly authorized"*, plus an "advanced flow" for power users.

**Whether `adb install` is exempt is UNCONFIRMED** — the page does not say. A 20-device cap would be fatal to a device-farm product built on host-driven sideloading, and the date is imminent.

**This must be re-checked and answered before any commitment to building the app.** It is a larger risk to the plan than every technical item in this document combined, and it applies equally to the existing `ui-server` APK.

---

## 9. Scope recommendation: one agent, capability-negotiated

Build **one** app, `enkaku-guest-agent`, not a single-purpose proxy shim.

The provisioning cost is per-app, not per-feature: one install, one app-op grant, one stopped-state kick, one foreground service, one boot receiver, one manifest entry, one signing key, one CI job. A second app later doubles all of it, and the control channel design (a `localabstract` socket carrying typed request/response) is identical whatever it carries.

Guard each capability behind a negotiated flag so the host learns what a given agent build can do rather than assuming — the same honesty the registry already applies to driver engines. SOCKS routing is simply the first capability; the obvious later ones are on-device egress-IP reporting (which is what makes `probe()` in plan 33 truthful) and VPN up/down state.

Keep the VPN service dormant unless asked. Declaring a `VpnService` does not start one, and the `ACTIVATE_VPN` op is only granted on devices that need it — so a farm can run the agent everywhere while only a subset ever routes traffic.

---

## 10. Open questions for the plan that follows

1. **Developer verification (§8)** — blocking. Answer first.
2. `systemExempted` versus `specialUse` (§5) — resolve on a device; `specialUse` is the safe default.
3. Does writing `always_on_vpn_app` via `settings put secure` actually take effect after reboot (§6), or is a device-owner DPC required?
4. Where do SOCKS5 credentials live, and does the agent ever persist them or only hold them for the lifetime of a route?
5. **Answered (MVP 02 §4 phase 2, plan 221):** replace. The agent's `ui-tree` `AccessibilityService` becomes the default engine in plan 222; ui-server stays as the fallback for devices where the agent cannot be installed or its service cannot be enabled, and `uiautomator dump` is demoted to last resort.
6. Which Android versions form the supported matrix, and what is the per-release smoke test that pins the three undocumented behaviours (§1.1, §1.2, §6)?
