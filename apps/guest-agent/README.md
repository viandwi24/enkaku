# `enkaku-guest-agent`

The on-device helper app. It is installed on **every admitted farm device** by the core — not only devices with a proxy configured — driven entirely over adb, and has no user-facing controls beyond a status screen and a keyboard-switch button. The plan behind the original SOCKS5-only agent is [`docs/plans/43-m15b-guest-agent.md`](../../docs/plans/43-m15b-guest-agent.md); the verified platform research behind every decision here is [`docs/research/android-guest-agent.md`](../../docs/research/android-guest-agent.md). The plan that made it one app with four facets and mandatory on every phone is [`docs/plans/90-m55-unified-guest-agent.md`](../../docs/plans/90-m55-unified-guest-agent.md).

> **Status:** working end to end in software, and verified on Android 15 hardware for the original route facet: the agent installs unattended, the control channel answers, and a SOCKS5 full tunnel with username/password carries real traffic — confirmed by Android's own `IS_VALIDATED` connectivity check passing *through* the tunnel. Plan 90's three newer facets (mandatory provisioning, the keyboard, the screen label) are implemented and unit-tested but **not yet confirmed on real hardware** by this pass — see `docs/plans/90-m55-unified-guest-agent.md`'s consolidated hardware-pending table for the exact commands. Known rough edges on the route facet are in [`docs/plans/44-m15v-proxy-end-to-end.md`](../../docs/plans/44-m15v-proxy-end-to-end.md) §8b.

## One app, four facets — and the rule that decides what goes in it

The agent is not a grab-bag: a capability belongs in this app **only if it needs to run as an ordinary Android app** — a system API with no shell equivalent, or state that must survive the host going away. The agent's only channel to the host is `adb forward` over the same transport `adb shell` already uses (plan 90 F37), so it can never reach *further* than the shell — only *differently*. Everything the shell can already do belongs on the host side, not in this APK (plan 90 §3.1).

| Facet | Capability string | What it needs that adb alone cannot do |
|---|---|---|
| **Route** | `socks5-route`, `vpn-status`, `egress-probe`, `route-hold` | `VpnService` is the only enforcing rung — an app under test cannot opt out of it, unlike `settings put global http_proxy` |
| **Screen label** | `screen-label` | `WallpaperManager.setBitmap` has no shell equivalent; `wallpaper` is not an `adb shell` command on stock Android |
| **Text input** | `text-input` | Only an `InputMethodService` commits arbitrary Unicode into whatever field has focus, on any input engine, without touching the clipboard |
| **Mock location** | `mock-location` | The test-provider API needs an app registered as the device's mock-location provider |

