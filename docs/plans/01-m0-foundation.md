# Plan 01 — M0 : Fondasi (monorepo, adb client, device registry, SQLite, WS broadcast)

> **Status:** draft, siap dikerjakan.
> **Depends on:** `00-overview.md` (konvensi & template). Tidak ada plan sebelumnya — ini plan pertama; repo belum git.
> **Referensi spec:** §4 (arsitektur & layout packages), §7 (interface `Transport`), §7.5 (stableId), §10.4 (per-device queue + semaphore, larangan `kill-server`), §12 (data model `devices`), §13 (protokol Core⇄Studio), §20 baris **M0**.

---

## 1. Goals

Setelah plan ini selesai, semua poin berikut TRUE dan bisa didemokan:

- Monorepo Bun workspaces berdiri: `git init` sudah jalan, root `package.json` + `tsconfig.base.json` (strict) + `bunfig.toml` ada, `bun install` sukses dari clean checkout.
- Package `@enkaku/protocol`, `@enkaku/adb`, dan `packages/core` ada, saling import via nama package (bukan relative path lintas package), dan `bun test` hijau di seluruh workspace.
- `@enkaku/adb` bicara langsung ke **adb server** via TCP socket (protokol smartsocket, port 5037) — bukan spawn `adb` CLI per perintah — dan:
  - bisa `exec(serial, cmd)` (shell one-shot per device),
  - bisa **`track-devices` streaming**: device colok/cabut terdeteksi realtime **tanpa polling**,
  - semua exec lewat **per-device command queue + global semaphore longgar (max 6–8 concurrent)**,
  - **tidak ada** code path yang memanggil `adb kill-server`.
- Core daemon (Bun + Hono) hidup: `GET /api/health` dan `GET /api/devices` merespons; WS `/ws` menerima koneksi dan mem-broadcast `device.added` / `device.removed` / `device.status` (envelope Zod dari `@enkaku/protocol`).
- Device registry: saat device muncul (state `device` di tracker), core mem-probe **stableId** (`getprop ro.serialno`, fallback `settings get secure android_id`) + `androidVersion`/`apiLevel`/`screenW`/`screenH`/`density`, lalu **upsert ke SQLite by `stableId`** — serial adb hanya disimpan sebagai alamat transport. Device yang sama via USB lalu via WiFi = **satu record**.
- SQLite + Drizzle jalan: file `enkaku.db` dibuat di data dir (`ENKAKU_DATA_DIR` dihormati), migrasi tabel `devices` (sesuai spec §12) ter-apply otomatis saat daemon start.
- `resolveToolPath('adb')` ada sebagai abstraksi tunggal untuk lokasi binary adb; implementasi M0 = baca env `ENKAKU_ADB_PATH` (jembatan eksplisit, diganti Toolchain Manager di Plan 02).

Demo akhir: jalankan daemon, buka `wscat` ke `/ws`, colok HP → event `device.added` muncul < 2 detik, `GET /api/devices` menampilkan device dengan stableId + dimensi; cabut HP → `device.removed`/`device.status: offline`.

## 2. Non-goals

Sengaja TIDAK dikerjakan di plan ini (dan di mana dikerjakannya):

- **Toolchain Manager** (download adb, sha256, versioning, active pointer, first-run provisioning) → Plan 02 (M1). M0 mengasumsikan adb binary sudah ada via `ENKAKU_ADB_PATH`.
- **Video / screencap / input injection** (`screencap-loop`, `adb-input`, coordinate mapping) → Plan 03 (M2).
- **Enrollment wizard** (`device.unauthorized`, pairing code wireless ADB) → Plan 03 (M2). Di M0 device `unauthorized` hanya di-log & di-skip (lihat §4.5 dan Open questions).
- **Session / lease / state machine `manual|busy` / job queue di SQLite** → Plan 04 (M3). Kolom `status` di tabel `devices` sudah ada, tapi M0 hanya memakai `offline` dan `idle`.
- **Script framework, SDK, inspector** → Plan 05–06.
- **Studio (Next.js)** → mulai Plan 03; M0 diverifikasi via `curl` + `wscat`.
- **Tabel DB selain `devices`** (`scripts`, `jobs`, `artifacts`, `users`, `tool_installs`, `audit_log` — spec §12) → dibuat di plan yang membutuhkannya (Plan 02: `tool_installs`; Plan 04: `jobs`; Plan 05: `scripts`/`artifacts`; Plan 09: `users`/`audit_log`). Jangan dibuat sekarang "sekalian".
- **Auth/TLS** → Plan 09. M0 bind ke `127.0.0.1` saja (aman by default, sesuai spec §14).
- Package placeholder yang BELUM dibuat di M0: `packages/studio`, `sdk`, `scrcpy`, `toolchain`, `drivers`, `agent`, `apps/desktop`. Struktur folder mereka disebut di README root sebagai "menyusul", tapi tidak di-scaffold sekarang (hindari workspace kosong yang bikin noise).

## 3. Konteks & keputusan desain

