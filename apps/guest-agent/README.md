# `enkaku-guest-agent`

The on-device helper app. It is installed on farm devices by the core, driven entirely over adb, and has no user-facing controls — the single screen exists so a human holding the phone can tell what it is.

Its first capability is an **enforcing SOCKS5 route**: a `VpnService` that apps under test cannot opt out of, which is what `settings put global http_proxy` can never provide. The plan is [`docs/plans/43-m15b-guest-agent.md`](../../docs/plans/43-m15b-guest-agent.md); the verified platform research behind every decision here is [`docs/research/android-guest-agent.md`](../../docs/research/android-guest-agent.md).

> **Status:** working end to end. Verified on Android 15 hardware: the agent installs unattended, the control channel answers, and a SOCKS5 full tunnel with username/password carries real traffic — confirmed by Android's own `IS_VALIDATED` connectivity check passing *through* the tunnel. Known rough edges are in [`docs/plans/44-m15v-proxy-end-to-end.md`](../../docs/plans/44-m15v-proxy-end-to-end.md) §8b.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| **JDK 17** | 17.x | Minimum *and* default for AGP 9. Newer JDKs are not a drop-in substitute. |
| **Android CLI** | ≥ 1.0 | Google's official CLI. Owns SDK installation and project scaffolding. |
| **Android SDK** | platform 36, build-tools bundled | Installed by the Android CLI, not by hand. |

```bash
brew install openjdk@17                              # keg-only, no sudo needed
brew tap android/tap && brew install --cask android-cli
```

The Homebrew `temurin@17` cask also works but installs system-wide and needs `sudo`. `openjdk@17` is keg-only and does not, which is why the build script looks for it at `/opt/homebrew/opt/openjdk@17/…` when `JAVA_HOME` is unset.

The Android SDK lands in `~/Library/Android/sdk` and its path is written to `local.properties`, which is gitignored. In CI, set `ANDROID_HOME` instead.

## Build

```bash
bun run build:guest-agent          # release
bun run --cwd apps/guest-agent build:debug
```

Both call [`scripts/build-guest-agent.sh`](../../scripts/build-guest-agent.sh), which resolves the JDK, checks the SDK, runs Gradle, and prints the artifact's sha256 — that hash is what gets pinned in the toolchain manifest.

Artifact: `app/build/outputs/apk/<variant>/app-<variant>.apk`.

## How the APK reaches a device

Nothing is trusted unless its checksum matches — the same discipline adb and the `ui-server` inspector go through. The core resolves the APK in **three tiers, first match wins**:

| Tier | Source | When it applies |
|---|---|---|
| 1 | `ENKAKU_GUEST_AGENT_PATH` | An explicit override — a one-off build, or CI |
| 2 | `app/build/outputs/apk/{release,debug}/` | A checkout with a local Gradle build. **This is why `bun run dev` needs no configuration.** Logs a warning, because a stale local build silently beating a published release wastes an afternoon |
| 3 | Toolchain Manager | A deployed server: downloaded from a pinned GitHub release and sha256-verified into `<dataDir>/tools/guest-agent/<version>/guest-agent.apk`, exactly like adb and the ui-server inspector |

Tier 2 cannot fire on a deployed server — a compiled binary has no `apps/` directory beside it — so no mode flag is needed. The APK is **never auto-built**: Gradle needs a JDK and the Android SDK and takes minutes, so a missing APK fails with instructions rather than starting a surprise build.

Then it is installed with `adb install -r -g`, the `ACTIVATE_VPN` app op is granted, and the agent is bootstrapped.

**The APK is never committed to this repository.** Download-and-verify is the whole point of the Toolchain Manager, and a binary in git defeats it.

> Tier 3 is wired but not yet live: the `guest-agent` manifest entry and the CI job that publishes a signed release are plan 43 §5.5 and §5.11, deliberately deferred so the manual test did not have to wait for a release.

## Driving it without Studio

`scripts/guest-agent.ts` is the reproducible form of the device bring-up, useful when debugging the agent itself:

```bash
bun scripts/guest-agent.ts install  --serial <SERIAL>
bun scripts/guest-agent.ts route    "socks5://user:pass@host:1337" --serial <SERIAL>
bun scripts/guest-agent.ts status   --serial <SERIAL>
bun scripts/guest-agent.ts stop     --serial <SERIAL>
bun scripts/guest-agent.ts uninstall --serial <SERIAL>
```

It is a temporary developer tool, not part of the product — delete it once the Studio path is complete.

## Smoke test

`scripts/smoke-guest-agent.ts` is the real test suite for this app: install, permissions, pre-grant, bootstrap, token rotation, an ANR check, routing, egress, an error-frame check, interleaving, fail-closed via the dead-man's switch, recovery, fail-closed via a dead upstream, uninstall, and teardown — fifteen stages, each asserting on what the device reports. It supersedes `scripts/guest-agent.ts` for anything beyond ad hoc debugging; see [`docs/plans/50-m24a-ci-and-device-smoke-test.md`](../../docs/plans/50-m24a-ci-and-device-smoke-test.md) and [`docs/plans/51-m24b-verified-egress-and-fail-closed.md`](../../docs/plans/51-m24b-verified-egress-and-fail-closed.md) §5.9 for why each stage exists.