Two candidates were considered and **rejected** by the same rule, and built host-side instead: an on-device gallery (the shell can write under `/sdcard/Pictures/…` and tell `MediaStore` with one `content call`, so no APK is needed — `packages/core/src/device/transfer.ts`'s `mediaScan`) and an on-device monitoring pipe (everything it could report while adb is up is already streamed by the host; when adb is down the agent is unreachable by construction, same as everything else here). See plan 90 §3.1, §3.4, §3.5 for the full reasoning.

Four facets sharing one package is not just convenience: they share one provisioning story (one install, one appops pass, one bootstrap, one `hello`), one authenticated channel with one lifetime (`withEphemeralSession`), and one honest state (`hello().capabilities` tells the host what a build can do, so the fleet page never needs four independent is-it-installed probes).

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

Artifact: `app/build/outputs/apk/<variant>/app-<variant>.apk`, except an unsigned local `release` build (no `ENKAKU_GUEST_AGENT_KEYSTORE_PATH` — true for every local dev build, since that variable is CI-only), which Gradle names `app-release-unsigned.apk` instead; the build script checks both.

The release build is small on purpose: `StatusActivity` is a plain `Activity` with a hand-written XML layout, not Compose, and R8 (`isMinifyEnabled = true`) is on — Compose plus its `material3`/`ui`/tooling dependency graph used to be 21.3 MB of a 21.7 MB release APK for one screen with three lines of text (plan 90 §3.11). A local release build today measures **~1.1 MB** unsigned, with `classes.dex` down from ~21.2 MB to ~100 KB; the native tunnel library is unchanged at 849 KB across all three ABIs. `app/proguard-rules.pro` keeps `Tun2Socks` and its three native methods by name, plus the four manifest-declared components and `EnkakuIme`. **`Tun2Socks` is the one keep rule that must never be relaxed or forgotten**: the native library resolves its Kotlin peer with `FindClass(PKGNAME "/" CLSNAME)` at load time — a JNI call with no compile-time reference R8 (or a human editing this file) can see. A build that strips or renames `Tun2Socks` compiles cleanly, links cleanly, and installs cleanly; it fails only when the native library actually loads **on the phone**, with no compiler error and no stack trace pointing at the real cause — the exact "silent on the phone, not at build" failure mode this file exists to prevent. Verified for real, not assumed: after an actual R8 pass, `unzip -p app-release-unsigned.apk classes.dex | strings | grep -i tun2socks` still shows `Tun2Socks` and its native method names by their exact spelling.

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

> Tier 3 is wired (plan 90 §90.1, closing plan 43 §5.5/§5.11): `packages/toolchain/manifest/enkaku-tools.json` carries a `guest-agent` entry — `swappable: false`, like `scrcpy-server`, since the wire contract is shared with the core — and `.github/workflows/release.yml` builds, signs and publishes the APK on a `v*` tag, printing its sha256 and failing the job above a declared size budget. **Tier 3 cannot fire yet on a real release**: the manifest's `version`, the download `sha256`/`url`, and `deviceArtifact.versionCode` are all `TODO-*`/`0` sentinels (the schema's designed "parses but `install()` refuses it" escape hatch — see `ToolArtifactSchema` in `packages/toolchain/src/types.ts`), so `resolveToolPath('guest-agent')` fails closed with `E_CHECKSUM_MISSING` — a named, reported `failed` state, never a crash and never a silent `absent` — until the owner publishes a signed release and updates these fields by hand, exactly as `adb`'s manifest entry is updated whenever Google ships a new platform-tools release. Until then, a deployed server can still provision the agent via tier 1 (`ENKAKU_GUEST_AGENT_PATH`) or tier 2 (a local Gradle build sitting beside the checkout); only tier 3 is blocked.
>
> **The first signed release needs two tag pushes, not one**, because the manifest that must contain the APK's own sha256 lives in the same repo being tagged — the first tag cannot describe an artifact it has not built yet:
>
> 1. Push any `v*` tag (e.g. `v0.1.8`). `.github/workflows/release.yml`'s `build-guest-agent` job builds and signs the APK, derives `versionCode` from the tag, and prints its size and sha256 to the job log; the release's `SHA256SUMS.txt` also carries the hash, and `guest-agent.apk` is attached to that release as a downloadable asset.
> 2. Read the printed sha256 and size, and update `packages/toolchain/manifest/enkaku-tools.json`'s `guest-agent` entry by hand: `version` (a real value, not `TODO-first-release`), `versions[0].platforms.*.url` (the release asset's download URL), `versions[0].platforms.*.sha256`, `versions[0].platforms.*.sizeBytes`, and `deviceArtifact.versionCode` (the same `versionCode` the job derived from the tag). Commit this change.
> 3. Push the **next** `v*` tag (e.g. `v0.1.9`). Its core binaries now embed a manifest that correctly resolves tier 3 for the guest-agent APK published by the *first* tag — the manifest deliberately lags one release behind the agent build it pins, the same way it would for any tool whose own release has to exist before it can be checksummed. Repeat steps 1–3 whenever the pinned agent build needs to move forward.

## Text input (the keyboard)

`text-input` gates `text.commit`/`text.status` — the `EnkakuIme : InputMethodService` in `input/EnkakuIme.kt` (`input/TextFacet.kt` is what `ControlService` calls into it through). It commits through `currentInputConnection.commitText`, one code point at a time when the host asks for per-character timing, whole-string otherwise, and touches no clipboard. It is the top rung of the host's three-rung text ladder (`packages/session/src/text-input.ts`'s `resolveTextRoute` — see `packages/drivers/README.md` for the other two rungs and how to read `via`).

**Activation, exactly two shell calls, no user tap:**

```bash
adb shell ime enable dev.enkaku.guestagent/.input.EnkakuIme
adb shell ime set    dev.enkaku.guestagent/.input.EnkakuIme
```

Switching the default IME needs **no permission at all** — `BIND_INPUT_METHOD` is granted to the service by the system, the same way `BIND_VPN_SERVICE` is granted to the route facet. It is device-visible state, though, so the host applies the same discipline `prep.rotation`/`prep.keepAwake` already use (`packages/session/src/session.ts`'s `applyTextInput`, template: `orientation.ts`): read `settings get secure default_input_method` **before** touching anything, apply at session start, and on close run `ime set <the value that was read>` — idempotent on a second close, and left untouched (never guessed) if the prior value could not be read. A `SIGKILL`ed core skips the revert on that one session, exactly like every other prep-scoped setting in this codebase — the device is never left wedged (the keyboard's own visible strip has a **Switch keyboard** button that opens the system picker), but the literal pre-session IME is only recovered if nothing else changed it in between.