- **Kenapa socket ke adb server, bukan spawn CLI?** Spawn `adb shell ...` per perintah = overhead proses + parsing stdout rapuh + tidak ada cara streaming `track-devices` yang bersih. adb server sudah expose protokol TCP sederhana (smartsocket) di `127.0.0.1:5037`; STF membuktikan pola ini via `adbkit`. Kita implement client tipis sendiri di `@enkaku/adb` (Bun `Bun.connect` TCP). Satu-satunya spawn CLI yang diizinkan: `adb start-server` saat connect ke 5037 ditolak (server belum jalan) — dan **tidak pernah** `adb kill-server` (spec §10.4).
- **Realtime, bukan polling.** `host:track-devices` adalah subscription: adb server push snapshot daftar device setiap ada perubahan. Registry kita cuma nge-diff snapshot → event. Ini sesuai spec §13 ("dari `adb track-devices`, bukan polling").
- **Per-device queue + semaphore longgar** (spec §10.4): exec dalam satu device diserialisasi (hindari interleaving command di device yang sama), lintas device paralel tapi dibatasi semaphore global (default **6**, hard-cap 8) supaya adb server tidak kebanjiran koneksi. BUKAN mutex tunggal.
- **stableId = identitas, serial = alamat** (spec §7.5): wireless serial (`ip:port`) berubah-ubah; tanpa stableId, satu HP jadi dua record. Upsert **by `stableId`**; kolom `serial` di-update tiap kali device muncul dengan alamat transport terbaru.
- **`resolveToolPath()` sebagai jembatan.** Spec §7.8 melarang driver resolve binary dari system PATH — semua lewat Toolchain Manager. Toolchain Manager baru ada di Plan 02, jadi M0 menyediakan fungsi `resolveToolPath()` dengan implementasi sementara `ENKAKU_ADB_PATH`. **Ini eksplisit jembatan dev-only**: signature-nya final, hanya body-nya yang diganti Plan 02. Tidak ada kode lain yang boleh membaca `ENKAKU_ADB_PATH` langsung.
- **Interface `Transport` (spec §7) belum diimplement penuh** sebagai engine pluggable (itu wilayah `packages/drivers`, Plan 03+). Tapi tipenya dideklarasikan sekarang (di `@enkaku/protocol` sebagai shared type) supaya `@enkaku/adb` dan registry memakai kosakata yang sama (`serial` vs `stableId`).
- **Envelope WS** persis konvensi 00-overview §4.3: `{ type, id?, payload }`, discriminated union Zod di `@enkaku/protocol`; core & (nanti) studio import dari situ — tidak ada string type hardcode di luar protocol package.

## 4. Desain teknis

### 4.1 Struktur monorepo yang dibuat di M0

```
openpf/
  .gitignore
  package.json                  # workspaces: ["packages/*", "apps/*"]
  bunfig.toml
  tsconfig.base.json            # strict, noUncheckedIndexedAccess
  README.md                     # ringkas: apa ini, cara run dev, package map (placeholder disebut)
  packages/
    protocol/
      package.json              # @enkaku/protocol (publishable-ready, tapi private dulu)
      tsconfig.json
      src/
        index.ts
        envelope.ts             # EnvelopeSchema + helper
        device.ts               # DeviceInfoSchema + device.* messages
        transport.ts            # interface Transport (spec §7) + tipe terkait
    adb/
      package.json              # @enkaku/adb (private)
      tsconfig.json
      src/
        index.ts
        socket.ts               # low-level smartsocket framing
        client.ts               # AdbClient: hostService/exec/trackDevices/ensureServer
        tracker.ts              # DeviceTracker: parse & diff snapshot → events
        queue.ts                # Semaphore + PerDeviceQueue
        socket.test.ts
        tracker.test.ts
        queue.test.ts
    core/
      package.json              # enkaku-core (private, bukan publishable)
      tsconfig.json
      drizzle.config.ts
      drizzle/                  # output migrasi (generated, di-commit)
      src/
        index.ts                # entry: buat daemon, start, handle SIGINT/SIGTERM
        daemon.ts               # createDaemon(): lifecycle start/stop
        config.ts               # baca env: port, data dir, log level
        util/
          logger.ts
          errors.ts             # EnkakuError
          paths.ts              # resolveDataDir()
          tools.ts              # resolveToolPath()  ← jembatan M0
        db/
          schema.ts             # tabel devices (spec §12)
          index.ts              # openDb(), runMigrations()
          db.test.ts
        registry/
          device-registry.ts    # orkestrasi tracker → probe → upsert → broadcast
          probe.ts              # probeDeviceIdentity(): stableId + props
          probe.test.ts
        server/
          http.ts               # Hono routes /api/health, /api/devices
          ws.ts                 # WsHub: koneksi + broadcast envelope
```

Package lain dari spec §4 (`studio`, `sdk`, `scrcpy`, `toolchain`, `drivers`, `agent`, `apps/desktop`) = **placeholder, menyusul di plan masing-masing**; cukup disebut di README root.

### 4.2 Protokol adb server (smartsocket) — yang diimplement `socket.ts`/`client.ts`

Client connect TCP ke `127.0.0.1:5037`. Framing request/response:

- **Request** = payload ASCII dengan prefix **4 hex digit lowercase** panjang payload (dalam byte). Contoh: `host:version` → kirim `000chost:version`.
- **Response status** = 4 byte: `OKAY` atau `FAIL`. Kalau `FAIL`, diikuti blok `4-hex-length + pesan error` → lempar `EnkakuError('E_ADB_FAIL', pesan)`.
- **Response data** (untuk host service yang balas data, mis. `host:version`, `host:devices-l`): setelah `OKAY`, satu blok `4-hex-length + data`.

Service yang dipakai M0:

| Service | Alur | Dipakai untuk |
|---|---|---|
| `host:version` | req → OKAY → 1 blok data (hex version) | health check koneksi adb server |
| `host:track-devices` | req → OKAY → **stream tanpa akhir**: tiap perubahan, server push 1 blok `4-hex-length + snapshot` | deteksi device realtime |
| `host:transport:<serial>` | req → OKAY → socket "terikat" ke device tsb | prefix sebelum `shell:` |
| `shell:<cmd>` | (setelah transport) req → OKAY → **raw output sampai socket ditutup** (tanpa length prefix) | exec per-device |

