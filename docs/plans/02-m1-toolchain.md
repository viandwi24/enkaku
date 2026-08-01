# Plan 02 — M1 : Toolchain Manager

> **Status:** draft, siap dikerjakan setelah Plan 01 selesai.
> **Depends on:** Plan 01 (M0 — monorepo, core daemon, `packages/adb`, device registry, SQLite/Drizzle, WS broadcast, per-device queue + semaphore).
> **Referensi spec:** §20 baris M1, §7.2 (konsep Toolchain Manager), §7.3 (ToolManifest/ToolVersion), §7.6 (scrcpy-server locked), §7.7 (API tools), §7.8 (aturan keamanan tool), §10.4 (`adb kill-server` hanya di sini), §12 (`tool_installs`), §16 (NFR first-run < 90 detik).

---

## 1. Goals

Setelah plan ini selesai, semua poin berikut TRUE dan bisa didemokan:

- `packages/toolchain` (`@enkaku/toolchain`) ada dan berisi: schema Zod `ToolManifest`/`ToolVersion` persis spec §7.3 (termasuk `swappable` dan `compatibleCoreRange`), downloader dengan progress event, verifikasi sha256 **wajib sebelum tool dipakai**, extractor (zip & raw file), dan layout folder `<app-data>/tools/<toolId>/<version>/` dengan pointer aktif berbasis file `active.json`.
- Manifest built-in (bundled JSON di repo) mendeskripsikan tiga tool awal: `adb` (swappable: true, per-OS dari Google platform-tools), `scrcpy-server` (swappable: false, locked via `compatibleCoreRange`, dipakai baru di M6), `ui-server` (placeholder entry, dipakai M4.5).
- Enam endpoint API spec §7.7 hidup di core dan mengikuti aturan keamanan §7.8: `GET /api/tools`, `POST /api/tools/:id/install`, `POST /api/tools/:id/activate`, `DELETE /api/tools/:id/:version`, `POST /api/tools/:id/check`, `POST /api/tools/manifest/refresh`.
- Tabel `tool_installs` (spec §12) ada di SQLite via Drizzle dan konsisten dengan isi disk.
- **First-run auto-provision**: start core dengan folder `tools/` kosong → adb otomatis di-download, diverifikasi sha256, di-extract, di-activate; progress dibroadcast ke semua client WS via message `tool.provision.progress`; total waktu < 90 detik di koneksi wajar (NFR §16).
- Jembatan Plan 01 (`ENKAKU_ADB_PATH` + `resolveToolPath()` stub) diganti: `packages/adb` me-resolve path binary adb **hanya** lewat Toolchain Manager. System PATH tidak pernah dipakai (spec §7.8). `ENKAKU_ADB_PATH` tetap ada sebagai override khusus dev/test dengan warning log.
- `adb kill-server` hanya dipanggil di satu tempat di seluruh codebase: flow swap versi adb di Toolchain Manager, dan hanya setelah drain semua aktivitas adb (spec §10.4).
- Message protocol baru untuk progress/status tool terdefinisi di `packages/protocol` (Zod discriminated union), tanpa string message type hardcode di luar package itu.
- `bun test` hijau; unit test mencakup checksum, pointer aktif, guard swappable/delete, dan pemilihan versi via `compatibleCoreRange`.

## 2. Non-goals

- **UI Tools di Studio** — layar Toolchain penuh (install/activate/progress bar/health badge) dikerjakan di Plan 07 (M5). Di plan ini cukup API + WS message; verifikasi pakai `curl` dan client WS.
- **Download & pemakaian scrcpy-server sesungguhnya** — entry manifest + mekanisme locked disiapkan sekarang, tapi scrcpy-server baru masuk daftar tool wajib dan dipakai di Plan 08 (M6). Di M1 install-nya hanya dites lewat jalur internal (bukan first-run wajib).
- **ui-server** — hanya placeholder entry di manifest (versions kosong); implementasi di Plan 06 (M4.5).
- **Mirror self-host & pre-baked image sebagai produk jadi** — abstraksi source-nya dibangun sekarang (URL apa pun + direktori pre-baked terdeteksi), tapi tooling untuk bake image/air-gap bundle adalah kerjaan Plan 09/11.
- **Appium** — opt-in, bukan sekarang (spec §7.1; Plan 11).
- **Auth di endpoint tools** — auth menyeluruh datang di Plan 09 (M7). Endpoint mengikuti mode Plan 01 (bind localhost).
- **Retention/GC folder tools** — kebijakan pembersihan otomatis versi lama tidak dibuat; user hapus manual via API DELETE.

## 3. Konteks & keputusan desain

Ringkasan keputusan, semua merujuk spec:

