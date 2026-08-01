# Enkaku (openpf)

Device farm platform untuk remote control + automation smartphone Android — self-hosted, zero-config. Spec lengkap: [`docs/spec.md`](docs/spec.md), rencana kerja berurutan: [`docs/plans/`](docs/plans/).

## Run dev (M0)

```bash
bun install
ENKAKU_ADB_PATH=$(which adb) ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run dev
```

`ENKAKU_ADB_PATH` adalah jembatan sementara M0 — digantikan Toolchain Manager (Plan 02) yang mengelola binary adb sendiri.

## Package map

| Package | Status | Isi |
|---|---|---|
| `packages/protocol` | ✅ M0 | `@enkaku/protocol` — envelope + message Zod Core⇄Studio, shared types |
| `packages/adb` | ✅ M0 | `@enkaku/adb` — adb smartsocket client, track-devices, per-device queue |
| `packages/core` | ✅ M0 | daemon Bun + Hono: registry, DB, API, WS |
| `packages/toolchain` | ⏳ Plan 02 | provisioning tool (download, sha256, versi) |
| `packages/drivers` | ⏳ Plan 03 | engine Transport/DisplaySource/InputSink/Inspector |
| `packages/studio` | ⏳ Plan 03 | web UI Next.js |
| `packages/sdk` | ⏳ Plan 05 | `@enkaku/sdk` — `defineScript`, tipe publik |
| `packages/scrcpy` | ⏳ Plan 08 | scrcpy protocol client (versi-locked ke core) |
| `packages/agent` | ⏳ Plan 11 | mini-core cloud tunnel |
| `apps/desktop` | ⏳ Plan 09 | shell Tauri |