Aturan penting:

- **Satu koneksi socket = satu perintah** untuk `transport`+`shell` (setelah shell selesai, server tutup socket). `track-devices` memakai satu koneksi dedicated yang hidup terus.
- Format snapshot `track-devices`: baris-baris `"<serial>\t<state>\n"`. State yang mungkin: `device`, `offline`, `unauthorized`, `authorizing`, `recovery`, dll. Snapshot **kosong** (length `0000`) = tidak ada device.
- `shell:` output menggabungkan stdout+stderr dan tidak membawa exit code. Cukup untuk M0 (probe getprop/wm). Varian `shell,v2:` (protokol shell v2 dengan exit code) dicatat sebagai perbaikan nanti — masuk Open questions.
- **Auto-start server**: kalau connect ke 5037 `ECONNREFUSED` → `Bun.spawn([await resolveToolPath('adb'), 'start-server'])`, tunggu exit, retry connect (max 3x, backoff 500ms). `adb kill-server` **dilarang** — tidak boleh ada di codebase M0 (di-assert oleh test grep, lihat §7).

Sketsa API publik `@enkaku/adb`:

```ts
// packages/adb/src/client.ts
export interface AdbClientOptions {
  adbPath: string            // dari resolveToolPath('adb') — client TIDAK baca env sendiri
  host?: string              // default '127.0.0.1'
  port?: number              // default 5037
  maxConcurrent?: number     // semaphore global, default 6, clamp 1..8
}

export class AdbClient {
  constructor(opts: AdbClientOptions)
  async ensureServer(): Promise<void>            // connect / auto start-server (tanpa kill-server)
  async version(): Promise<string>               // host:version
  async exec(serial: string, cmd: string): Promise<string>
  // ↑ lewat PerDeviceQueue(serial) + Semaphore; transport+shell one-shot; hasil = output utf8 trimmed
  trackDevices(): DeviceTracker                  // koneksi dedicated, streaming
  async dispose(): Promise<void>                 // tutup tracker + tunggu queue drain
}

// packages/adb/src/tracker.ts
export type AdbDeviceState = 'device' | 'offline' | 'unauthorized' | 'authorizing' | (string & {})
export interface TrackedDevice { serial: string; state: AdbDeviceState }
export type TrackerEvent =
  | { kind: 'add';    serial: string; state: AdbDeviceState }
  | { kind: 'remove'; serial: string }
  | { kind: 'change'; serial: string; state: AdbDeviceState }

export class DeviceTracker {
  on(cb: (ev: TrackerEvent) => void): () => void   // diff snapshot lama vs baru → events
  async start(): Promise<void>                     // connect + host:track-devices; auto-reconnect (backoff) kalau socket putus
  async stop(): Promise<void>
  snapshot(): TrackedDevice[]
}
```

### 4.3 Per-device queue + global semaphore (spec §10.4)

```ts
// packages/adb/src/queue.ts
export class Semaphore {
  constructor(max: number)                      // M0 default 6; spec bilang "longgar 6–8"
  async acquire(): Promise<() => void>          // return releaser
}

export class PerDeviceQueue {
  constructor(private sem: Semaphore)
  run<T>(serial: string, task: () => Promise<T>): Promise<T>
  // Semantik:
  // 1. Task untuk serial yang sama dieksekusi berurutan (chain promise per serial).
  // 2. Sebelum task jalan: sem.acquire(); selesai/throw: release (try/finally).
  // 3. Task device A yang lama (mis. nanti `install`) TIDAK memblok task device B —
  //    hanya memakan 1 slot semaphore.
  // 4. Entry map serial dibersihkan saat chain-nya kosong (hindari leak untuk serial wireless yang berubah-ubah).
  pending(serial: string): number               // untuk test & debugging
}
```

Semua `AdbClient.exec` wajib lewat `PerDeviceQueue`. Ini satu-satunya pintu exec — tidak ada jalur pintas.

### 4.4 `@enkaku/protocol` — envelope + device messages (spec §13)

```ts
// packages/protocol/src/envelope.ts
import { z } from 'zod'

export const EnvelopeSchema = z.object({
  type: z.string(),
  id: z.string().optional(),        // request-reply correlation (belum dipakai M0)
  payload: z.unknown(),
})
export type Envelope = z.infer<typeof EnvelopeSchema>

// packages/protocol/src/device.ts
export const DeviceStatusSchema = z.enum(['offline', 'idle', 'manual', 'busy', 'quarantined'])
// M0 hanya menghasilkan 'offline' | 'idle'; enum lengkap sesuai spec §12 supaya tidak migrate schema lagi di M3.

export const DeviceInfoSchema = z.object({
  id: z.string(),
  stableId: z.string(),
  serial: z.string(),               // alamat transport adb saat ini
  label: z.string(),
  androidVersion: z.string().nullable(),
  apiLevel: z.number().int().nullable(),
  screenW: z.number().int().nullable(),
  screenH: z.number().int().nullable(),
  density: z.number().int().nullable(),
  status: DeviceStatusSchema,
  lastSeen: z.number().int().nullable(),   // unix epoch detik
})
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>

export const DeviceAddedMessage = z.object({
  type: z.literal('device.added'),
  payload: DeviceInfoSchema,
})
export const DeviceRemovedMessage = z.object({
  type: z.literal('device.removed'),
  payload: z.object({ id: z.string(), stableId: z.string() }),
})
export const DeviceStatusMessage = z.object({
  type: z.literal('device.status'),
  payload: z.object({ id: z.string(), stableId: z.string(), status: DeviceStatusSchema }),
})

// packages/protocol/src/index.ts
export const ServerMessageSchema = z.discriminatedUnion('type', [
  DeviceAddedMessage, DeviceRemovedMessage, DeviceStatusMessage,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
```