1. **Kenapa subsistem ini ada**: janji produk "user tinggal install → running" (spec §1, §2 Zero-config/Self-contained). Core tidak boleh berharap adb ada di sistem; semua tool di-download ke app-data ber-versi dan path di-resolve dari sana, tidak pernah dari PATH (spec §7.2, §7.8). Pola ini proven di Playwright dan ws-scrcpy-web (spec §6.2).
2. **Pointer versi aktif = file `active.json`, bukan symlink.** Spec §7.2 menggambar `active -> 35.0.1` sebagai konsep pointer, tanpa mewajibkan mekanisme. Keputusan: file `tools/<toolId>/active.json` berisi versi aktif. Alasan menolak symlink: (a) di Windows pembuatan symlink butuh privilege admin atau Developer Mode — fatal untuk target "orang awam tinggal install" (core harus portable Windows via §2 Portable runtime); (b) file JSON bisa ditulis atomik (write temp + rename) di semua OS; (c) bisa membawa metadata (kapan diaktifkan, sha256) untuk konsistensi-check dengan DB. Trade-off: resolusi path butuh satu `readFile` ekstra — diselesaikan dengan cache in-memory yang di-invalidate saat activate.
3. **Sumber kebenaran ganda disengaja**: disk (folder versi + `active.json`) adalah kebenaran fisik; tabel `tool_installs` (spec §12) adalah katalog untuk API/UI/audit. Saat start, Toolchain Manager melakukan *reconcile*: baris DB tanpa folder → dihapus; folder valid tanpa baris → di-adopt (ini sekaligus mekanisme **pre-baked**: image/container yang sudah berisi `tools/` terisi langsung dikenali tanpa download).
4. **`swappable` di-enforce di server** (spec §7.6, §36 server-authoritative): `install`/`activate` via HTTP ditolak untuk tool `swappable: false`. Provisioning internal (dipanggil core sendiri, bukan lewat HTTP) boleh meng-install tool non-swappable — itulah cara scrcpy-server/ui-server nanti masuk. Versi untuk tool locked dipilih otomatis: satu-satunya versi di manifest yang `compatibleCoreRange`-nya memuat versi core berjalan (cek pakai `Bun.semver.satisfies`, built-in, tanpa dependency).
5. **sha256 wajib, tanpa pengecualian** (spec §7.8): hash dihitung streaming saat download; mismatch → file dibuang, install gagal, tidak ada opsi "skip verify". Entry manifest tanpa sha256 valid = tidak bisa di-install (placeholder `TODO-verify` sengaja bikin install gagal sampai diisi).
6. **Extractor per format, bukan shell out**: platform-tools Google = zip; scrcpy-server = raw file (jar tanpa ekstensi dari GitHub release Genymobile — dipakai apa adanya, spec §4 catatan mazhab (b)). Unzip pakai library JS murni **`fflate`** (kecil, tanpa native binding) karena Bun tidak punya unzip built-in dan memanggil `unzip`/`tar` sistem melanggar prinsip self-contained (tidak ada di Windows polos). Setelah extract di POSIX, `chmod 0o755` semua file hasil extract (zip via fflate tidak membawa unix mode; folder platform-tools kecil sehingga blanket-chmod aman dan deterministik).
7. **Manifest: bundled default + refresh remote** (spec §7.3 source abstraction, §7.7 `manifest/refresh`): file JSON di repo di-embed saat build sebagai default; env/config `ENKAKU_TOOLS_MANIFEST_URL` opsional menunjuk manifest remote (rilis resmi kita, atau mirror self-host untuk air-gapped). `refresh` fetch URL itu, validasi Zod, simpan cache di app-data. Urutan resolusi: cache remote valid → bundled.
8. **`adb kill-server` hanya di sini** (spec §10.4): satu-satunya call site = `AdbSwapCoordinator` di flow activate adb. Sebelum kill: drain (pause semua per-device queue, tunggu command in-flight selesai, stop `track-devices`). Sesudah: tukar pointer, `adb start-server` dengan binary baru, resume. Di M1 belum ada session/lease (baru Plan 04), jadi "drain semua session" = drain per-device queue + track-devices milik Plan 01; hook `drainSessions()` disiapkan sebagai no-op yang akan diisi Plan 04.
9. **First-run provision memblokir subsistem adb, bukan seluruh core**: HTTP + WS server naik dulu supaya Studio/client bisa melihat progress `tool.provision.progress`; subsistem yang butuh adb (track-devices dari Plan 01) menunggu promise `toolchain.ready`. Ini yang membuat pengalaman §1 ("buka browser → lihat progress → device muncul") mungkin.

## 4. Desain teknis

### 4.1 Struktur file

```
packages/toolchain/
  package.json                     # "@enkaku/toolchain", private, deps: fflate; dev: -
  tsconfig.json
  README.md
  manifest/
    enkaku-tools.json              # bundled manifest (sumber default)
  src/
    index.ts                       # re-export publik
    types.ts                       # Zod: ToolManifest, ToolVersion, PlatformKey, ActivePointer
    platform.ts                    # deteksi platform key (darwin-arm64, win32-x64, ...)
    manifest.ts                    # ManifestStore: bundled + remote refresh + cache
    paths.ts                       # layout folder, ActivePointerStore (active.json)
    download.ts                    # streaming download + sha256 + progress event
    extract.ts                     # extractZip (fflate) / placeRaw + chmod POSIX
    entrypoints.ts                 # path relatif binary per tool per platform
    health.ts                      # health check per tool (adb version, file+hash)
    manager.ts                     # ToolchainManager: install/activate/delete/check/list/
                                   #   ensureRequiredTools/reconcile/resolveToolPath
    errors.ts                      # kode error E_* toolchain
    *.test.ts                      # unit test colocated
packages/protocol/src/
  messages/tool.ts                 # message WS baru (lihat 4.7)
packages/core/src/
  db/schema.ts                     # + tabel toolInstalls (spec §12)
  tools/routes.ts                  # Hono routes /api/tools/* (spec §7.7)
  tools/provision.ts               # first-run auto-provision + broadcast progress
  tools/adb-swap.ts                # AdbSwapCoordinator (drain → kill-server → swap)
```

> Path di `packages/core` menyesuaikan struktur nyata hasil Plan 01 (mis. lokasi registrasi route dan modul WS broadcast); yang wajib adalah pemisahan modul seperti di atas.

### 4.2 Schema Zod (`packages/toolchain/src/types.ts`) — persis spec §7.3

```ts
import { z } from 'zod'

export const PlatformKey = z.enum([
  'darwin-arm64', 'darwin-x64',
  'linux-x64', 'linux-arm64',
  'win32-x64',
  '*',                                  // platform-independent (jar/apk)
])

export const ToolArtifact = z.object({
  url: z.string().url(),                // URL resmi ATAU mirror self-host
  sha256: z.string().regex(/^([0-9a-f]{64}|TODO-verify)$/),
  sizeBytes: z.number().int().nonnegative(),
})

export const ToolVersion = z.object({
  version: z.string(),
  releasedAt: z.string(),               // ISO date
  compatibleCoreRange: z.string().optional(),  // semver range core (tool coupled, §7.6)
  platforms: z.record(PlatformKey, ToolArtifact),
  knownGood: z.boolean().optional(),
})

export const ToolManifestEntry = z.object({
  id: z.string(),                       // 'adb' | 'scrcpy-server' | 'ui-server' | ...
  displayName: z.string(),
  swappable: z.boolean(),               // false → user tak bisa pilih versi (§7.6)
  format: z.enum(['zip', 'raw']),       // cara extract artifact
  versions: z.array(ToolVersion),
})

export const ToolsManifest = z.object({
  manifestVersion: z.literal(1),
  updatedAt: z.string(),
  tools: z.array(ToolManifestEntry),
})

export const ActivePointer = z.object({  // isi tools/<toolId>/active.json
  version: z.string(),
  sha256: z.string(),
  activatedAt: z.number().int(),         // unix epoch detik (konvensi 00-overview §4.2)
})
export type ToolsManifest = z.infer<typeof ToolsManifest>
```

