# apps/desktop — the desktop app (Tauri)

Wraps the core and Studio into a desktop application: a native window, a tray icon, and the core running as a child process.

## Verified

| Item | Result |
|---|---|
| Rust build (`cargo build`) | ✅ |
| Window opens and loads the page from the core | ✅ |
| Core runs as a child process bound to `127.0.0.1` | ✅ |
| Automatic free-port search (starting at 7700) | ✅ |
| Waits for `/api/health` before loading the UI; on failure shows an error screen rather than a white window | ✅ |
| **WebCodecs in macOS WKWebView** | ✅ `VideoDecoder` is present, H.264 baseline is supported |
| Cleans up orphaned core processes after an app crash | ✅ tested: the stale PID is killed on the next start |
| Closing the window minimises to the tray, the core stays alive | ✅ (by design) |

The WebCodecs result matters: the desktop app uses the same scrcpy H.264 video path as the browser — it does not drop to `screencap-loop` at 2–3 fps.

## Not done yet

- **Installer bundling** (`.dmg`/`.msi`/`.AppImage`) — needs real icons (currently placeholders) and signing certificates: an Apple Developer ID for macOS notarization, Authenticode for Windows. Both carry annual costs and are your call.
- **Auto-update** — configuration is deliberately left out for now, because the updater's `pubkey` has to be created at the first release. The "wait for jobs to finish before installing an update" flow is already designed in plan 14 §4.4.
- **Testing on Windows and Linux** — needs the machines.

## Running during development

```bash
# the app starts the core; point this at the bun wrapper if it is not compiled yet
ENKAKU_CORE_BIN=/path/to/enkaku-core bun run --cwd apps/desktop dev
```

## Release

```bash
./scripts/build-desktop.sh
```

That script builds Studio, compiles the core into a single binary, drops it in as a sidecar, then bundles the app.