Juga di `protocol/src/transport.ts`: deklarasi interface `Transport` persis spec §7 (id, connect, disconnect, `serial`, `stableId`, exec) — dipakai sebagai kontrak tipe mulai Plan 03; M0 hanya mendeklarasikan.

### 4.5 Device registry + probe stableId (spec §7.5, §12)

Flow saat tracker emit event:

```
tracker: add/change(serial, state)
  ├─ state == 'device'      → probe(serial) → upsert by stableId → status 'idle' → broadcast added|status
  ├─ state == 'unauthorized'→ log.warn (wizard = Plan 03); tidak upsert (belum bisa shell → belum ada stableId)
  └─ state lain             → log.debug, abaikan
tracker: remove(serial)
  └─ cari record dgn serial tsb & status != offline → status 'offline' → broadcast device.status
     (device.removed hanya untuk kasus khusus — lihat Open questions Q3)
```

Probe (semua via `client.exec`, otomatis terserialisasi oleh per-device queue):

| Field | Perintah | Parsing |
|---|---|---|
| stableId (utama) | `getprop ro.serialno` | trim; invalid jika kosong / `unknown` / `0` |
| stableId (fallback) | `settings get secure android_id` | trim; invalid jika kosong / `null` |
| androidVersion | `getprop ro.build.version.release` | trim |
| apiLevel | `getprop ro.build.version.sdk` | `parseInt`, NaN → null |
| screenW × screenH | `wm size` | regex `Physical size: (\d+)x(\d+)`; kalau ada baris `Override size:`, pakai itu |
| density | `wm density` | regex `Physical density: (\d+)`; `Override density:` menang kalau ada |

- Kalau kedua sumber stableId invalid → **tertiary fallback** `stableId = 'serial:' + serial` + `log.warn` (dicatat di Open questions Q2; jangan silent).
- Probe gagal total (device dicabut di tengah probe) → log.warn, jangan crash registry; event berikutnya akan retry.
- Upsert (Drizzle, dalam satu statement `onConflictDoUpdate` on `stable_id`):
  - insert: `id = crypto.randomUUID()`, `label = model` (dari `getprop ro.product.model`, fallback stableId), kolom probe, `status='idle'`, `serial`, `lastSeen=now`.
  - conflict: update `serial` (alamat baru!), kolom probe, `status='idle'`, `lastSeen`. **`id` dan `label` tidak diubah** (label = milik user setelah rename nanti).
- Registry menyimpan map in-memory `serial → stableId` untuk resolve event `remove` cepat tanpa query.

### 4.6 SQLite + Drizzle — tabel `devices` (spec §12, subset M0)

```ts
// packages/core/src/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const devices = sqliteTable('devices', {
  id:        text('id').primaryKey(),
  stableId:  text('stable_id').notNull().unique(),
  serial:    text('serial').notNull(),
  label:     text('label').notNull(),
  ownerId:   text('owner_id'),                          // dipakai mulai Plan 09

  androidVersion: text('android_version'),
  apiLevel:  integer('api_level'),
  screenW:   integer('screen_w'),
  screenH:   integer('screen_h'),
  density:   integer('density'),

  transport:  text('transport').default('adb-usb'),
  display:    text('display').default('scrcpy'),
  input:      text('input').default('scrcpy-uhid'),
  inspection: text('inspection').default('ui-server'),

  battery:   text('battery', { mode: 'json' }),          // diisi mulai Plan 07 (§15.2)
  settings:  text('settings', { mode: 'json' }),         // DeviceSettings Zod menyusul (Plan 04/07)
  status:    text('status').default('offline'),          // offline|idle|manual|busy|quarantined
  lastSeen:  integer('last_seen', { mode: 'timestamp' }),
})
```

- Driver: `drizzle-orm/bun-sqlite` di atas `bun:sqlite`. `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` saat open.
- Migrasi: `drizzle-kit generate` → SQL di `packages/core/drizzle/` (di-commit); daemon menjalankan `migrate()` (drizzle bun-sqlite migrator) saat start, sebelum listen.
- **Tabel lain di spec §12 sengaja belum dibuat** — menyusul di plan yang memakainya (lihat Non-goals).
- Path DB: `<dataDir>/enkaku.db`; `dataDir` dari `resolveDataDir()` (§4.7). Test pakai `:memory:`.

### 4.7 `packages/core` — daemon, util, endpoint

```ts
// util/errors.ts
export class EnkakuError extends Error {
  constructor(public code: string, message: string, public cause?: unknown) { super(message) }
  toJSON() { return { error: { code: this.code, message: this.message } } }
}
// Kode M0: E_ADB_FAIL, E_ADB_UNAVAILABLE, E_TOOL_NOT_FOUND, E_DB, E_BAD_REQUEST

// util/logger.ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export function createLogger(subsystem: string): Logger
// level dari ENKAKU_LOG_LEVEL (default 'info'); ENKAKU_LOG_JSON=1 → JSON-lines.
// Tidak ada console.log liar di luar logger ini (konvensi 00-overview §4.2).

// util/paths.ts
export function resolveDataDir(): string
// 1. ENKAKU_DATA_DIR kalau di-set (dibuat rekursif kalau belum ada)
// 2. darwin  → ~/Library/Application Support/Enkaku
//    win32   → %APPDATA%\Enkaku
//    linux   → ~/.local/share/enkaku
// (00-overview §5)

// util/tools.ts — ⚠️ JEMBATAN M0, diganti Toolchain Manager di Plan 02
export async function resolveToolPath(toolId: 'adb'): Promise<string>
// M0: baca ENKAKU_ADB_PATH → validasi file exists → return.
// Tidak di-set → throw EnkakuError('E_TOOL_NOT_FOUND',
//   'Set ENKAKU_ADB_PATH ke binary adb (sementara, sampai Toolchain Manager di M1)')
// Signature FINAL; Plan 02 hanya mengganti body (resolve dari <dataDir>/tools/adb/active).
// Aturan: TIDAK ADA kode lain yang baca ENKAKU_ADB_PATH atau system PATH langsung.
```