Catatan: `format` adalah tambahan operasional (cara extract) yang tidak bertentangan dengan spec §7.3 — interface spec dipertahankan utuh; field ekstra hanya melengkapi. Regex sha256 sengaja menerima literal `TODO-verify` supaya manifest bundled lolos parse, tapi `manager.install()` menolak artifact yang sha256-nya bukan hex 64 char (`E_CHECKSUM_MISSING`).

### 4.3 Bundled manifest (`packages/toolchain/manifest/enkaku-tools.json`)

Semua `sha256`/`sizeBytes` di bawah adalah **placeholder `TODO-verify`** — WAJIB diisi saat implementasi dengan hash yang dihitung dari file yang di-download langsung dari URL resmi (catat di PR bagaimana hash diperoleh). URL platform-tools Google memakai skema `-latest-`; untuk pin versi, saat implementasi cek ketersediaan URL ber-versi (`platform-tools_r<ver>-<os>.zip`) dan pakai itu (`TODO-verify` juga untuk URL final).

```json
{
  "manifestVersion": 1,
  "updatedAt": "2026-08-01T00:00:00Z",
  "tools": [
    {
      "id": "adb",
      "displayName": "ADB (Android platform-tools)",
      "swappable": true,
      "format": "zip",
      "versions": [
        {
          "version": "36.0.0",
          "releasedAt": "TODO-verify",
          "knownGood": true,
          "platforms": {
            "darwin-arm64": { "url": "https://dl.google.com/android/repository/platform-tools_r36.0.0-darwin.zip", "sha256": "TODO-verify", "sizeBytes": 0 },
            "darwin-x64":   { "url": "https://dl.google.com/android/repository/platform-tools_r36.0.0-darwin.zip", "sha256": "TODO-verify", "sizeBytes": 0 },
            "linux-x64":    { "url": "https://dl.google.com/android/repository/platform-tools_r36.0.0-linux.zip",  "sha256": "TODO-verify", "sizeBytes": 0 },
            "win32-x64":    { "url": "https://dl.google.com/android/repository/platform-tools_r36.0.0-windows.zip","sha256": "TODO-verify", "sizeBytes": 0 }
          }
        },
        {
          "version": "35.0.2",
          "releasedAt": "TODO-verify",
          "platforms": { "darwin-arm64": { "url": "TODO-verify", "sha256": "TODO-verify", "sizeBytes": 0 } }
        }
      ]
    },
    {
      "id": "scrcpy-server",
      "displayName": "scrcpy server (managed by core)",
      "swappable": false,
      "format": "raw",
      "versions": [
        {
          "version": "3.3.1",
          "releasedAt": "TODO-verify",
          "compatibleCoreRange": "TODO-verify (semver range versi core saat M6, mis. >=0.6.0 <0.7.0)",
          "platforms": {
            "*": { "url": "https://github.com/Genymobile/scrcpy/releases/download/v3.3.1/scrcpy-server-v3.3.1", "sha256": "TODO-verify", "sizeBytes": 0 }
          }
        }
      ]
    },
    {
      "id": "ui-server",
      "displayName": "Enkaku UI inspector server (placeholder — M4.5)",
      "swappable": false,
      "format": "raw",
      "versions": []
    }
  ]
}
```

Catatan per spec: minimal **dua versi adb** di manifest supaya alur install/activate/delete versi non-aktif bisa dites nyata. Genymobile mem-publish `SHA256SUMS.txt` per release — pakai itu untuk scrcpy-server. Zip darwin Google bersifat universal (satu zip untuk arm64 & x64). `linux-arm64` tidak disediakan resmi oleh Google → lihat Open questions.

### 4.4 Layout disk & pointer aktif

```
<app-data>/                              # resolusi dir per 00-overview §5 (+ ENKAKU_DATA_DIR)
  tools/
    .staging/                            # download & extract sementara (aman dihapus saat boot)
    adb/
      36.0.0/platform-tools/adb          # hasil extract zip apa adanya
      35.0.2/platform-tools/adb
      active.json                        # { "version": "36.0.0", "sha256": "...", "activatedAt": 1754006400 }
    scrcpy-server/
      3.3.1/scrcpy-server.jar            # raw file, di-rename ke nama kanonik
      active.json
  manifest.cache.json                    # hasil refresh remote terakhir (opsional)
```

- **Atomicity**: download ke `.staging/<toolId>-<version>.part` → verifikasi sha256 → extract ke `.staging/<toolId>-<version>/` → `rename()` atomik ke `tools/<toolId>/<version>/`. `active.json` ditulis via temp+rename. Folder versi tanpa entry DB dan tanpa hasil verifikasi = dianggap korup saat reconcile → dihapus.
- **Entrypoint** (`entrypoints.ts`, hardcoded per tool — bukan di manifest, supaya schema §7.3 tetap persis):

```ts
export function entrypointRelPath(toolId: string, platform: string): string {
  switch (toolId) {
    case 'adb':           return platform.startsWith('win32')
                            ? 'platform-tools/adb.exe' : 'platform-tools/adb'
    case 'scrcpy-server': return 'scrcpy-server.jar'
    case 'ui-server':     return 'ui-server.apk'
    default: throw new EnkakuError('E_TOOL_UNKNOWN_ENTRYPOINT', toolId)
  }
}
```

- **Resolusi path** (pengganti jembatan Plan 01):

```ts
// manager.ts — SATU-SATUNYA jalan sah mendapatkan path binary tool (spec §7.8)
async resolveToolPath(toolId: string): Promise<string> {
  const override = process.env[`ENKAKU_${toolId.toUpperCase().replace(/-/g, '_')}_PATH`]
  if (override) { log.warn(`toolchain: pakai override env untuk ${toolId} (dev/test only)`); return override }
  const ptr = await this.pointers.read(toolId)          // cache in-memory + baca active.json
  if (!ptr) throw new EnkakuError('E_TOOL_NOT_PROVISIONED', toolId)
  return join(this.toolsDir, toolId, ptr.version, entrypointRelPath(toolId, this.platform))
}
```