A human physically holding the phone during a session sees `EnkakuIme`'s own one-line view — *"Enkaku input — driven by the farm host"* — instead of a dead keyboard with no explanation, plus that same **Switch keyboard** button.

## Screen label

`screen-label` gates `label.apply`/`label.status`/`label.clear` (`label/LabelRenderer.kt` draws the bitmap, `label/WallpaperFacet.kt` applies it through `WallpaperManager`) — a solid black wallpaper with the device's name above its number, both centred, so an operator standing in front of many identical phones can tell them apart. Built by plan 90 step 90.5+ (a facet plan 89 asked for and no numbered step in either plan had actually been assigned — see that plan's own note) against the exact contract plan 89 §4.5 specifies: `applied` reports what surface actually took (an OEM that swallows the lock screen produces `['home']`, never a lie); an unchanged fingerprint is a cheap no-op; the original wallpaper is captured once and `originalCaptured` is reported honestly; `label.clear` is idempotent; `rendererVersion` is an integer the agent owns.

**The device side is complete; nothing on the host calls it yet.** `packages/core/src/device/labelling.ts` — the host-side service that computes the fingerprint and decides when to call these verbs — is plan 89 §4.6's own work and has not been built (plan 89 is still `not started`; only plan 90's on-device contract has shipped). Driving `label.apply` today needs a short script against `packages/drivers/src/network/guest-agent/client.ts`'s `createGuestAgentClient` directly.

`SET_WALLPAPER` is a normal, install-time permission (already in `AndroidManifest.xml`) — unlike the route facet's `ACTIVATE_VPN` or mock location's `android:mock_location`, it needs no `appops` step.

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

`app/build.gradle.kts`'s release `signingConfig` is entirely env-driven and only activates when `ENKAKU_GUEST_AGENT_KEYSTORE_PATH` is set — unset (every local dev build) produces the same unsigned artifact this app has always built locally, no keystore needed. `.github/workflows/release.yml` decodes `secrets.GUEST_AGENT_KEYSTORE_BASE64` to a file and sets four env vars before invoking Gradle:

| Env var | Value |
|---|---|
| `ENKAKU_GUEST_AGENT_KEYSTORE_PATH` | Path to the decoded `.jks` file |
| `ENKAKU_GUEST_AGENT_KEYSTORE_PASSWORD` | The keystore's store password |
| `ENKAKU_GUEST_AGENT_KEY_ALIAS` | The signing key's alias |
| `ENKAKU_GUEST_AGENT_KEY_PASSWORD` | The signing key's password |

These four GitHub repo secrets (`GUEST_AGENT_KEYSTORE_BASE64` plus the three passwords/alias) do not exist yet — generating the production keystore and adding them is an owner action, not something this plan automates. Once a real keystore is in place, `packages/toolchain/manifest/enkaku-tools.json`'s `guest-agent` entry needs its `deviceArtifact.signatureSha256` set to that keystore's certificate SHA-256 (`apksigner verify --print-certs <apk>`, uppercased, colon-free) — the value only `verifyDeviceArtifact` on the device side ever checks against, so it must match whatever keystore CI actually signs releases with, not an arbitrary placeholder.

**The `signatureSha256` committed today is provisional, not a placeholder to ignore.** It is real in shape and in origin — `BAA2B36DD52BE50EAE2036404E130065EBF3836D904A6137D740FBE378EDB32F`, read back from an actual keystore generated for plan 90 step 90.1 (`keytool -genkeypair`, then `apksigner verify --print-certs` against a release APK actually built and signed with it) — but that keystore is **not** a production signing identity and is not committed anywhere in this repository. Before cutting a real release, the owner must either (a) adopt this exact keystore as `GUEST_AGENT_KEYSTORE_BASE64` (handed off out of band, never printed in this document or committed to git), or (b) generate a fresh production keystore and update `signatureSha256` here to match it. **Signing a real release with a keystore whose certificate hash does not match this field will make every device report `signature_mismatch` forever** — `AgentProvisioner` reads that as a `failed` state (never a crash, never a stale `ready`, per plan 90 §3.8's failure policy), but it is a fleet-wide outage that is entirely avoidable by checking this one field before the first real tag.
