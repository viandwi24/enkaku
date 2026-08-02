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
- WS `/ws` — broadcasts `device.*` and `tool.*` (schemas in `@enkaku/protocol`). A client must `GET /api/devices` first, then subscribe (there is no snapshot replay).

## Device terminal (plan 26)

`shell.exec` over `/ws` runs a free-form `adb shell` command on a device: gated by the `device.shell` permission (`auth/acl.ts`), the farm-wide `shell.mode` setting (`off | admin | operator`, off by default in server mode), and the same manual-lease rule input uses (`leases.checkInputAllowed`) — busy/offline/idle/wrong-holder are all refused before anything runs. Every accepted command is recorded to the device's `input` event log twice (`shell.exec`, then `shell.result`), with credential-bearing flags redacted (`device/redact.ts`). Results — including the exit code, recovered via a trailing marker since adb's `shell:` service has no exit-status of its own (`device/exit-marker.ts`) — broadcast to every viewer of the device, not just the one who ran it (`shell.echo` / `shell.result`); only the current lease holder may send `shell.exec`. No command allowlist or denylist exists anywhere in this path — see the code comments in `ws-handlers.ts` and `TerminalPane.tsx` for why that would be a false sense of security, not a real one.

## Cluster migration (plan 22.0)

Clusters used to be a saved tag selector; a device now carries a `cluster_id` field directly, so it belongs to at most one cluster. On first boot after upgrading, `db/migrations/cluster-materialise.ts` collapses every existing cluster's old (tag-based) membership into that field — oldest cluster wins any conflict — and writes a report to `<dataDir>/logs/cluster-migration-<timestamp>.json` naming every device that matched more than one. The step is guarded by a marker row (`migration_markers`), so it runs exactly once.