```bash
ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <SERIAL>
```

Add `ENKAKU_SMOKE_PROXY=socks5://user:pass@host:port` to also run the routing stages (7-13); without it they print a skip line rather than failing. Add `ENKAKU_SMOKE_PROBE_URL=<a packages/probe-server /probe URL, reachable through that proxy>` for stage 8's real `egress.probe` assertion — without it, stage 8 falls back to the `dumpsys connectivity` VALIDATED signal alone. `--serial` is mandatory — it never guesses which attached device to drive. Not run in CI: GitHub runners have no phone attached, so this stays a local (or eventually self-hosted-runner) command.

## Project layout

Scaffolded with the official tool, not by hand:

```bash
android create --name="Enkaku Guest Agent" --minSdk=26 -o apps/guest-agent empty-activity   # minSdk later raised to 29, see below
```

Then the package was renamed from the template default to `dev.enkaku.guestagent` (matching `dev.enkaku.desktop`), the sample navigation code was removed, and `MainActivity` became `BootstrapActivity`.

`gradle init` cannot do this — it has no Android project type and never has. Android Studio's wizard was the only official path until Android CLI reached 1.0 in May 2026.

| Path | Contents |
|---|---|
| `app/src/main/java/dev/enkaku/guestagent/` | Kotlin sources |
| `app/src/main/AndroidManifest.xml` | Components and permissions |
| `gradle/libs.versions.toml` | Version catalog — the single source of dependency versions |
| `gradle/wrapper/` | Pinned Gradle distribution, with `distributionSha256Sum` set |

Current versions, as generated by the template (not the newest available — these are what the official scaffold pins, and drifting from them without reason is how builds break):

| | Version |
|---|---|
| Android Gradle Plugin | 9.0.1 |
| Gradle | 9.1.0 |
| Kotlin | 2.3.20 |
| compileSdk / targetSdk | 36 |
| minSdk | 29 |
| Java toolchain | 17 |
| NDK | r29 (`29.0.14206865`) |
| `hev-socks5-tunnel` | tag 2.16.0 (MIT), submodule under `third_party/` |

minSdk is 29 rather than the 26 the scaffold defaulted to, because `hev-socks5-tunnel`'s own `Application.mk` pins `APP_PLATFORM := android-29` — that is the floor upstream tests. Farm devices older than that report `unsupported` in Studio instead of failing at runtime.

The native library is built by `ndk-build` through Gradle's `externalNativeBuild`, restricted to the shared-library target. Its JNI layer resolves its Kotlin peer by name at load time — `FindClass(PKGNAME "/" CLSNAME)`, supplied as `-DPKGNAME=dev/enkaku/guestagent/route -DCLSNAME=Tun2Socks` — so **renaming or moving `Tun2Socks` breaks the native library with no compile error.** Change the class and the build flag together.

After cloning this repo you need the submodule and its nested ones:

```bash
git submodule update --init --recursive
```

## Gotchas that cost real time

**`BootstrapActivity` must be `singleTop`, and `onNewIntent` must be handled.** The host re-bootstraps with a fresh token on every operation. Under the default `standard` launch mode an `am start` aimed at an activity already on top merely brings its task forward — *neither* `onCreate` nor `onNewIntent` runs — so the first token sticks forever and every later one is dropped, leaving the agent answering `E_UNAUTHORISED` while looking perfectly healthy. Both halves are required; either alone does nothing.

**`Tun2Socks` cannot be renamed or moved.** The native library resolves its Kotlin peer at load time with `FindClass(PKGNAME "/" CLSNAME)`, both supplied as `-D` flags from `app/build.gradle.kts`. Renaming the class breaks the library **with no compile error**.

**A cold start is slower than a warm one.** The control socket binds a moment after the process starts, and after `install -r` or a `force-stop` that gap is wide enough that a fixed sleep is not enough. Retry the handshake instead of guessing at a delay.

## Why `BootstrapActivity` must stay exported

Two platform behaviours make this non-negotiable, both verified against AOSP:

**`adb shell am` cannot reach a component declared `exported="false"`.** Only root and system bypass the export check; the shell user is neither. Worse, `am broadcast` fails *silently* — it prints `Broadcast completed: result=0` and exits 0 while the receiver is skipped. An unexported entry point would be unreachable from the farm, and nothing would report the failure.

**A freshly installed app sits in the stopped state and receives no broadcasts at all**, including `BOOT_COMPLETED`. Launching this activity once after install is what clears that state. Skip it and the agent never comes back after the device's first reboot.

Because the component must be exported, authorisation lives in the payload: the host passes a random token as an intent extra, and the control channel rejects any request that does not carry it. A `signature`-level permission would not work — it would block the shell too, since the shell is not signed with our key.

## Signing

`*.jks`, `*.keystore`, and `keystore.properties` are gitignored. Keep the keystore out of the repository and inject it in CI as a base64 secret. minSdk 29 plus Gradle's `signingConfigs` produces v1+v2+v3 signatures, which is everything sideloading needs — the v2-or-higher mandate keys off `targetSdk >= 30`, not minSdk.