### 4.5 Download + verifikasi (`download.ts`)

```ts
export interface DownloadProgress {
  toolId: string; version: string
  phase: 'download' | 'verify' | 'extract'
  bytesReceived: number; totalBytes: number | null    // null bila server tanpa content-length
}

export async function downloadVerified(opts: {
  artifact: ToolArtifact; dest: string
  onProgress?: (p: DownloadProgress) => void          // di-throttle max 1 event / 200ms
  signal?: AbortSignal
}): Promise<{ sha256: string }>
```

- `fetch()` streaming; tiap chunk masuk `Bun.CryptoHasher('sha256')` **dan** file `.part` sekaligus (hash sekali jalan, tanpa baca ulang).
- Selesai stream → bandingkan hex hash dengan `artifact.sha256`; mismatch → hapus `.part`, throw `E_CHECKSUM_MISMATCH` (dengan expected/actual di message). Ukuran ≠ `sizeBytes` (jika > 0) → warning log, bukan fatal (sizeBytes hanya untuk progress %).
- Timeout idle 60 detik (tidak ada byte masuk) → abort + `E_DOWNLOAD_STALLED`. Retry otomatis 1× untuk error network (bukan untuk checksum mismatch).

### 4.6 Tabel DB (`packages/core/src/db/schema.ts`) — persis spec §12

```ts
export const toolInstalls = sqliteTable('tool_installs', {
  id:          text('id').primaryKey(),                 // crypto.randomUUID()
  toolId:      text('tool_id').notNull(),
  version:     text('version').notNull(),
  active:      integer('active', { mode: 'boolean' }).default(false),
  sha256:      text('sha256'),
  installedAt: integer('installed_at', { mode: 'timestamp' }),
})
```

Invariant (di-enforce di `manager.ts`, dicek reconcile): maksimal satu baris `active=true` per `toolId`, dan baris itu harus cocok dengan `active.json`.

### 4.7 Message protocol baru (`packages/protocol/src/messages/tool.ts`)

Ditambahkan ke discriminated union envelope Plan 01 (`{ type, id?, payload }`):

```ts
export const ToolInstallProgress = z.object({
  type: z.literal('tool.install.progress'),
  payload: z.object({
    toolId: z.string(), version: z.string(),
    phase: z.enum(['download', 'verify', 'extract', 'done', 'error']),
    bytesReceived: z.number().optional(), totalBytes: z.number().nullable().optional(),
    percent: z.number().min(0).max(100).nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
})

export const ToolProvisionProgress = z.object({
  type: z.literal('tool.provision.progress'),            // khusus first-run auto-provision
  payload: z.object({
    step: z.enum(['start', 'tool', 'done', 'error']),
    toolId: z.string().optional(), version: z.string().optional(),
    phase: z.enum(['download', 'verify', 'extract', 'activate']).optional(),
    percent: z.number().nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
})

export const ToolChanged = z.object({
  type: z.literal('tool.changed'),                       // trigger Studio re-fetch GET /api/tools
  payload: z.object({
    toolId: z.string(),
    change: z.enum(['installed', 'activated', 'deleted', 'manifest-refreshed']),
  }),
})
```

### 4.8 API endpoints (persis spec §7.7) + aturan §7.8

Semua response error: `{ error: { code, message } }` (konvensi 00-overview §4.2). Kode: `E_TOOL_NOT_FOUND` 404, `E_VERSION_NOT_IN_MANIFEST` 404, `E_NOT_SWAPPABLE` 403, `E_CHECKSUM_MISMATCH`/`E_CHECKSUM_MISSING` 502/409, `E_DELETE_ACTIVE` 409, `E_TOOL_IN_USE` 409, `E_HEALTH_CHECK_FAILED` 409, `E_ALREADY_INSTALLED` 409, `E_MANIFEST_FETCH_FAILED` 502, `E_TOOL_NOT_PROVISIONED` 409.

| Method & path | Perilaku | Guard §7.8 |
|---|---|---|
| `GET /api/tools` | Daftar semua tool: manifest + status install + aktif + health terakhir | — |
| `POST /api/tools/:id/install` body `{ version }` | Download → verify sha256 → extract → catat DB (`active=false`); progress via WS `tool.install.progress` | tolak `!swappable`; tolak sha256 placeholder |
| `POST /api/tools/:id/activate` body `{ version }` | Health check kandidat → (adb: drain+kill-server) → tulis `active.json` → update DB | tolak `!swappable`; tolak jika health check gagal; versi harus terpasang |
| `DELETE /api/tools/:id/:version` | Hapus folder versi + baris DB | tolak versi aktif (`E_DELETE_ACTIVE`) / sedang dipakai (`E_TOOL_IN_USE`, cek per-device queue aktif & install in-flight) |
| `POST /api/tools/:id/check` | Jalankan health check versi aktif, simpan hasil in-memory | — |
| `POST /api/tools/manifest/refresh` | Fetch `ENKAKU_TOOLS_MANIFEST_URL` (kalau di-set), validasi Zod, tulis `manifest.cache.json`; tanpa URL → reload bundled | tolak manifest yang gagal parse (`E_MANIFEST_FETCH_FAILED`) |

Contoh response `GET /api/tools`:

```json
{
  "tools": [
    {
      "id": "adb",
      "displayName": "ADB (Android platform-tools)",
      "swappable": true,
      "activeVersion": "36.0.0",
      "installed": [
        { "version": "36.0.0", "active": true,  "sha256": "ab12…", "installedAt": 1754006400 },
        { "version": "35.0.2", "active": false, "sha256": "cd34…", "installedAt": 1754006999 }
      ],
      "available": [
        { "version": "36.0.0", "knownGood": true,  "installable": true },
        { "version": "35.0.2", "knownGood": false, "installable": true }
      ],
      "health": { "ok": true, "checkedAt": 1754007000, "detail": "Android Debug Bridge version 1.0.41" }
    },
    {
      "id": "scrcpy-server",
      "displayName": "scrcpy server (managed by core)",
      "swappable": false,
      "managedByCore": true,
      "activeVersion": null,
      "installed": [],
      "available": [
        { "version": "3.3.1", "installable": false, "compatibleCoreRange": ">=0.6.0 <0.7.0", "compatibleWithThisCore": false }
      ],
      "health": null
    },
    { "id": "ui-server", "displayName": "Enkaku UI inspector server (placeholder — M4.5)", "swappable": false, "managedByCore": true, "activeVersion": null, "installed": [], "available": [], "health": null }
  ]
}
```

