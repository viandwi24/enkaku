# Plan 14 — M9c : The desktop application (Tauri)

> **Status:** ready to work on. **Depends on:** Plan 09 (single-binary core, Studio static export). Independent of Plans 12 and 13.
> **Spec references:** §2 (zero-config), §5.1 (the Tauri shell), §3 (the end customer persona).

---

## 1. Goals

- **Double-click and it runs.** The user opens no terminal, types no address into a browser, and memorises no port.
- A native window containing Studio, a tray icon, and a core whose lifetime follows the application.
- Auto-update: the application tells you a new version exists and installs it itself.
- Safe by default: the core listens only on `127.0.0.1`, which is what makes `local` auth mode legitimate (no login, but also unreachable from the network).

The closing demo: on a clean machine with no Bun, no adb, and no Node — install one file, open it, plug in a phone, see the screen.

## 2. Non-goals

- **Replacing server or Docker mode** — desktop is extra packaging for a single user, not a replacement for team deployment.
- **A desktop-specific UI** — Studio is used as-is; no page exists only on desktop.
- **Auto-updating the core in server mode** — that has its own path (Docker pull, systemd) and is out of scope.
- **App Store distribution** — direct installers only (dmg, msi, AppImage).

## 3. Context and design decisions

### 3.1 Why Tauri rather than Electron

Tauri uses the operating system's own webview, while Electron ships its own Chromium (~150 MB per application). For an application that only wraps Studio, that size makes no sense. Tauri also uses Rust, which means a small binary with no extra runtime.

The consequence we accept: the webview differs per OS (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux). **That matters here** because Studio uses WebCodecs to decode H.264, and support is uneven (see §3.4).

### 3.2 The core as a child process, not a separately installed binary

Two options: (a) the core is bundled as a *sidecar binary* inside the application, or (b) the application runs a core binary installed separately.

**Decision: (a), a bundled sidecar.** The reason is this plan's whole point — the user installs one file. If the core had to be installed separately we would be back to the problem we are trying to remove.

The implication: the desktop release process must run `bun build --compile` for each platform first, then place the results in `src-tauri/binaries/` with a target suffix (`enkaku-core-aarch64-apple-darwin`, and so on) following Tauri's convention.

### 3.3 Lifecycle: when the app closes, the core goes with it

A farm left running as an orphan process with no UI is a trap: the user believes they closed the application while the devices are still held. The rules:

- Window closed → the core is stopped (SIGTERM, wait 5 seconds, then force).
- Closing the window does **not** exit immediately while the tray is active — the app minimises to the tray and the core stays alive. Exiting happens only through the tray's "Quit".
- If the app crashes the core is orphaned. That is handled by writing the core's PID to a file in the data dir; on the next start the old PID is checked and killed if it is still alive.

### 3.4 WebCodecs in the webview — **tested, and it passes**

Studio uses `VideoDecoder` (WebCodecs) for the scrcpy H.264 stream. Support:

| Platform | Webview | WebCodecs | Status |
|---|---|---|---|
| macOS | WKWebView (Safari 26.4) | ✅ `VideoDecoder` present, H.264 baseline supported | **verified in a real Tauri app** |
| Windows | WebView2 (Chromium) | ✅ present | not tested directly |
| Linux | WebKitGTK | ⚠️ version-dependent | not tested |

Tested by running a built Tauri application and loading a probe page: `'VideoDecoder' in window` → true, `VideoDecoder.isConfigSupported({codec:'avc1.42e01e'})` → supported.

**Which means:** the desktop video path uses full scrcpy H.264, exactly as the browser does. No wasm decoder and no platform restrictions are needed.

### 3.5 Auto-update

The Tauri updater checks a JSON endpoint, downloads, verifies the signature, then installs. What it needs: a key pair (generated once, with the private key kept in CI), a release endpoint, and a `pubkey` in the configuration.

Important: **an auto-update installs a new core too**, because the core is bundled. So an update has to wait until no job is running — cutting a job off mid-flight would leave the device dirty (breaking the promise that `finish` always runs, spec §11.2).

## 4. Technical design

### 4.1 Structure

```
apps/desktop/
  package.json                 # dev/build scripts; devDep @tauri-apps/cli
  src-tauri/
    Cargo.toml                 # NEW — Rust dependencies
    tauri.conf.json            # EXISTS — needs completing (sidecar, updater, tray)
    build.rs                   # NEW
    icons/                     # NEW — application and tray icons
    binaries/                  # NEW — the compiled core per target (not committed)
    src/
      main.rs                  # EXISTS — needs extending: sidecar, tray, health-wait, PID
      core_process.rs          # NEW — spawn, stop, health-check the core
      tray.rs                  # NEW — the tray menu
scripts/
  build-desktop.sh             # NEW — compile the core → copy into binaries/ → tauri build
```

### 4.2 Start sequence

```
The app opens
  → read <data-dir>/core.pid; if that process is still alive, kill it (crash leftovers)
  → start the core sidecar: ENKAKU_BIND=127.0.0.1, with a port from the free-port search
  → write the new PID
  → wait for GET /api/health to return ok (30-second timeout, polling every 250 ms)
      ├ success → load Studio in the window
      └ failure → show an error screen containing the core's log (not a white window)
```