Daemon & server:

```ts
// daemon.ts
export interface Daemon { start(): Promise<void>; stop(): Promise<void>; port: number }
export function createDaemon(cfg: CoreConfig): Daemon
// start(): resolveDataDir → openDb + migrate → resolveToolPath('adb') → new AdbClient
//          → ensureServer() → registry.start() (tracker jalan) → Bun.serve (Hono fetch + websocket)
// stop():  tutup Bun.serve → registry.stop() → adb.dispose() → db.close()   (idempotent, urutan kebalikan start)
// index.ts: createDaemon(loadConfig()).start(); SIGINT/SIGTERM → stop() → exit 0.
```

- HTTP (Hono, bind `127.0.0.1`, port dari `ENKAKU_PORT`, default **7700** — lihat Open questions Q1):
  - `GET /api/health` → `200 { ok: true, version, adb: { serverVersion }, deviceCount, uptimeMs }`
  - `GET /api/devices` → `200 { devices: DeviceInfo[] }` (dari DB, di-map & divalidasi `DeviceInfoSchema` sebelum keluar)
  - Error handler global: `EnkakuError` → status 4xx/5xx + `{ error: { code, message } }`; error lain → 500 `E_INTERNAL`.
- WS `/ws` (Bun.serve `websocket` handler + `server.upgrade` dari route Hono):
  - `WsHub`: `Set<ServerWebSocket>`, `broadcast(msg: ServerMessage)` → validasi `ServerMessageSchema.parse` → `JSON.stringify` → kirim ke semua client.
  - M0: server→client saja; message masuk dari client di-log lalu diabaikan (control messages = Plan 03+).
  - Client baru **tidak** dikirimi replay snapshot — konsumen diharapkan `GET /api/devices` dulu lalu subscribe (didokumentasikan di README core).
- Registry di-inject `WsHub` → tiap upsert/perubahan status memanggil `hub.broadcast(...)`.

## 5. Langkah implementasi

### 5.1 Init repo + workspace skeleton

