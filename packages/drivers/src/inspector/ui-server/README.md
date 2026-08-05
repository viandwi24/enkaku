# The `ui-server` inspector engine

A persistent instrumentation server on the device (the [openatx/uiautomator2](https://github.com/openatx/android-uiautomator-server) pattern): it starts once per session, and selector queries execute **on the device** over a local JSONRPC endpoint reached through `adb forward`.

Why it exists: `uiautomator dump` takes 0.5–2 seconds per query and fails while the UI keeps changing ("could not get idle state"). Since `waitFor` is inspector polling, the inspector's speed sets the speed of the entire scripting framework.

## Shape

| Part | File | Contents |
|---|---|---|
| Client | `client.ts` | HTTP/JSONRPC to `127.0.0.1:<localPort>`; the **method subset is deliberately narrow** so moving to our own APK stays cheap |
| Launcher | `launcher.ts` | verifies, installs (and repairs) the APKs (app + test), `am instrument`, `adb forward` |
| Verifier | `verify.ts` | reads `dumpsys package` and compares versionCode/signature against the toolchain manifest (plan 41) |
| Watchdog | `watchdog.ts` | `starting → healthy ⇄ restarting(n) → dead` |
| Selector | `selector.ts` | Enkaku selector → uiautomator UiSelector |
| Find guard | `find-guard.ts` | rejects a viewport-sized container as an answer to a specific selector (plan 60) |
| Inspector | `index.ts` | implements `Inspector` and `InspectorElementActions` |

The APK is pinned to a specific version and managed by the Toolchain Manager (`swappable: false`, checksum required) — the client↔server protocol is coupled, exactly as scrcpy-server is treated.

## Why the watchdog is mandatory

Instrumentation dies easily: the low-memory killer, vendor battery optimisation (Xiaomi and Oppo are aggressive), a user force-stop, or **another tool seizing UiAutomation — `uiautomator dump` itself included**. That is why `ui-server` and `uiautomator-dump` must never be active in the same session; the `instrumentation` lock in the engine descriptor enforces it.

## On-device artifact verification (plan 41)

`pm list packages` only proves *a* package with the right name is installed — not that it is the build we shipped. `launcher.ts`'s `ensureInstalled()` instead calls `verify.ts`'s `verifyDeviceArtifact()`, which reads `dumpsys package com.github.uiautomator` and compares the reported `versionCode` (and, when the manifest records one, the signing certificate's SHA-256) against the toolchain manifest's `deviceArtifact` expectation for the active `ui-server` version.

- No expectation recorded (an older manifest) → the check verifies installed-presence only and never blocks the inspector.
- A mismatch (wrong version or wrong signing certificate) → `pm uninstall`, reinstall, re-verify **once**. If it still mismatches, `ensureInstalled()` throws, `onMismatch` fires (the core records `device.artifact.mismatch` on the Plan 18 main stream), and the session falls through to the `uiautomator-dump` fallback below — it does not retry a second time, so a device where something keeps reinstalling a conflicting package cannot burn farm time forever.
- A signature line `dumpsys package` cannot make sense of is `unreadable`, treated the same as "skip" — Android's output for signatures is not stable across versions/OEMs, and a false mismatch would be worse than not checking at all.

## The find guard (plan 60 §3.1)

Measured on a moto g06 power: `find({ id: 'com.android.chrome:id/url_bar' })` came back as a `FrameLayout` covering the whole 720×1640 screen, `clickable: false`, while the Inspect panel dumping the same screen at the same moment showed that id as an `EditText` at the top. `tap` aims at a node's centre, so the tap landed in the middle of the page — on an advertisement — and every assertion after it measured a different page. The job was green.

So `find` checks the answer it was handed: a node whose bounds cover **≥ 95% of the viewport's area** is a container, not a match for a specific selector, and `find` returns `null` — the same answer it already gives for a genuine miss, so callers need no new branch. The rejection is logged once per selector at `warn` (once, because `waitFor` polls this path every 80 ms).

- Area, not an exact match: a node one pixel short of the full screen is the same container. Comparing areas also makes rotation a non-case.
- Bounds only. `clickable` is deliberately not part of it: `find` cannot know whether its caller is about to tap, and the value a script most wants to read may well be inert.
- `{ point }` selectors never reach the guard — a point is a coordinate, not a claim about a node.
- The viewport comes from `screenSize()`, supplied by the caller (`@enkaku/session`'s `inspector-factory.ts` reads `wm size`) and cached for the inspector's lifetime — one probe per session, nothing per find. With no screen size the guard stays off rather than guessing.
- A caller that genuinely wants the root node can `dump()` and read it.

## Fallback

If startup fails or the watchdog gives up, the session is **still created** with `uiautomator-dump`, along with a `device.inspector.fallback` WS event. The `devices.inspection` column is left untouched (the fallback is per-session, not permanent), so the next session tries `ui-server` again.

## Limits worth knowing

- **WebView and hybrid apps**: elements are only visible as far as the accessibility tree exposes them, and many surface as generic nodes. `setText` into a WebView input is far more reliable than injecting keystrokes — that is this engine's real advantage. Full WebView inspection (DOM, context switching) needs Appium (opt-in, M8).
- **The JSONRPC method names** in `client.ts` follow the pinned APK; re-verify them against a physical device whenever the APK version moves.