Contoh error `POST /api/tools/scrcpy-server/install`:

```json
{ "error": { "code": "E_NOT_SWAPPABLE", "message": "scrcpy-server is managed by core; its version is pinned to the core release (spec §7.6)" } }
```

### 4.9 Health check (`health.ts`)

- `adb`: spawn `<path> version` (binary kandidat, bukan yang aktif), exit 0 + stdout mengandung `Android Debug Bridge` → ok; timeout 10 detik → gagal. **Wajib lulus sebelum activate** (spec §7.8).
- `scrcpy-server` / `ui-server`: file ada + sha256 file sama dengan yang tercatat di DB (jar/apk tidak bisa "dijalankan" di host).

### 4.10 Flow first-run auto-provision (`tools/provision.ts`)

```
core start
 ├─ init DB, HTTP+WS server naik (Plan 01)
 ├─ toolchain.reconcile()            # sinkron DB ⇄ disk, adopt pre-baked, bersihkan .staging
 ├─ ensureRequiredTools(['adb'])     # daftar wajib M1; M4.5 += ui-server; M6 += scrcpy-server
 │    ├─ sudah ada active & health ok → selesai (broadcast step:'done' langsung)
 │    └─ belum ada →
 │        broadcast tool.provision.progress {step:'start'}
 │        pilih versi: latest knownGood untuk platform ini (fallback: latest yang ada artifact platform ini)
 │        install (progress → broadcast {step:'tool', phase:'download'|'verify'|'extract', percent})
 │        activate tanpa drain (belum ada aktivitas adb) + health check
 │        broadcast {step:'done'}   |   gagal → {step:'error', error} + core tetap hidup,
 │                                       retry saat POST install manual / restart
 └─ resolve promise toolchain.ready → track-devices (Plan 01) baru boleh start
```

Target: folder kosong → `step:'done'` < 90 detik (NFR §16; platform-tools ±13 MB, praktis <30 detik di LAN sehat).

### 4.11 Flow swap versi adb (`tools/adb-swap.ts`) — satu-satunya `kill-server`

```
activate(adb, vNew), vOld aktif:
 1. health check binary vNew (`<vNew>/adb version`)        → gagal = batal, vOld tetap
 2. drain:
    a. pause semua per-device queue (Plan 01) — stop terima command baru
    b. tunggu command in-flight selesai (timeout 30 detik → E_TOOL_IN_USE, un-pause, batal swap)
    c. drainSessions()  ← no-op di M1, diisi Plan 04 (drain lease/session hidup)
    d. stop stream `adb track-devices`
 3. `<vOld>/adb kill-server`                                 (call site tunggal se-codebase)
 4. tulis active.json → vNew; update tool_installs (tx: vOld.active=false, vNew.active=true);
    invalidate cache resolveToolPath
 5. `<vNew>/adb start-server`; restart track-devices; resume semua queue
 6. broadcast tool.changed {toolId:'adb', change:'activated'}
Gagal di langkah 5 → rollback pointer ke vOld, start-server vOld, resume, E_HEALTH_CHECK_FAILED.
```

## 5. Langkah implementasi

### Tahap 1 — Scaffold package + schema

- [ ] Buat `packages/toolchain/package.json` (`@enkaku/toolchain`, private, dep `fflate`, `zod`), `tsconfig.json` extend `tsconfig.base.json`, daftarkan di workspace root.
- [ ] Tulis `src/types.ts` (semua schema §4.2) + `src/errors.ts` (kode `E_*` §4.8, pakai `EnkakuError` dari util Plan 01).
- [ ] Tulis `src/platform.ts`: `currentPlatformKey()` dari `process.platform`+`process.arch`, throw `E_PLATFORM_UNSUPPORTED` untuk kombinasi di luar §4.2.
- [ ] Unit test `types.test.ts`: manifest valid lolos parse; `swappable` bukan boolean gagal; sha256 non-hex non-placeholder gagal.
- **Verifikasi:** `bun test packages/toolchain` hijau; `bun run tsc --noEmit` bersih.

### Tahap 2 — Bundled manifest + ManifestStore

- [ ] Tulis `manifest/enkaku-tools.json` persis §4.3 (adb 2 versi, scrcpy-server locked, ui-server kosong; semua hash `TODO-verify`).
- [ ] **Isi nilai `TODO-verify` untuk adb & scrcpy-server**: download artifact dari URL resmi, hitung `shasum -a 256`, cocokkan scrcpy-server dengan `SHA256SUMS.txt` release Genymobile, isi `sizeBytes` & `releasedAt`. Catat sumber di komentar PR.
- [ ] Tulis `src/manifest.ts`: `ManifestStore` — load bundled (import JSON), `refresh(url?)` fetch+parse+tulis `manifest.cache.json`, getter `getTool(id)`, `resolveLockedVersion(id, coreVersion)` pakai `Bun.semver.satisfies` terhadap `compatibleCoreRange`.
- [ ] Unit test `manifest.test.ts`: bundled valid; refresh dari URL mock (Bun serve lokal) menimpa cache; JSON rusak → `E_MANIFEST_FETCH_FAILED` dan cache lama utuh; `resolveLockedVersion` memilih benar / null bila tak ada yang cocok.
- **Verifikasi:** test hijau; `bun -e` kecil bisa print daftar versi adb dari bundled manifest.

### Tahap 3 — Layout path + ActivePointerStore

