# enkaku-core

The Bun + Hono daemon: device registry, toolchain manager, API and WS.

## Run in dev

```bash
ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run packages/core/src/index.ts
```

On first run adb is downloaded, verified, and activated automatically by the Toolchain Manager — no system adb required. Progress is visible over WS (`tool.provision.progress`).

Env:

| Env | What it does |
|---|---|
| `ENKAKU_DATA_DIR` | Override the app-data dir (per-OS default, see 00-overview §5) |
| `ENKAKU_PORT` | HTTP/WS port (default 7700) |
| `ENKAKU_LOG_LEVEL` | debug \| info \| warn \| error |
| `ENKAKU_LOG_JSON` | `1` → JSON-lines logs |
| `ENKAKU_TOOLS_MANIFEST_URL` | Remote manifest for `POST /api/tools/manifest/refresh` |
| `ENKAKU_ADB_PATH` | Override the adb binary (dev/test only, always warns) |

## Boot sequence

DB and migrations (including the one-shot cluster materialisation, see below) → WS hub plus ToolchainManager (reconcile and adopt pre-baked tools) → HTTP and WS listen → provision required tools (a gate) → adb client, track-devices, registry.

## Endpoints

- `GET /api/health` — `{ ok, version, adb: { state, serverVersion }, deviceCount, uptimeMs }`
- `GET /api/devices` — `{ devices: DeviceInfo[] }`; `?tag=` narrows by tag (AND), `?clusterId=<id|none>` narrows by cluster
- `PUT /api/devices/:id/cluster` — `{ clusterId: string | null }`, moves the device (or unassigns it)
- `GET/POST /api/clusters`, `PATCH/DELETE /api/clusters/:id` — a cluster is a container (plan 22.0): `POST /api/clusters/:id/devices` assigns members, `DELETE /api/clusters/:id/devices/:deviceId` removes one, `GET /api/clusters/:id/devices` lists them. A device belongs to at most one cluster; deleting a cluster unassigns its members without deleting any device.
- `GET /api/tools` · `POST /api/tools/:id/install|activate|check` · `DELETE /api/tools/:id/:version` · `POST /api/tools/manifest/refresh` (spec §7.7)
- `GET/POST/DELETE /api/devices/:id/guest-agent` — install, inspect, or remove the on-device helper APK
- `GET/PUT/DELETE /api/devices/:id/network` — the device's network route (plan 44)
- WS `/ws` — broadcasts `device.*` and `tool.*` (schemas in `@enkaku/protocol`). A client must `GET /api/devices` first, then subscribe (there is no snapshot replay).

## Guest agent and the device network route (plan 44)