The port is found dynamically (starting at 7700, incrementing when taken) so it does not collide with another core that may already be running. The chosen port is passed to the frontend as a window argument.

### 4.3 Tray

| Menu item | Action |
|---|---|
| Open Enkaku | Show and focus the window |
| Status | Number of online devices (from `/api/health`), read-only |
| Open data folder | Opens the data dir in the file manager |
| Check for updates | Triggers an updater check |
| Quit | Confirms if a job is running, then stops the core and exits |

### 4.4 Updating while a job is running

```
the updater finds a new version
  → GET /api/jobs?status=running
      ├ empty     → install now, restart the app
      └ jobs run  → show "Update ready, it will install once jobs finish"
                    → install automatically when the last job finishes, or when the user picks
                      "Install now" (with a warning that running jobs will be cancelled)
```

## 5. Implementation steps

### Stage 1 — The gate: WebCodecs in the webview

- [ ] Build a minimal Tauri app that loads a test page reporting `'VideoDecoder' in window` and trying `VideoDecoder.isConfigSupported({codec:'avc1.42e01e'})`.
- [ ] Run it on macOS (this machine) and record the result. Windows and Linux follow when there is access to them.
- **Verification:** the result is recorded in this plan as a decision. If it is unsupported, decide first: a wasm decoder or a platform restriction. **Do not continue until this is settled.**

### Stage 2 — Rust scaffold

- [ ] `Cargo.toml`, `build.rs`, icons; `bunx tauri dev` opens an empty window.
- **Verification:** the window opens on macOS.

### Stage 3 — The core as a sidecar

- [ ] `scripts/build-desktop.sh`: `bun build --compile` the core → copy into `src-tauri/binaries/enkaku-core-<target-triple>`.
- [ ] `core_process.rs`: find a free port, start the sidecar, write the PID, wait for health, stop on exit, clean up an orphaned PID.
- [ ] An error screen showing the core's log if it fails to start.
- **Verification:** `tauri dev` → Studio appears, `/api/health` is green, close the app → the core process is gone from `ps`.

### Stage 4 — Tray and lifecycle

- [ ] `tray.rs` (§4.3); closing the window minimises to the tray; Quit confirms if a job is running.
- **Verification:** with a job running, press Quit → a confirmation appears rather than an immediate exit.

### Stage 5 — Updater

- [ ] Generate a key pair; keep the private key outside the repo; fill in `pubkey` in the configuration (replacing the current `TODO-verify`).
- [ ] The release endpoint plus the wait-for-jobs update flow (§4.4).
- **Verification:** update from an old version to a new one on a test machine.

### Stage 6 — Packaging and signing

- [ ] macOS: `.dmg`, signing plus notarization.
- [ ] Windows: `.msi`, an Authenticode certificate.
- [ ] Linux: `.AppImage`.
- **Verification:** install on a clean machine (no Bun, adb, or Node) → the farm works.

### Stage 7 — Documentation

- [ ] `docs/guide/desktop.md` plus an update to `apps/desktop/README.md`.
- [ ] Record whatever platform limits Stage 1 turned up.

## 6. Acceptance criteria

1. [ ] The WebCodecs test results per platform are recorded, and the desktop video path decision follows from them.
2. [ ] On a clean machine: install → open → plug in a phone → the screen appears, with no terminal at all.
3. [ ] Closing the app stops the core; no orphan processes (tested after a forced crash too).
4. [ ] Port collisions are handled automatically.
5. [ ] If the core fails to start → an informative error screen with the log, not a white window.
6. [ ] The tray works; Quit while a job is running asks for confirmation.
7. [ ] Auto-update succeeds and waits for jobs to finish.
8. [ ] The core still binds `127.0.0.1` (verified: `lsof` shows no other address).

## 7. Test plan

**Manual on macOS (this machine):** all of Stages 1–5.

**A clean machine (VM):** no Bun, Node, or adb — this is what proves the zero-config claim that justifies this plan.

**Chaos:** kill the core process from outside (the app must show a status, not sit silent); kill the app with `kill -9` then reopen it (the orphaned PID must be cleaned up); run two instances of the app.

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| No WebCodecs in WKWebView/WebKitGTK | Desktop video at 2–3 fps | The Stage 1 gate; prepare a wasm decoder or restrict platforms |
| Notarization or signing stalls | Users cannot open the app | Start early; ship a temporary "force open" guide |
| A large core binary (Bun ~50–90 MB) | A fat installer | Accept it; still far below Electron. Measure and record |
| An update cutting off a job | A device left dirty | The §4.4 flow |
| Orphaned core processes | Devices held with no UI | A PID file plus cleanup at start |

## 9. Open questions

1. **Icons and branding** — no design assets yet.
2. **Signing certificates**: an Apple Developer ID and a Windows certificate both carry annual costs. Who handles that?
3. **The release endpoint**: self-hosted or GitHub Releases?
4. **Linux**: AppImage only, or `.deb` and Flatpak too?
5. **Desktop mode for a small team**: may desktop bind to the LAN (with a warning that login becomes mandatory), or should it stay loopback only?
