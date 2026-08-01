# Enkaku (openpf)

Device farm platform untuk remote control + automation smartphone Android — self-hosted, zero-config. Spec lengkap: [`docs/spec.md`](docs/spec.md), rencana kerja berurutan: [`docs/plans/`](docs/plans/).

## Menjalankan (dev)

```bash
bun install
bun run dev
# buka http://localhost:7700
```

Tidak perlu meng-install adb: saat pertama jalan, core mengunduh adb + scrcpy-server + APK inspector, memverifikasi sha256-nya, lalu mengaktifkannya sendiri (sekitar 15 detik). Data dev disimpan di `.dev-data/` di dalam folder proyek, jadi tidak mengotori sistem.

### Daftar perintah

| Perintah | Fungsi |
|---|---|
| `bun run dev` | Core mode lokal + Studio (kalau sudah di-build) di `:7700` |
| `bun run dev:studio` | Studio dengan hot-reload di `:3001`, menunjuk core di `:7700` |
| `bun run build:studio` | Build Studio agar dilayani core (satu origin) |
| `bun run dev:cloud` | Core mode orchestrator (control plane, tanpa device lokal) |
| `bun run dev:agent` | Agent mode cloud (butuh `ENKAKU_CP_URL`) |
| `bun run dev:desktop` | Aplikasi desktop Tauri (butuh Rust) |
| `bun run publish:example` | Publish script contoh ke farm lokal |
| `bun run typecheck` | Typecheck semua package |
| `bun run reset` | Hapus semua data dev |

### Cara menguji tiap alur

**Remote control & automation (mode lokal).** Jalankan `bun run dev`, colok HP dengan USB debugging aktif, lalu buka `http://localhost:7700`. Untuk mengembangkan UI dengan hot-reload, jalankan `bun run dev:studio` di terminal kedua dan buka `:3001`.

**Menjalankan script.** Dengan core hidup: `bun run publish:example`, lalu buka halaman Scripts di Studio dan tekan Run. Script contoh ada di `examples/`.

**Mode cloud (dua terminal).**

```bash
# terminal 1 — control plane
bun run dev:cloud

# buat enrollment token (sekali saja)
curl -s -X POST localhost:7700/api/agents \
  -H 'content-type: application/json' -d '{"name":"agen-saya"}'

# terminal 2 — agent, di mesin yang terhubung ke HP
ENKAKU_CP_URL=http://localhost:7700 ENKAKU_ENROLL_TOKEN=<token> bun run dev:agent
```

Token hanya dibutuhkan sekali; setelahnya agent cukup `bun run dev:agent`. Panduan lengkap: [`docs/guide/cloud.md`](docs/guide/cloud.md).

**Aplikasi desktop.** Butuh Rust. `ENKAKU_CORE_BIN=<path core> bun run dev:desktop`.

Panduan instalasi lengkap dan pemecahan masalah: [`docs/guide/install.md`](docs/guide/install.md).

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