- [ ] `git init` di `/Users/solpochi/Projects/oss/openpf`; buat `.gitignore` (`node_modules/`, `*.db`, `.DS_Store`, `dist/`, `.env*`).
- [ ] Buat root `package.json`: `"private": true`, `"workspaces": ["packages/*", "apps/*"]`, scripts: `"dev": "bun run packages/core/src/index.ts"`, `"test": "bun test"`, `"typecheck": "tsc -b"` (atau `bunx tsc --noEmit` per package).
- [ ] Buat `tsconfig.base.json`: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"target": "ES2022"`, `"types": ["bun-types"]`.
- [ ] Buat `bunfig.toml` (minimal; cukup ada untuk konvensi).
- [ ] Buat `README.md` root: deskripsi 1 paragraf, cara run dev, tabel package (protocol/adb/core = ada; studio/sdk/scrcpy/toolchain/drivers/agent/apps-desktop = "placeholder, lihat plan 02–11").
- [ ] Scaffold 3 package: `packages/{protocol,adb,core}` masing-masing `package.json` (nama `@enkaku/protocol`, `@enkaku/adb`, `enkaku-core`; `"private": true`; `"exports": { ".": "./src/index.ts" }` — source-first, tanpa build step di M0) + `tsconfig.json` extends base.
- [ ] `packages/adb` & `core` depend `@enkaku/protocol` via `"workspace:*"`; `core` depend `@enkaku/adb`; core juga `hono`, `drizzle-orm`, `zod`; dev-dep `drizzle-kit`.
- [ ] **Verifikasi:** `bun install` sukses; `bun test` jalan (0 test, exit 0); commit `chore: init monorepo (m0)`.

### 5.2 `@enkaku/protocol` — envelope + device messages

- [ ] Tulis `packages/protocol/src/envelope.ts`, `device.ts`, `transport.ts` (interface `Transport` spec §7), `index.ts` re-export — sesuai snippet §4.4.
- [ ] Unit test `packages/protocol/src/device.test.ts`: `ServerMessageSchema` menerima message valid, menolak `type` tak dikenal & payload salah bentuk (`safeParse().success === false`).
- [ ] **Verifikasi:** `bun test packages/protocol` hijau.

### 5.3 `@enkaku/adb` — smartsocket framing + client exec

- [ ] `src/socket.ts`: fungsi `encodeRequest(payload: string): Uint8Array` (4-hex-length + payload) dan class `AdbSocket` di atas `Bun.connect`: `send(payload)`, `readStatus(): Promise<'OKAY'>` (throw `E_ADB_FAIL` + pesan pada `FAIL`), `readBlock(): Promise<string>` (4-hex-length + data), `readUntilClose(): Promise<Uint8Array>`. Internal: buffer akumulasi karena TCP chunk boundary tidak dijamin.
- [ ] `src/client.ts`: `AdbClient` sesuai §4.2 — `version()` (`host:version`), `exec(serial, cmd)` = koneksi baru → `host:transport:<serial>` → `shell:<cmd>` → `readUntilClose` → utf8 trim; `ensureServer()` dengan spawn `start-server` + retry (backoff 500ms, max 3).
- [ ] Grep-guard: pastikan string `kill-server` tidak ada di `packages/` (lihat test §7).
- [ ] Unit test `socket.test.ts` (tanpa device): `encodeRequest('host:version') === '000chost:version'`; parsing `OKAY`/`FAIL`+pesan; `readBlock` benar saat data datang terpecah dalam 2 chunk (feed manual ke parser).
- [ ] **Verifikasi:** `bun test packages/adb` hijau; smoke manual (butuh adb): `ENKAKU_ADB_PATH=$(which adb) bun -e 'import {AdbClient} from "./packages/adb/src/index.ts"; const c=new AdbClient({adbPath:process.env.ENKAKU_ADB_PATH!}); await c.ensureServer(); console.log(await c.version())'`.

### 5.4 `@enkaku/adb` — queue + semaphore, lalu wire ke exec

- [ ] `src/queue.ts`: `Semaphore` + `PerDeviceQueue` sesuai kontrak §4.3 (termasuk cleanup entry map & release di `finally`).
- [ ] Wire: `AdbClient.exec` selalu lewat `queue.run(serial, ...)`; `maxConcurrent` default 6, clamp 1..8.
- [ ] Unit test `queue.test.ts`:
  - dua task serial sama → eksekusi berurutan (task B mulai setelah A selesai; assert urutan via array log);
  - task serial beda → paralel (dengan semaphore ≥ 2, keduanya in-flight bersamaan — assert via counter puncak);
  - semaphore max 2 + 5 task → in-flight tidak pernah > 2;
  - task throw → release tetap terjadi (task berikut tetap jalan).
- [ ] **Verifikasi:** `bun test packages/adb` hijau.

### 5.5 `@enkaku/adb` — `track-devices` streaming

- [ ] `src/tracker.ts`: `DeviceTracker` sesuai §4.2 — koneksi dedicated `host:track-devices`; parse tiap blok `4-hex-length` jadi `TrackedDevice[]` (split `\n`, split `\t`); diff vs snapshot sebelumnya → emit `add`/`remove`/`change`; socket putus → reconnect otomatis (backoff 1s→5s) + saat reconnect, diff snapshot baru vs lama (device yang hilang selama putus → `remove`).
- [ ] Unit test `tracker.test.ts` (pure, feed snapshot string tanpa socket): kosong→1 device = `add`; state `unauthorized`→`device` = `change`; hilang = `remove`; snapshot identik = tanpa event.
- [ ] **Verifikasi:** `bun test` hijau; smoke manual dengan device: script kecil yang `tracker.on(console.log)` lalu colok/cabut HP → event tampil realtime tanpa polling.

### 5.6 Core util: logger, EnkakuError, paths, resolveToolPath

- [ ] `src/util/errors.ts`, `logger.ts`, `paths.ts`, `tools.ts` sesuai §4.7. `tools.ts` diberi komentar header `// M0 BRIDGE: diganti Toolchain Manager (Plan 02). Jangan tambah pembaca ENKAKU_ADB_PATH lain.`
- [ ] `src/config.ts`: `loadConfig()` → `{ port (ENKAKU_PORT, default 7700), host: '127.0.0.1', dataDir: resolveDataDir(), logLevel }`.
- [ ] Unit test kecil: `resolveDataDir()` menghormati `ENKAKU_DATA_DIR`; `resolveToolPath` throw `E_TOOL_NOT_FOUND` saat env kosong.
- [ ] **Verifikasi:** `bun test packages/core` hijau.

### 5.7 Core DB: Drizzle schema + migrasi

- [ ] `src/db/schema.ts` (tabel `devices` §4.6), `drizzle.config.ts` (dialect sqlite, out `./drizzle`), generate migrasi: `cd packages/core && bunx drizzle-kit generate`; commit SQL hasil generate.
- [ ] `src/db/index.ts`: `openDb(path)` (bun:sqlite + WAL pragma) dan `runMigrations(db)` (drizzle migrator, folder `drizzle/`).
- [ ] Unit test `db.test.ts` (pakai `:memory:` / dir temp): migrasi jalan; insert device; **upsert by stableId**: insert serial `ABC` lalu upsert stableId sama dengan serial `192.168.1.5:5555` → tetap 1 row, serial ter-update, `id` & `label` tidak berubah.
- [ ] **Verifikasi:** `bun test packages/core` hijau; jalankan sekali dengan `ENKAKU_DATA_DIR=/tmp/enkaku-dev` → file `enkaku.db` tercipta di sana.

### 5.8 Core: probe + device registry

- [ ] `src/registry/probe.ts`: `probeDeviceIdentity(client, serial)` → jalankan perintah tabel §4.5 (via `client.exec`, otomatis ter-queue), parsing + fallback stableId; return `{ stableId, model, androidVersion, apiLevel, screenW, screenH, density }`. Parser dipisah jadi fungsi pure (`parseWmSize(s)`, `parseWmDensity(s)`, `pickStableId(serialno, androidId, serial)`) supaya bisa di-unit-test tanpa device.
- [ ] Unit test `probe.test.ts`: `parseWmSize('Physical size: 1080x2400') → {1080,2400}`; kasus `Override size`; `pickStableId('unknown','a1b2c3','X') → 'a1b2c3'`; keduanya invalid → `'serial:X'`.
- [ ] `src/registry/device-registry.ts`: `createDeviceRegistry({ client, db, hub, log })` dengan `start()`/`stop()`; behavior persis flow §4.5 (state `device` → probe → upsert → broadcast `device.added` [record baru] atau `device.status` idle [record lama]; `unauthorized` → warn; remove → set `offline` + broadcast `device.status`). Saat `start()`: sebelum subscribe, set semua row `status != 'offline'` → `'offline'` (recovery dari crash), lalu tracker snapshot awal akan meng-online-kan yang benar-benar ada.
- [ ] **Verifikasi:** `bun test` hijau (probe parser); registry diuji end-to-end di 5.10.

