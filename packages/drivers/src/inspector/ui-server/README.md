# The `ui-server` inspector engine

A persistent instrumentation server on the device (the [openatx/uiautomator2](https://github.com/openatx/android-uiautomator-server) pattern): it starts once per session, and selector queries execute **on the device** over a local JSONRPC endpoint reached through `adb forward`.

Why it exists: `uiautomator dump` takes 0.5–2 seconds per query and fails while the UI keeps changing ("could not get idle state"). Since `waitFor` is inspector polling, the inspector's speed sets the speed of the entire scripting framework.

## Shape

| Part | File | Contents |
|---|---|---|
| Client | `client.ts` | HTTP/JSONRPC to `127.0.0.1:<localPort>`; the **method subset is deliberately narrow** so moving to our own APK stays cheap |
| Launcher | `launcher.ts` | installs the APKs (app + test), `am instrument`, `adb forward` |
| Watchdog | `watchdog.ts` | `starting → healthy ⇄ restarting(n) → dead` |
| Selector | `selector.ts` | Enkaku selector → uiautomator UiSelector |
| Inspector | `index.ts` | implements `Inspector` and `InspectorElementActions` |

The APK is pinned to a specific version and managed by the Toolchain Manager (`swappable: false`, checksum required) — the client↔server protocol is coupled, exactly as scrcpy-server is treated.

## Why the watchdog is mandatory

Instrumentation dies easily: the low-memory killer, vendor battery optimisation (Xiaomi and Oppo are aggressive), a user force-stop, or **another tool seizing UiAutomation — `uiautomator dump` itself included**. That is why `ui-server` and `uiautomator-dump` must never be active in the same session; the `instrumentation` lock in the engine descriptor enforces it.

## Fallback

If startup fails or the watchdog gives up, the session is **still created** with `uiautomator-dump`, along with a `device.inspector.fallback` WS event. The `devices.inspection` column is left untouched (the fallback is per-session, not permanent), so the next session tries `ui-server` again.

## Limits worth knowing

- **WebView and hybrid apps**: elements are only visible as far as the accessibility tree exposes them, and many surface as generic nodes. `setText` into a WebView input is far more reliable than injecting keystrokes — that is this engine's real advantage. Full WebView inspection (DOM, context switching) needs Appium (opt-in, M8).
- **The JSONRPC method names** in `client.ts` follow the pinned APK; re-verify them against a physical device whenever the APK version moves.