`/api/devices/:id/guest-agent` reports one of five states, and the distinction between two of them is load-bearing: **`installed` means the package is present, `ready` means the control channel actually answers.** Collapsing them would report a broken device as healthy. The others are `not-installed`, `unreachable` (installed and bootstrapped but the channel is silent), and `unsupported` (device SDK below the agent's floor, with the reason returned).

`/api/devices/:id/network` applies a SOCKS5 route through the `vpn-helper` engine — a full tunnel via `VpnService`, so an app under test cannot bypass it the way it can ignore `settings put global http_proxy`. Both endpoint groups require the `device.network` permission and a held manual lease (`leases.checkInputAllowed`), the same gate input and shell use.

The response separates **declared** (what was asked for) from **observed** (what the device reports), with a `drift` flag when they disagree — a VPN revoked from Settings, or a tunnel that died, must be visible rather than assumed away. `health` starts at `unverified` and a successful apply does **not** promote it to `ok`: only an egress probe could, and that does not exist yet.

Upstream passwords never appear in a response, in the device event log, or in any `meta` field — `redactRouteConfig()` in `@enkaku/protocol` is the single chokepoint. Route state currently lives in memory, so a core restart forgets it (the settings/read-seam half is plan 44 §5.4, deferred), and the lease-teardown revert is wired at two of its four sites, with TODOs marking the rest in `ws-handlers.ts`.

## Device terminal (plan 26)

`shell.exec` over `/ws` runs a free-form `adb shell` command on a device: gated by the `device.shell` permission (`auth/acl.ts`), the farm-wide `shell.mode` setting (`off | admin | operator`, off by default in server mode), and the same manual-lease rule input uses (`leases.checkInputAllowed`) — busy/offline/idle/wrong-holder are all refused before anything runs. Every accepted command is recorded to the device's `input` event log twice (`shell.exec`, then `shell.result`), with credential-bearing flags redacted (`device/redact.ts`). Results — including the exit code, recovered via a trailing marker since adb's `shell:` service has no exit-status of its own (`device/exit-marker.ts`) — broadcast to every viewer of the device, not just the one who ran it (`shell.echo` / `shell.result`); only the current lease holder may send `shell.exec`. No command allowlist or denylist exists anywhere in this path — see the code comments in `ws-handlers.ts` and `TerminalPane.tsx` for why that would be a false sense of security, not a real one.

## Clipboard (plan 38)

`clipboard.get`/`clipboard.set` over `/ws` read and write the device clipboard through the scrcpy control socket (`@enkaku/scrcpy`'s device-message reader, `control/device-messages.ts` — the socket was write-only before this plan). `clipboard.set` is gated exactly like `input.*`: the manual lease (`leases.checkInputAllowed` + `touchManual`), recorded to the device's `input` event log — but only the text **length**, never the text itself, since clipboard content is routinely a password or a token. `clipboard.get` needs no lease. Both requests are request/reply correlated by `id`; unlike `shell.echo`/`shell.result`, the reply (`clipboard.value`) goes **only to the requesting connection**, never broadcast to every viewer. A session with no scrcpy control socket (`screencap-loop`) refuses reads with `E_CLIPBOARD_UNAVAILABLE` — never an empty string — while still best-effort writing via `adb shell cmd clipboard set-text`. Agent-owned (cloud) devices route both operations through the plan 25 `TunnelRpc` (`clipboard.get.request`/`clipboard.set.request`), handled agent-side in `packages/agent/src/clipboard.ts`.

## Crash detection (plan 37)

A crash watcher (`device/crash-watcher.ts`) is always on for any device with an active session, independent of jobs: it subscribes to the shared monitor stream registry (`device/monitor-hub.ts`, plan 24) as the internal client `internal:crash`, reading `logcat -b crash,main -v threadtime -T 1` (the `crash` monitor kind, `device/monitors.ts`) — the crash-report buffer plus `main` (ANRs are reported by `ActivityManager` there, not in the crash buffer). Because it goes through the same hub every human Monitor tab uses, a device with both a watcher and an open viewer still runs exactly one `logcat` process.

`device/crash-parser.ts` turns those lines into `CrashEvent`s: a `FATAL EXCEPTION` block (tag `AndroidRuntime`) or an `ANR in ...` block (tag `ActivityManager`), closed by the first line that does not continue it, a 2s idle gap, or a 200-line cap — whichever comes first. Every crash is recorded as an `app.crashed` main-stream device event and its trace saved as an artifact (job-scoped when a **job** lease is held at the moment it arrives, device-scoped otherwise via `runner/artifact-store.ts`'s `saveForDevice`) — a manual lease means "record only", no job attribution.

Whether a crash also **fails** the running job is `job.crashPolicy` (`ignore` | `declared` | `any`, default `declared`): `declared` matches the script's own `ScriptDefinition.reset.packages`, falling back to packages it launched via `ctx.device.app.launch`; `any` matches any non-system crash. A match aborts the runner with reason `'crashed'` (`session/runner/job-runner.ts`), which settles the job `APP_CRASHED` — classified `script` by `jobs/failure-class.ts` (a crash is a result, not a farm fault) — while still running `finish()` (spec §11.3).

`adb.maxStreamsPerDevice` defaults to 3 (not Plan 24's original 1): the crash watcher and the ui-server inspector (plan 34) each hold a stream slot on top of anything a human opens in the Monitor tab.

## Idle session TTL and quality profiles (plan 42)

`@enkaku/session`'s `SessionManager` no longer closes a device session the instant its last viewer leaves. It goes idle instead, and is closed only after `session.idleTtlSec` (farm setting, default 300s) with no new subscriber — a viewer returning inside that window re-attaches to the still-live session and sees a picture within one keyframe request, rather than paying the full wake-up sequence again. `session.maxIdleSessions` (default 8) bounds how many idle sessions the whole farm may hold open at once; past the cap the least-recently-idle one closes immediately. An idle session is also closed immediately — never waiting out the TTL — when the device goes offline, is quarantined, or a job claims it (`SessionManager.closeIfIdle`); a session with an **active** viewer is never touched by any of these, since video keeps streaming while a device is busy (spec §10.1). Setting `idleTtlSec: 0` restores the exact pre-plan-42 behaviour. Idle sessions are listed (oldest first) in `GET /api/adb/stats`'s `idleSessions` field.

Every session also has a **quality profile** (`control` | `wall`), which maps to `max_size`/`max_fps`/`video_bit_rate` on the scrcpy server (`@enkaku/session`'s `QUALITY_PROFILES`). `control` (1600px / 30fps / 4Mbps) is what the device page always asks for; `wall` (480px / 5fps / 800kbps) is what the fleet Wall asks for, so many low-rate tiles can decode in one browser tab. The manager's rule: a device already at `control` quality is shared as-is with a `wall` request — **never** restarted or downgraded for a colleague's wall tile — while a `control` request against a `wall`-quality session restarts it at `control`, carrying existing viewers (e.g. a wall tile) over onto the new session rather than dropping them. `stream.start`'s `quality` payload field defaults to `control`; `stream.started` always reports back the quality actually granted.

## Cluster migration (plan 22.0)

Clusters used to be a saved tag selector; a device now carries a `cluster_id` field directly, so it belongs to at most one cluster. On first boot after upgrading, `db/migrations/cluster-materialise.ts` collapses every existing cluster's old (tag-based) membership into that field — oldest cluster wins any conflict — and writes a report to `<dataDir>/logs/cluster-migration-<timestamp>.json` naming every device that matched more than one. The step is guarded by a marker row (`migration_markers`), so it runs exactly once.