- [ ] Tulis `src/paths.ts`: turunan dari app-data dir (00-overview §5, hormati `ENKAKU_DATA_DIR`), `ensureLayout()` (buat `tools/`, `.staging/`, bersihkan isi `.staging/` saat boot), `ActivePointerStore` dengan `read/write/clear` (`active.json`, Zod-parse, tulis temp+rename, cache in-memory + invalidate).
- [ ] Tulis `src/entrypoints.ts` (§4.4).
- [ ] Unit test `paths.test.ts` (pakai `ENKAKU_DATA_DIR` temp dir): write→read round-trip; `active.json` korup → `read` return null + warning (bukan crash); rename atomik menimpa pointer lama.
- **Verifikasi:** test hijau di macOS (dev) — perilaku path win32 dicek via unit test string murni (tanpa CI Windows dulu).

### Tahap 4 — Downloader + sha256

- [ ] Tulis `src/download.ts` sesuai §4.5 (streaming, `Bun.CryptoHasher`, throttle progress 200ms, idle-timeout, retry 1× network error, `E_CHECKSUM_MISMATCH` dengan expected/actual).
- [ ] Unit test `download.test.ts` dengan server `Bun.serve` lokal: file kecil → hash cocok & progress terpanggil (event pertama & terakhir); hash salah → `.part` terhapus + error; server tanpa `content-length` → `totalBytes: null`; koneksi diputus → retry lalu sukses.
- **Verifikasi:** `bun test` hijau; tidak ada file `.part` tersisa di temp dir setelah test.

### Tahap 5 — Extractor

- [ ] Tulis `src/extract.ts`: `extractZip(src, destDir)` pakai `fflate` (tolak entry ber-path traversal `..` → `E_EXTRACT_UNSAFE_PATH`), lalu `chmod 0o755` rekursif file hasil extract di POSIX; `placeRaw(src, destDir, canonicalName)` untuk jar/apk.
- [ ] Unit test `extract.test.ts`: zip fixture kecil (dibuat di test) ter-extract benar + exec bit terpasang; zip berisi entry `../evil` ditolak; raw file di-rename ke nama kanonik.
- **Verifikasi:** test hijau; extract zip platform-tools asli secara manual (`bun -e`) menghasilkan `platform-tools/adb` yang bisa dieksekusi.

### Tahap 6 — ToolchainManager

- [ ] Tulis `src/manager.ts`: kelas `ToolchainManager({ dataDir, db, coreVersion, emit })` dengan:
  - `list()` — gabungan manifest + `tool_installs` + pointer + health cache (bentuk response §4.8).
  - `install(toolId, version, { internal = false })` — guard `E_NOT_SWAPPABLE` bila `!swappable && !internal`; guard `E_CHECKSUM_MISSING`; pipeline staging (§4.4–4.5); insert `tool_installs`; emit `tool.install.progress` per phase + `tool.changed`.
  - `activate(toolId, version, { internal = false })` — guard swappable; health check dulu; delegasi ke `AdbSwapCoordinator` bila `toolId==='adb'` dan ada aktivitas adb; selain itu tulis pointer + DB langsung.
  - `remove(toolId, version)` — guard `E_DELETE_ACTIVE`/`E_TOOL_IN_USE`; hapus folder + baris DB; emit `tool.changed`.
  - `check(toolId)` — health check versi aktif (§4.9), simpan hasil.
  - `resolveToolPath(toolId)` — §4.4.
  - `reconcile()` — §3 poin 3 (adopt pre-baked: folder+entrypoint ada → insert baris DB dengan sha256 dihitung ulang).
  - `ensureRequiredTools(ids)` — §4.10, return promise `ready`.
- [ ] Unit test `manager.test.ts` (DB in-memory + server download mock): install→activate→list konsisten; install tool `!swappable` via jalur publik → `E_NOT_SWAPPABLE`, via `internal:true` → sukses; delete versi aktif → `E_DELETE_ACTIVE`; activate dengan health check gagal (binary palsu exit 1) → pointer tidak berubah; reconcile meng-adopt folder pre-baked.
- **Verifikasi:** `bun test` hijau; invariant "satu active per tool" tercek di test.

### Tahap 7 — DB migration `tool_installs`

- [ ] Tambah `toolInstalls` ke `packages/core/src/db/schema.ts` persis §4.6; generate migration Drizzle mengikuti alur migrasi Plan 01.
- [ ] Unit test ringan: insert/select round-trip; unique-active di-enforce level aplikasi (tercakup Tahap 6).
- **Verifikasi:** start core pada DB lama Plan 01 → migrasi jalan tanpa merusak tabel `devices`.

### Tahap 8 — Protocol messages

- [ ] Tulis `packages/protocol/src/messages/tool.ts` (§4.7), daftarkan ke discriminated union envelope + export.
- [ ] Unit test: parse round-trip tiap message; `type` di luar union ditolak.
- **Verifikasi:** `bun test packages/protocol` hijau; core & (nanti) studio import type dari `@enkaku/protocol` tanpa string hardcode.

### Tahap 9 — HTTP routes di core

- [ ] Tulis `packages/core/src/tools/routes.ts` (Hono sub-router, mount `/api/tools`): keenam endpoint §4.8, body divalidasi Zod (`{ version: z.string() }`), error map `EnkakuError.code` → status.
- [ ] Sambungkan `emit` ToolchainManager ke WS broadcaster Plan 01.
- [ ] Integration test (`routes.test.ts`, Hono `app.request()` + manager mock/mini): tiap endpoint happy path + tiap guard §7.8 mengembalikan kode error yang benar.
- **Verifikasi:** semua perintah curl di §7 smoke test mengembalikan bentuk response §4.8.

### Tahap 10 — First-run auto-provision + ganti jembatan Plan 01

- [ ] Tulis `packages/core/src/tools/provision.ts` (§4.10); panggil dari boot sequence core **setelah** HTTP/WS naik; expose `toolchain.ready`.
- [ ] Ubah start track-devices (Plan 01) menjadi `await toolchain.ready` terlebih dahulu.
- [ ] Ganti `resolveToolPath()` stub Plan 01: `packages/adb` menerima path adb dari `ToolchainManager.resolveToolPath('adb')` (injeksi saat konstruksi, bukan import langsung — hindari dependency cycle). Hapus fallback PATH sistem bila ada; `ENKAKU_ADB_PATH` tinggal sebagai override dev/test ber-warning.
- [ ] Grep repo: pastikan tidak ada `spawn('adb'` / resolusi PATH tersisa (`rg "spawn\(['\"]adb" packages` harus kosong).
- **Verifikasi:** smoke test skenario A (§7) lulus, termasuk stopwatch < 90 detik.