### 5.9 Core: Hono HTTP + WS hub + daemon lifecycle

- [ ] `src/server/http.ts`: Hono app, route `GET /api/health`, `GET /api/devices` (query Drizzle → map → `DeviceInfoSchema.parse` per row), error handler `{ error: { code, message } }`.
- [ ] `src/server/ws.ts`: `WsHub` (add/remove socket di open/close, `broadcast(ServerMessage)` dengan `ServerMessageSchema.parse` sebelum kirim).
- [ ] `src/daemon.ts` + `src/index.ts`: urutan start/stop sesuai §4.7; `Bun.serve({ hostname, port, fetch: app.fetch (dengan upgrade /ws), websocket: hub.handlers })`; SIGINT/SIGTERM → graceful stop; start di-log: port, dataDir, adb server version, jumlah device awal.
- [ ] **Verifikasi:** `ENKAKU_ADB_PATH=$(which adb) ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run packages/core/src/index.ts` → log start rapi; `curl -s localhost:7700/api/health | jq .ok` → `true`; Ctrl-C → keluar bersih (exit 0, tanpa unhandled rejection).

### 5.10 Wiring end-to-end + smoke test dengan device fisik

- [ ] Pastikan registry menerima `WsHub` & jalan di `daemon.start()`.
- [ ] README `packages/core/README.md`: cara run dev (env yang dibutuhkan), daftar endpoint, format message WS, catatan "client harus GET /api/devices dulu lalu subscribe /ws".
- [ ] Smoke test manual berskrip (dokumentasikan persis di README core):
  ```bash
  # terminal 1 — daemon
  ENKAKU_ADB_PATH=$(which adb) ENKAKU_DATA_DIR=/tmp/enkaku-dev \
    bun run packages/core/src/index.ts

  # terminal 2 — subscribe events
  bunx wscat -c ws://127.0.0.1:7700/ws

  # terminal 3 — cek REST
  curl -s http://127.0.0.1:7700/api/health | jq
  curl -s http://127.0.0.1:7700/api/devices | jq
  ```
  Lalu: colok HP USB → terminal 2 menerima `device.added` (payload lengkap stableId + dimensi) dalam < 2 detik; `curl /api/devices` menampilkan device `status: "idle"`; cabut → `device.status` `offline`; **nyalakan wireless ADB (`adb tcpip 5555` + connect) untuk HP yang sama** → `GET /api/devices` tetap **1 record** dengan `serial` baru `ip:5555`.
- [ ] **Verifikasi:** seluruh skenario di atas lulus; commit `feat(m0): core daemon + adb tracker + device registry`.

## 6. Acceptance criteria

Semua harus lulus sebelum lanjut Plan 02:

1. `bun install` dari clean clone sukses; `bun test` hijau di seluruh workspace; `bunx tsc --noEmit` (per package, base config strict + `noUncheckedIndexedAccess`) tanpa error.
2. Daemon start dengan `ENKAKU_ADB_PATH` + `ENKAKU_DATA_DIR` di-set; tanpa `ENKAKU_ADB_PATH` → gagal dengan `E_TOOL_NOT_FOUND` dan pesan jelas (bukan stack trace mentah).
3. `GET /api/health` → `{ ok: true, ... }`; `GET /api/devices` → `{ devices: [...] }` valid terhadap `DeviceInfoSchema`.
4. Colok device (authorized) → `device.added` di `/ws` < 2 detik, tanpa polling (verifikasi: tidak ada `setInterval`/loop `host:devices` di codebase; deteksi murni dari stream `host:track-devices`).
5. Cabut device → status `offline` ter-broadcast & ter-persist; colok lagi → kembali `idle` tanpa record baru.
6. **Identity stabil:** device sama via USB lalu via WiFi (`ip:5555`) = 1 row di tabel `devices` (unique `stable_id` terbukti); kolom `serial` berubah mengikuti transport terakhir.
7. Probe terisi: `androidVersion`, `apiLevel`, `screenW/H`, `density` non-null untuk device normal.
8. Exec concurrency benar: unit test queue lulus (serial-sama berurutan, serial-beda paralel, semaphore cap ditegakkan, release on throw).
9. `grep -rn "kill-server" packages/` → 0 hasil di kode runtime (boleh muncul di komentar/test yang meng-assert larangan ini).
10. Restart daemon dua kali berturut-turut aman: migrasi idempotent, tidak ada error "table already exists", device state pulih dari snapshot tracker.
11. Definition of Done global 00-overview §7 terpenuhi (test hijau, tidak ada `any` liar, README package terisi).

## 7. Test plan

**Unit (`bun test`, tanpa device):**

- `protocol/device.test.ts` — validasi/penolakan `ServerMessageSchema` & `DeviceInfoSchema`.
- `adb/socket.test.ts` — `encodeRequest` (panjang hex benar, mis. payload 12 byte → prefix `000c`); parser status `OKAY`/`FAIL`+pesan; `readBlock` tahan chunk terpecah; payload kosong (`0000`).
- `adb/queue.test.ts` — 4 skenario di langkah 5.4.
- `adb/tracker.test.ts` — diffing snapshot (add/change/remove/no-op), parsing baris `serial\tstate`.
- `core/probe.test.ts` — parser `wm size`/`wm density` (physical & override), `pickStableId` (utama/fallback/tertiary).
- `core/db.test.ts` — migrasi + upsert-by-stableId (serial berubah, row tetap satu).
- `core/util` — `resolveDataDir` (env override), `resolveToolPath` (throw saat env kosong).
- Guard test: baca isi `packages/adb/src/*.ts` & `packages/core/src/**/*.ts`, assert tidak mengandung `kill-server` (di luar komentar) dan tidak ada `console.log` di luar `logger.ts`.

