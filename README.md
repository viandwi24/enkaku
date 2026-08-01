# Enkaku (openpf)

Device farm platform untuk remote control + automation smartphone Android — self-hosted, zero-config. Spec lengkap: [`docs/spec.md`](docs/spec.md), rencana kerja berurutan: [`docs/plans/`](docs/plans/).

## Run dev (M0)

```bash
bun install
ENKAKU_ADB_PATH=$(which adb) ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run dev
```

`ENKAKU_ADB_PATH` adalah jembatan sementara M0 — digantikan Toolchain Manager (Plan 02) yang mengelola binary adb sendiri.

## Package map

| Package | Isi |
|---|---|
| `packages/protocol` | Envelope + message Zod Core⇄Studio, tipe driver, framing biner, protokol tunnel |
| `packages/adb` | Client adb smartsocket, `track-devices`, per-device queue + semaphore |
| `packages/toolchain` | Provisioning tool: manifest, download + sha256 wajib, versi, pointer aktif |
| `packages/drivers` | Engine 4 lapisan: transport adb, display screencap/scrcpy, input adb/UHID/SDK, inspector dump/ui-server |
| `packages/scrcpy` | Client protokol scrcpy (versi-locked): demuxer H.264, control message, HID pointer absolut |
| `packages/sdk` | `@enkaku/sdk` — `defineScript` + CLI `enkaku publish` |
| `packages/core` | Daemon Bun + Hono: registry, queue/lease, runner, auth/ACL, API + WS |
| `packages/studio` | Web UI Next.js: dashboard, live control, scripts, jobs, tools, settings |
| `packages/agent` | Mini-core cloud: enrollment + tunnel outbound (M8a) |
| `examples/` | Contoh script automation (mencerminkan project script author) |
