# @enkaku/drivers

Implementasi engine 4 lapisan driver (spec §7): Transport / DisplaySource / InputSink / Inspector.

## Engine M2

| Engine | Lapisan | Catatan |
|---|---|---|
| `adb-usb` | transport | wrapper @enkaku/adb; semua exec lewat per-device queue |
| `adb-tcp` | transport | + `adb connect/disconnect` host service |
| `screencap-loop` | display | **fallback/MVP** — `exec-out screencap -p`, PNG ~2–3 fps, latency tinggi, bandwidth boros. Default produksi = scrcpy (Plan 08) |
| `adb-input` | input | **fallback** mode `sdk` (InputManager inject — terdeteksi sebagai injeksi, spec §9.1). `input text` hanya ASCII printable. Default produksi = scrcpy-uhid (Plan 08) |

Inspector menyusul Plan 05 (`uiautomator-dump`) dan Plan 06 (`ui-server`).
