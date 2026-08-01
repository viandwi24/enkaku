# enkaku-core

Daemon Bun + Hono: device registry, toolchain manager, API + WS.

## Run dev

```bash
ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run packages/core/src/index.ts
```

First-run: adb otomatis di-download + diverifikasi + di-activate (Toolchain Manager) — tidak butuh adb terpasang di sistem. Progress terlihat di WS (`tool.provision.progress`).

Env:

| Env | Fungsi |
|---|---|
| `ENKAKU_DATA_DIR` | override app-data dir (default per-OS, lihat 00-overview §5) |
| `ENKAKU_PORT` | port HTTP/WS (default 7700) |
| `ENKAKU_LOG_LEVEL` | debug \| info \| warn \| error |
| `ENKAKU_LOG_JSON` | `1` → log JSON-lines |
| `ENKAKU_TOOLS_MANIFEST_URL` | manifest remote untuk `POST /api/tools/manifest/refresh` |
| `ENKAKU_ADB_PATH` | override binary adb (dev/test only, ber-warning) |

## Boot sequence

DB+migrasi → WS hub + ToolchainManager (reconcile/adopt pre-baked) → HTTP+WS listen → provision tool wajib (gate) → adb client + track-devices + registry.

## Endpoint

- `GET /api/health` — `{ ok, version, adb: { state, serverVersion }, deviceCount, uptimeMs }`
- `GET /api/devices` — `{ devices: DeviceInfo[] }`
- `GET /api/tools` · `POST /api/tools/:id/install|activate|check` · `DELETE /api/tools/:id/:version` · `POST /api/tools/manifest/refresh` (spec §7.7)
- WS `/ws` — broadcast `device.*` + `tool.*` (schema di `@enkaku/protocol`). Client harus `GET /api/devices` dulu lalu subscribe (tidak ada replay snapshot).
