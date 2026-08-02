# @enkaku/drivers

Implementations of the four driver layers (spec §7): Transport / DisplaySource / InputSink / Inspector.

## M2 engines

| Engine | Layer | Notes |
|---|---|---|
| `adb-usb` | transport | Wraps @enkaku/adb; every exec goes through the per-device queue |
| `adb-tcp` | transport | Adds the `adb connect/disconnect` host services |
| `screencap-loop` | display | **Fallback / MVP** — `exec-out screencap -p`, PNG at roughly 2–3 fps, high latency, wasteful bandwidth. The production default is scrcpy (Plan 08) |
| `adb-input` | input | **Fallback** `sdk` mode (InputManager injection — detectable as injected, spec §9.1). `input text` handles printable ASCII only. The production default is scrcpy-uhid (Plan 08) |

Inspectors arrive in Plan 05 (`uiautomator-dump`) and Plan 06 (`ui-server`).