### Tahap 11 — AdbSwapCoordinator (kill-server)

- [ ] Tulis `packages/core/src/tools/adb-swap.ts` (§4.11) memakai API pause/resume per-device queue + stop/start track-devices dari Plan 01; sediakan hook `drainSessions()` no-op ber-komentar "diisi Plan 04".
- [ ] Wire `ToolchainManager.activate('adb', …)` → coordinator.
- [ ] Unit test dengan fake queue/tracker: urutan drain→kill→swap→start→resume benar; timeout drain → batal + un-pause; gagal start-server vNew → rollback vOld.
- [ ] Assert satu call site: `rg "kill-server" packages` hanya match `adb-swap.ts` (+ test-nya).
- **Verifikasi:** smoke test skenario B (§7) — swap versi saat device tersambung, device kembali terdeteksi setelah swap.

### Tahap 12 — Dokumentasi & rapikan

- [ ] `packages/toolchain/README.md`: konsep, layout disk, cara menambah tool baru ke manifest, cara mengisi sha256.
- [ ] Update README core: boot sequence baru (provision gate), env `ENKAKU_TOOLS_MANIFEST_URL`, `ENKAKU_ADB_PATH` (dev only).
- [ ] Sapu bersih: tidak ada `TODO`/`any` baru tanpa alasan; commit `feat(m1): ...`.
- **Verifikasi:** seluruh Acceptance criteria §6 + Definition of Done global (00-overview §7).

## 6. Acceptance criteria

Semua harus lulus:

1. [ ] `bun test` hijau di seluruh workspace.
2. [ ] Start core dengan `ENKAKU_DATA_DIR` baru (folder `tools/` tidak ada) → adb ter-download, sha256 terverifikasi, ter-extract, ter-activate otomatis; `GET /api/tools` menunjukkan `adb.activeVersion` terisi; **durasi start→done < 90 detik** (NFR §16).
3. [ ] Selama provision, client WS menerima rangkaian `tool.provision.progress` (`start` → `tool` dengan percent naik → `done`).
4. [ ] `GET /api/tools` menampilkan ketiga tool; `scrcpy-server` & `ui-server` ber-flag `swappable: false` + `managedByCore: true`.
5. [ ] `POST /api/tools/adb/install {version: <non-aktif>}` sukses dengan progress WS; folder `tools/adb/<ver>/platform-tools/adb` ada; baris `tool_installs` bertambah dengan sha256 terisi.
6. [ ] `POST /api/tools/scrcpy-server/install` dan `.../activate` → HTTP 403 `E_NOT_SWAPPABLE`.
7. [ ] `POST /api/tools/adb/activate` menjalankan health check dulu; binary yang sengaja dirusak (truncate file) → `E_HEALTH_CHECK_FAILED`, pointer tidak berubah.
8. [ ] `DELETE /api/tools/adb/<versi-aktif>` → 409 `E_DELETE_ACTIVE`; setelah pindah active ke versi lain, delete versi non-aktif sukses dan folder terhapus.
9. [ ] Artifact dengan sha256 salah (manifest mock di test) → install gagal `E_CHECKSUM_MISMATCH`, tidak ada folder versi tertinggal.
10. [ ] `rg "kill-server" packages/` hanya match `tools/adb-swap.ts` dan test-nya; `rg "spawn\(['\"]adb" packages/` kosong (tidak ada pemakaian adb dari PATH sistem).
11. [ ] Swap versi adb saat `track-devices` jalan: device hilang sesaat lalu terdeteksi lagi, tanpa restart core.
12. [ ] `POST /api/tools/manifest/refresh` tanpa `ENKAKU_TOOLS_MANIFEST_URL` → reload bundled (200); dengan URL mock valid → cache tertulis dan versi baru muncul di `GET /api/tools`.
13. [ ] Pre-baked: salin manual folder `tools/adb/<ver>/…` valid + hapus DB → start core → reconcile meng-adopt tanpa download ulang.
14. [ ] README package terkait terbarui (DoD global 00-overview §7).

## 7. Test plan

### 7.1 Unit test (`bun test`, tanpa network nyata — semua download via `Bun.serve` mock)

| Area | Kasus kunci |
|---|---|
| `types` | parse manifest valid/invalid, placeholder sha256 |
| `manifest` | bundled load, refresh sukses/gagal, `resolveLockedVersion` + `Bun.semver` |
| `paths` | pointer round-trip, korup → null, atomic rename |
| `download` | hash cocok, mismatch → cleanup, progress, no content-length, retry network |
| `extract` | zip + exec bit, path traversal ditolak, raw rename kanonik |
| `manager` | guard swappable (publik vs internal), delete active, health gate activate, reconcile/pre-baked, invariant satu-active |
| `adb-swap` | urutan drain→kill→swap→resume, timeout drain, rollback |
| `routes` | status code + kode error per §4.8 |
| `protocol` | round-trip ketiga message |

### 7.2 Smoke test manual (perintah eksplisit; port core sesuai Plan 01 — contoh memakai `7700`)

**Skenario A — first-run auto-provision (hapus folder tools → start core):**

```bash
export ENKAKU_DATA_DIR="$HOME/.enkaku-m1-smoke"
rm -rf "$ENKAKU_DATA_DIR/tools"            # simulasi first run
# terminal 1: pantau WS (bunx wscat / websocat)
bunx wscat -c ws://localhost:7700/ws       # harus terlihat tool.provision.progress start→tool(percent naik)→done
# terminal 2:
time bun run --cwd packages/core dev       # catat waktu sampai log "provision done" — target < 90s
curl -s localhost:7700/api/tools | jq '.tools[] | {id, activeVersion, swappable}'
# adb.activeVersion terisi; scrcpy-server & ui-server activeVersion null, swappable false
ls "$ENKAKU_DATA_DIR/tools/adb"            # <versi>/ dan active.json
cat "$ENKAKU_DATA_DIR/tools/adb/active.json" | jq
```

