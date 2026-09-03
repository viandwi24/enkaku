# MVP 10 — Guest agent APK: new facets and a complete status screen

> Status: decided in direction (CEO, 2026-09-03); scope proposed here.
> As stated by the CEO: update the guest agent APK for the keyboard work discussed in 08, and refresh its screen so it shows complete status and is more informative.
> Related: MVP 02 §4 phase 2 (first-party inspector), MVP 04 (device activities), MVP 08 (Device Control), MVP 09 §4 (APK in the release), `apps/guest-agent/README.md`, `docs/plans/43`, `90`, `docs/research/android-guest-agent.md`.

---

## 0. What the APK is today

One app, four facets, provisioned unattended over adb on every admitted device: route (`VpnService` SOCKS5 tunnel), screen label (wallpaper), text input (`EnkakuIme`, `text.commit`), mock location. Capabilities advertised by `hello()` (`control/Protocol.kt:52`). Version is stamped from the environment at build time (`versionCode` default 1, `versionName` default `dev`), pinned by the toolchain manifest, and not yet built by the release workflow.

`StatusActivity` is the only human-facing screen: a banner with the single worst thing that is true, then sections Farm link, Route, Checks, Keyboard, This build, plus Refresh, Copy report, and Switch keyboard. It re-reads itself every 2 s, never overstates, shows no secrets, omits rows it has no fact for, and is built without Compose to keep the APK small (README, "The status screen").

The rule for what goes in the APK stays: **only what needs to run as an ordinary Android app**, a system API with no shell equivalent or state that must survive the host going away.

## 1. New facets

### 1.1 `ui-tree` (MVP 02 phase 2)

An `AccessibilityService` exposing the window tree over the existing control channel. Methods: `ui.dump` (full tree, same node schema as today), `ui.find` (selector, on-device match), `ui.watch` (subscribe to `TYPE_WINDOW_CONTENT_CHANGED` so the host's `waitFor` is push, not poll). Enabled from adb through `settings put secure enabled_accessibility_services` and `accessibility_enabled`; to be verified on the lab device on Android 13+ where restricted-settings prompts exist for sideloaded apps (adb installs are exempt, which is the expectation to confirm). Passes the APK rule: `AccessibilityNodeInfo` has no shell equivalent that survives without `am instrument`.

### 1.2 `text-input` extended for Device Control (MVP 08)

The keyboard passthrough itself is UHID through scrcpy and needs nothing from the agent. The agent's IME gains what UHID cannot do:

- `text.commit` for non-Latin scripts, emoji, and long paste, as today.
- `text.status` reports whether a field is focused and whether the soft keyboard is showing, so Device Control can show the right hint.
- A per-device preference for "show soft keyboard while a hardware keyboard is connected", applied by the IME so the operator's choice survives sessions.

### 1.3 `activity` (MVP 04, read-only mirror)

The host pushes the device's activity list (`control`, `job`, `install`, `transfer`, `prep`) to the agent whenever it changes, and the agent keeps the last copy. Nothing on the device acts on it; it exists so the phone's own screen can say what the farm is doing to it. When the host has been silent longer than the control-channel timeout, the screen says "no contact from the farm for N s" and the list is shown as stale, never as current.

## 2. The status screen, complete

Same rules: never overstate, no secrets, omit unknown rows, no Compose, 2 s refresh, Copy report. New layout, top to bottom:

| Section | Rows |
|---|---|
| **Banner** | The single worst thing true right now, as today. When nothing is wrong: "Connected to farm `<name>`, idle" or "Connected, running `tiktok/login`". |
| **Now** (new) | The activity list from §1.3: "Controlled by Rani, last input 3 s ago", "Job #482 tiktok/login, running 1 m 20 s", "Installing app.apk 40 %". Stale marker when the host is silent. |
| **Device** (new) | Farm label and number (the same as the wallpaper label), cluster, tags, stable id, model, Android version, battery level and charging state, screen state. |
| **Farm link** | Paired or not and when; channel listening; last contact and method; requests served; last refused request and code. As today. |
| **Video** (new) | Whether a scrcpy server process is running on this device and at what resolution and fps it was started, read from the process list. Not a claim that anyone is watching. |
| **Inspector** (new) | `ui-tree` service enabled or not, watching or idle, last dump time and node count, last error. |
| **Route** | Lifecycle state, upstream host and port, fail-closed policy, last error, bytes each way, VPN consent, what Android itself reports. As today. |
| **Checks** | IPv6, dead-man's switch, last egress probe per leg. As today. |
| **Keyboard** | `EnkakuIme` selected, enabled, or absent; field focused; soft keyboard showing; hardware-keyboard preference. |
| **Label** | Whether the farm label wallpaper is applied and to which surfaces, renderer version. |
| **Location** | Whether mock location is active and the last coordinate set, rounded. |
| **This build** | versionName, versionCode, wire protocol, capabilities, package. As today, plus **"host expects version X"** when the last `hello` from the farm carried a newer pin, so an outdated agent says so itself. |

Buttons: Refresh, Copy report, Switch keyboard, and one new: **Open accessibility settings** (for the case where §1.1 could not be enabled from adb on that OEM).

## 3. Release and versioning

- The release workflow builds the APK, signs it with the release key, computes the sha256, and writes the pin into the toolchain manifest in the same commit as the core release (closes plan 43 §5.11). A core release never ships with an agent pin it did not build.
- `versionCode` increments on every release; the host's provisioning compares `hello().versionCode` with the pin and re-installs when lower. The status screen's "host expects version X" row is the human-visible side of the same comparison.
- Capabilities added: `ui-tree`, `activity`. The host treats an agent without them as an older build, not as an error.

## 4. Hardware verification

Everything in §1 and §2 is verified on the lab device (Android 16) and spot-checked on the owner's farm before the MVP is called done: accessibility enablement from adb, `ui.watch` event latency, the IME preference surviving a reboot, the status screen's Now section going stale when the core is stopped.

## 5. Removed

The single-line `EnkakuIme` strip stays. Nothing in the current APK is removed; the four facets remain. The `TODO-M4.5` `compatibleCoreRange` on the ui-server manifest entries becomes irrelevant once `ui-tree` is the default engine; ui-server remains the fallback until the field says otherwise (MVP 02 §4 phase 2).