**Smoke manual berskrip (butuh device fisik; tandai `ENKAKU_TEST_DEVICE=1` sesuai 00-overview §4.4):**

1. `ENKAKU_ADB_PATH=$(which adb) ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run packages/core/src/index.ts`
2. `bunx wscat -c ws://127.0.0.1:7700/ws` → tunggu event.
3. `curl -s http://127.0.0.1:7700/api/health | jq` dan `curl -s http://127.0.0.1:7700/api/devices | jq`.
4. Skenario: colok USB → cabut → colok lagi → `adb tcpip 5555` + `adb connect <ip>:5555` → cabut USB → cek `/api/devices` tetap 1 record, serial = `<ip>:5555`.
5. Matikan adb server manual di tengah jalan (`pkill -f "adb.*fork-server"` — BUKAN via kode kita) → tracker reconnect otomatis, daemon tidak crash, device muncul lagi.
6. `sqlite3 /tmp/enkaku-dev/enkaku.db 'select stable_id, serial, status from devices;'` → cocok dengan API.

**Concurrency semi-otomatis (dengan ≥1 device):** script test yang fire 20× `exec(serial, 'echo x')` ke device yang sama + assert output urut & tidak interleave; kalau ada 2 device, fire ke keduanya bersamaan dan assert total wall-time menunjukkan paralelisme lintas device.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Framing smartsocket salah (chunk TCP terpecah / off-by-one hex length) | exec/tracker hang atau data korup | Parser buffer-akumulatif + unit test chunk-split; referensi silang perilaku `adbkit` (spec §6.1) saat ragu |
| `adb start-server` lambat / adb path salah | daemon gagal start membingungkan | Retry + backoff terbatas; error `E_ADB_UNAVAILABLE`/`E_TOOL_NOT_FOUND` dengan pesan actionable (path yang dicoba, env yang dibaca) |
| Device wireless flap (WiFi putus-nyambung) → badai event & probe berulang | log spam, beban adb server | Probe di-dedupe per serial (skip kalau probe untuk serial tsb masih in-flight); tracker reconnect backoff |
| `ro.serialno` kosong/`unknown` di device tertentu (custom ROM) | stableId salah → duplikat record | Fallback ANDROID_ID sudah di spec §7.5; tertiary `serial:`-prefix + warn (Open questions Q2) |
| `wm size`/`wm density` format beda antar OEM/versi Android | dimensi null | Parser toleran (physical/override), null-able di schema; kolom wajib terisi baru di-enforce saat coordinate mapping (Plan 03) |
| Probe jalan saat device baru `device` tapi belum siap shell (boot awal) | probe gagal sporadis | Retry probe 1× dengan delay 1s; kalau tetap gagal, tunggu event `change` berikutnya |
| Semaphore terlalu ketat/longgar untuk mesin user | throughput vs stabilitas adb server | Default 6, clamp 1..8 (rentang spec §10.4), nilai bisa dikonfigurasi via option — tuning data nyata di M3 saat ada beban job |
| Migrasi Drizzle berubah saat tabel lain ditambah plan berikutnya | konflik migrasi | Migrasi incremental per plan (file SQL baru), tidak pernah edit migrasi lama yang sudah di-commit |

## 9. Open questions

Ambiguitas spec yang butuh keputusan manusia — **jangan diputuskan sepihak**, jawaban dicatat lalu plan/spec diupdate:

1. **Port default core.** Spec tidak menyebut angka port. Plan ini memakai `7700` (env `ENKAKU_PORT`) sebagai placeholder — konfirmasi angka final (dan apakah perlu range-scan kalau bentrok, mengingat target zero-config §2).
2. **Tertiary fallback stableId.** Spec §7.5 hanya mendefinisikan `ro.serialno` → ANDROID_ID. Kalau keduanya invalid, M0 memakai `serial:<serial-adb>` + warning — artinya device tsb bisa duplikat kalau pindah transport. Diterima sebagai edge case, atau perlu strategi lain (mis. tolak enroll)?
3. **Semantik `device.removed` vs `device.status: offline`.** Spec §13 punya keduanya. M0 menginterpretasikan: cabut kabel = `device.status → offline` (record tetap ada); `device.removed` dicadangkan untuk penghapusan record dari registry (fitur delete device — belum ada di spec §19 secara eksplisit). Konfirmasi interpretasi ini sebelum Studio (Plan 03) bergantung padanya.
4. **`shell,v2:`** (exit code + pemisahan stdout/stderr). M0 pakai `shell:` legacy yang cukup untuk probe. Upgrade ke shell v2 layak dipertimbangkan sebelum script runner (Plan 05) butuh exit code — masuk plan mana?
5. **Device `unauthorized` di M0.** Enrollment wizard = M2, tapi apakah M0 perlu minimal broadcast event `device.unauthorized` (spec §13 kategori enrollment) supaya Plan 03 tinggal pakai? Saat ini M0 hanya log warn tanpa broadcast.
6. **Nilai default kolom driver (`display: 'scrcpy'`, `input: 'scrcpy-uhid'`, `inspection: 'ui-server'`)** mengikuti spec §12, padahal engine-nya baru ada M4.5–M6. Biarkan sebagai "preferensi target" yang di-ignore sampai engine tersedia, atau isi dengan engine yang benar-benar ada per milestone (`screencap-loop`/`adb-input` di M2)?