**Skenario B — install / activate / swap / delete:**

```bash
curl -s -X POST localhost:7700/api/tools/adb/install \
  -H 'content-type: application/json' -d '{"version":"35.0.2"}' | jq        # 200, progress di WS
curl -s -X POST localhost:7700/api/tools/adb/activate \
  -H 'content-type: application/json' -d '{"version":"35.0.2"}' | jq        # 200; log: drain → kill-server → start-server
adb_active=$(curl -s localhost:7700/api/tools | jq -r '.tools[]|select(.id=="adb").activeVersion')
echo "$adb_active"                                                          # 35.0.2
curl -s -X DELETE localhost:7700/api/tools/adb/35.0.2 | jq                  # 409 E_DELETE_ACTIVE
curl -s -X POST localhost:7700/api/tools/adb/activate \
  -H 'content-type: application/json' -d '{"version":"36.0.0"}' | jq
curl -s -X DELETE localhost:7700/api/tools/adb/35.0.2 | jq                  # 200; folder hilang
curl -s -X POST localhost:7700/api/tools/adb/check | jq                     # health ok:true
```

**Skenario C — guard non-swappable & manifest refresh:**

```bash
curl -s -X POST localhost:7700/api/tools/scrcpy-server/install \
  -H 'content-type: application/json' -d '{"version":"3.3.1"}' | jq         # 403 E_NOT_SWAPPABLE
curl -s -X POST localhost:7700/api/tools/manifest/refresh | jq              # 200 (bundled reload)
ENKAKU_TOOLS_MANIFEST_URL="http://localhost:9999/manifest.json"             # server mock rusak
curl -s -X POST localhost:7700/api/tools/manifest/refresh | jq              # 502 E_MANIFEST_FETCH_FAILED
```

**Skenario D — swap saat device tersambung** (butuh device fisik, tandai `ENKAKU_TEST_DEVICE=1` per 00-overview §4.4): colok device → `GET /api/devices` menunjukkan device → jalankan activate versi lain → pantau WS `device.removed`/`device.added` → device kembali `idle` tanpa restart core.

### 7.3 NFR check

- Ukur skenario A tiga kali (cache DNS hangat): p95 < 90 detik → catat angka di PR (DoD 00-overview §7 poin 5).

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| URL platform-tools ber-versi Google berubah/ditarik (Google mendorong `-latest-`) | Manifest bundled mati → first-run gagal | Verifikasi URL saat isi `TODO-verify`; `manifest/refresh` remote sebagai jalur perbaikan tanpa rilis core; error provision tidak mematikan core (retry manual) |
| Redistribusi/hotlink platform-tools vs ToS Google | Masalah lisensi saat dijual | M1 hanya download dari URL resmi Google (bukan redistribusi). Audit lisensi tetap wajib sebelum jual — spec §7.8/§18, ditangani Plan 10 |
| Download lambat/putus di jaringan buruk → NFR 90s meleset | First impression jelek | Progress jujur di WS (user melihat sesuatu terjadi), idle-timeout + retry 1×, error jelas + tombol retry via `POST install`; NFR diukur di "koneksi wajar" |
| `fflate` tidak membawa unix mode → binary tidak eksekutabel | adb gagal jalan | Blanket `chmod 0o755` hasil extract di POSIX + health check `adb version` sebelum activate menangkap kegagalan |
| Zip path traversal dari mirror jahat | Tulis file di luar folder tool | Tolak entry mengandung `..`/path absolut (`E_EXTRACT_UNSAFE_PATH`) + sha256 wajib membuat artifact tak bisa diganti diam-diam |
| Race: dua request install/activate bersamaan | Folder/pointer korup | Mutex per-toolId di `ToolchainManager` (operasi tool diserialisasi per tool); staging + atomic rename |
| Drain tidak pernah selesai (command adb nyangkut) saat swap | Activate menggantung | Timeout drain 30 detik → batal swap + `E_TOOL_IN_USE`, sistem kembali ke keadaan semula |
| Crash di tengah install/extract | Sisa sampah `.staging` | `.staging/` dibersihkan setiap boot; folder final hanya muncul via rename atomik setelah verifikasi |
| Windows: `%APPDATA%` + rename lintas volume | Rename atomik gagal | `.staging` selalu di bawah `tools/` (volume sama); path win32 dites unit; CI Windows menyusul (Open questions) |

## 9. Open questions

Jangan diputuskan sepihak — butuh keputusan manusia:

1. **Versi & URL final artifact**: nilai `TODO-verify` (versi platform-tools yang dipin, URL ber-versi vs `-latest-`, sha256, `releasedAt`, `compatibleCoreRange` scrcpy-server terhadap skema versi core yang belum ditetapkan). Spec tidak menyebut angka; harus diverifikasi terhadap rilis nyata saat implementasi.
2. **`linux-arm64` untuk adb**: Google tidak merilis platform-tools linux-arm64 resmi, padahal target SBC arm64 disebut di spec §2/§16. Opsi: (a) tunda support (error jelas `E_PLATFORM_UNSUPPORTED`), (b) mirror build komunitas di manifest remote kita (implikasi trust/lisensi). Rekomendasi sementara: (a) di M1.
3. **Audit log operasi tool**: spec §14 mencatat `tool.activate` di `audit_log`, tapi tabel & auth baru ada di Plan 09. Tulis baris audit tanpa `userId` sejak M1, atau tunda seluruhnya ke Plan 09?
4. **Kanal konfigurasi `ENKAKU_TOOLS_MANIFEST_URL`**: cukup env var di M1, atau harus masuk settings farm-wide (Studio Settings, Plan 07)? Rekomendasi: env dulu, migrasi ke settings di Plan 07.
5. **Perilaku bila manifest refresh menghapus versi yang sudah ter-install**: tetap tampilkan sebagai installed-but-unlisted (rekomendasi) atau tandai deprecated? Spec diam.
6. **CI Windows**: konvensi test 00-overview belum menyebut matrix OS; pointer `active.json` dipilih justru demi Windows — kapan CI Windows ditambahkan?
