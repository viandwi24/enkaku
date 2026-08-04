# Plan 07 — M5 : Studio Lengkap (schema-driven UI, registry, scripts/jobs/tools/settings, battery & auto-quarantine)

> Status: implemented — schema-driven `SchemaForm` renderer shipped and used across engine config, device settings, script params, and farm settings
> Ships: packages/studio/src/components/schema-form/SchemaForm.tsx
> **Depends on:** Plan 01 (core + registry device + WS), Plan 02 (Toolchain Manager + API §7.7), Plan 03 (live view dasar + enrollment wizard), Plan 04 (state machine, lease, queue), Plan 05 (`defineScript`, runner, artifact/log, publish bundle), Plan 06 (`ui-server` inspector).
> **Referensi spec:** §8 (registry & schema-driven UI), §9.5 (capability locks), §7.7 (API tools), §11.4–11.5 (publish & lifecycle script), §12 (data model, DeviceSettings), §13 (protokol), §15.2 (battery/thermal + auto-quarantine), §19 (spec layar Studio — SEMUA baris), §20 baris M5.

---

## 1. Goals

Setelah plan ini selesai, semua pernyataan berikut TRUE dan bisa didemokan:

- **Schema-driven form renderer** ada di Studio: satu komponen `SchemaForm` yang me-render form lengkap dari JSON Schema (di-generate dari Zod di core), dipakai di ≥ 4 tempat tanpa UI hardcode: (a) config engine per-device, (b) DeviceSettings per-device, (c) form params saat run script, (d) settings farm-wide.
- `GET /api/registry` mengembalikan `transports/displays/inputs/inspectors/tools` lengkap dengan `configSchema` (JSON Schema), `capabilities`, dan `locks` sesuai spec §8; Studio memakai capability + locks untuk men-disable kombinasi engine yang invalid di dropdown driver — dan core tetap menolak kombinasi invalid di sisi server (server-authoritative).
- **Scripts UI** lengkap: list, detail (source bundle read-only + edit metadata), versioning (lihat & aktifkan versi), enable/disable, delete, RUN dengan form param auto-generated dari `paramsSchema`, riwayat job per script, dan alur publish terdokumentasi di UI (petunjuk SDK CLI `enkaku publish`).
- **Job/run detail page** lengkap: status live, log realtime via WS `job.log`, artifacts gallery (preview screenshot + download), hasil/error terstruktur, tombol cancel.
- **Tools UI** sesuai spec §19: per tool versi terpasang + tersedia, install/update/activate/delete dengan progress bar (WS), health check, refresh manifest; `scrcpy-server` tampil **"managed by core"** read-only (`swappable: false`).
- **Settings page**: farm-wide defaults (default driver/timing/input mode) schema-driven, retention policy tampil sebagai placeholder (aktif di Plan 09), backup/restore DB berjalan aman (core pause writes saat backup, restore tervalidasi).
- **Battery/thermal**: core mem-poll `dumpsys battery` per device online (interval configurable, default 60 s), menyimpan kolom `devices.battery` (JSON), broadcast WS; dashboard menampilkan badge baterai/suhu; **auto-quarantine** saat suhu > threshold (default 45 °C, configurable) → status `quarantined`, keluar dari pool scheduler, event WS; **manual un-quarantine** tersedia di UI.
- **Dashboard final**: grid device dengan thumbnail live opsional, status lengkap (`idle/manual/busy/offline/quarantined`), owner, badge baterai/suhu, quick action control/run.
- **Device detail final**: panel pilih driver (dropdown divalidasi capability + locks), pilihan input mode `uhid/sdk/aoa` (uhid/aoa tampil **disabled** dengan keterangan "tersedia mulai Plan 08 / Plan 11"), per-device settings schema-driven, tombol prep (disable animations, stay awake dari `DeviceSettings.prep`), badge "automation running" saat `busy`.
- `bun test` hijau; unit test renderer per tipe field lulus; checklist e2e manual per layar (§7.2) lulus semua.

## 2. Non-goals

Sengaja TIDAK dikerjakan di plan ini:

- **Engine scrcpy** (display H.264, input `scrcpy-uhid`/`scrcpy-sdk`, WebCodecs) → Plan 08. Di M5 display tetap `screencap-loop`, input tetap `adb-input`. Registry sudah *mendaftarkan* engine scrcpy sebagai entri `available: false` supaya UI bisa menampilkannya disabled — implementasinya tetap Plan 08.
- **Input `scrcpy-aoa`** → Plan 11. Sama: hanya entri disabled di registry.
- **Auth/ACL, TLS, halaman user management** → Plan 09. Settings §19 baris "user & ACL (admin)" di-stub sebagai section kosong dengan keterangan.
- **Retention/GC artifact yang benar-benar menghapus file** → Plan 09. Di sini hanya *placeholder UI* (schema + form tampil, tersimpan, tapi enforcement off dan diberi banner "aktif di M7").
- **Charge limiting** (spec §15.2 backlog) → tidak dikerjakan; hanya dicatat.
- **Editor kode script di browser (menulis source)** — spec §11.5 mengarahkan authoring ke editor sendiri + publish bundle (§11.4). "Editor" di Studio = view source bundle read-only + edit metadata. Live editing source di browser TIDAK dibangun.
- **Jobs list global / halaman antrian farm-wide** — spec §19 hanya menyebut riwayat job per script + job detail. Kalau ternyata perlu, catat dulu (lihat §9).
- **Video recording per session** (spec §22 future).

## 3. Konteks & keputusan desain

1. **Zod → JSON Schema: pakai `z.toJSONSchema()` native Zod v4** (bukan library `zod-to-json-schema`). Alasan: (a) sejak Zod v4 konversi JSON Schema adalah API first-party yang di-maintain upstream, (b) tanpa dependency tambahan, (c) output default draft 2020-12 — `z.tuple([z.number(), z.number()])` menjadi `prefixItems` yang bisa dideteksi renderer sebagai field "range [min,max]". Konsekuensi: repo harus di Zod ≥ 4 (sudah keputusan sejak Plan 01; kalau ternyata masih Zod 3, upgrade dulu di tahap 5.1 — `zod-to-json-schema` hanya fallback darurat dan harus dicatat di Open questions bila terpaksa).
2. **Schema di-generate di core, dikirim sebagai JSON Schema ke Studio.** Studio TIDAK meng-import Zod schema engine/settings secara langsung — kalau iya, "nambah engine = nambah kode UI", melanggar prinsip §8. Studio hanya tahu JSON Schema generik. Satu-satunya pengecualian: tipe TS untuk *envelope* response (dari `@enkaku/protocol`).
3. **Validasi dua lapis, server tetap authoritative** (spec §2). Renderer melakukan validasi client-side ringan dari JSON Schema (required, min/max, enum, tipe) untuk UX; core selalu `.parse()` ulang dengan Zod asli dan mengembalikan error ber-path yang dipetakan balik ke field.
4. **Capability + locks dievaluasi di dua tempat dengan satu implementasi.** Fungsi murni `validateEngineSelection()` ditaruh di `@enkaku/protocol` (shared), dipakai Studio untuk disable dropdown dan dipakai core untuk reject `PATCH /api/devices/:id/drivers`. UI yang salah tetap tidak bisa merusak (spec §9.5: session manager menolak lock ganda).
5. **Registry mendaftarkan engine yang belum tersedia** dengan `available: false` + `unavailableReason`. Ini cara schema-driven untuk memenuhi requirement "uhid/aoa tampil disabled dengan keterangan" tanpa hardcode daftar engine di Studio.
6. **Battery poller di core, bukan di Studio.** Polling `dumpsys battery` lewat per-device command queue (Plan 01) sehingga tidak menabrak operasi lain; hasil disimpan di kolom `devices.battery` dan di-broadcast. Auto-quarantine adalah keputusan core (server-authoritative), Studio hanya menampilkan.
7. **`quarantined` persist di DB.** Device yang di-quarantine tetap quarantined melewati disconnect/reconnect/restart core sampai admin un-quarantine manual (spec §15.2 tidak menyebut auto-recovery; lihat Open questions untuk hysteresis).
8. **Backup DB = snapshot konsisten dengan pause writes.** Urutan: pause scheduler + tolak enqueue/write API sementara (HTTP 503 `BACKUP_IN_PROGRESS`) → `VACUUM INTO` ke file temp (snapshot transaksional SQLite) → resume → stream file. Restore hanya dari upload yang lolos `PRAGMA integrity_check` + cek versi migrasi, dengan drain penuh subsistem. Detail §4.8.
9. **Versioning script pakai tabel `script_versions`.** Spec §11.5 mensyaratkan versioning tapi §12 hanya punya satu row per script. Keputusan: `scripts` menyimpan metadata + pointer versi aktif; setiap publish menambah row `script_versions` (bundle + paramsSchema per versi). "Aktifkan versi lama" = pindah pointer. Ini penambahan minimal yang dibutuhkan fitur yang memang ada di spec.
10. **Thumbnail dashboard opsional & hemat.** Sebelum scrcpy (Plan 08), thumbnail = screenshot `screencap` per device dengan interval jarang (default 10 s) dan **off by default** (toggle di dashboard) — 10 device × screencap serentak itu mahal di adb; jangan jadikan default.

## 4. Desain teknis

### 4.1 Generasi JSON Schema di core

```ts
// packages/core/src/registry/json-schema.ts
import { z } from 'zod'

/** Konversi Zod → JSON Schema utk dikirim ke Studio. Selalu lewat fungsi ini
 *  (satu titik konfigurasi target draft & io mode). */
export function toFormSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
}
```

Subset JSON Schema yang WAJIB didukung renderer (kontrak antara core & Studio — engine author hanya boleh memakai konstruksi Zod yang menghasilkan subset ini):

| Konstruksi Zod | Hasil JSON Schema | Field UI |
|---|---|---|
| `z.string()` (+ `.min/.max/.regex`) | `type: "string"` (+ `minLength/maxLength/pattern`) | text input |
| `z.number()/z.int()` (+ `.min/.max`) | `type: "number"/"integer"` (+ `minimum/maximum`) | number input |
| `z.boolean()` | `type: "boolean"` | switch/checkbox |
| `z.enum([...])` | `enum: [...]` | select |
| `z.tuple([z.number(), z.number()])` | `type: "array"`, `prefixItems: [{number},{number}]`, `minItems/maxItems: 2` | **range field** dua input "min–max" |
| `z.object({...})` (nested bebas) | `type: "object"`, `properties`, `required` | fieldset ber-judul, rekursif |
| `z.array(scalar)` | `type: "array"`, `items: {scalar}` | list add/remove |
| `.default(v)` | `default: v` | prefill + tombol "reset ke default" |
| `.describe('...')` | `description` | help text di bawah label |
| `.optional()` | hilang dari `required` | field boleh kosong |

Node di luar subset (union kompleks, record, dsb.) → renderer menampilkan `UnsupportedField`: JSON textarea + warning kuning ("tipe belum didukung renderer — edit sebagai JSON"), **tidak pernah** silently drop. Ini safety net, bukan izin memakai tipe aneh.

### 4.2 Komponen `SchemaForm` (Studio)

```ts
// packages/studio/src/components/schema-form/types.ts
export interface FieldError { path: (string | number)[]; message: string }

export interface SchemaFormProps {
  schema: Record<string, unknown>          // JSON Schema (draft 2020-12) dari core
  value: unknown                            // nilai saat ini (uncontrolled default dari schema kalau undefined)
  onChange: (next: unknown) => void
  onSubmit?: (value: unknown) => void | Promise<void>
  submitLabel?: string                      // default "Simpan"
  disabled?: boolean                        // read-only mode (mis. saat device busy)
  serverErrors?: FieldError[]               // error Zod dari core, dipetakan ke field via path
  idPrefix?: string                         // unik per form di satu halaman
}
```

Struktur file:

```
packages/studio/src/components/schema-form/
  SchemaForm.tsx          # entry: resolve defaults, dispatch per-node, kelola state error
  resolve.ts              # applyDefaults(schema), getNodeKind(schemaNode) → 'string'|'number'|...
  validate.ts             # validasi client-side dari JSON Schema (required/min/max/enum/pattern)
  types.ts
  fields/
    StringField.tsx
    NumberField.tsx
    BooleanField.tsx
    EnumField.tsx
    RangeTupleField.tsx   # tuple [min,max] → dua input + validasi min ≤ max
    ObjectField.tsx       # fieldset rekursif (judul = key / schema.title, indentasi)
    ArrayField.tsx        # array skalar: add/remove/reorder sederhana
    UnsupportedField.tsx  # JSON textarea + warning
```

Perilaku wajib:

- `applyDefaults()` mengisi nilai awal dari `default` schema secara rekursif saat `value === undefined`.
- Validasi client on-blur + on-submit; submit di-block kalau ada error client, TAPI error server (`serverErrors`) selalu ditampilkan di field yang sesuai path (fallback: banner atas form kalau path tak ketemu).
- `description` dirender sebagai help text; label = `title` schema atau key yang di-humanize (`tapJitterMs` → "Tap Jitter Ms").
- Deterministik: schema sama + value sama ⇒ DOM sama (dipakai snapshot test).

### 4.3 `GET /api/registry` (spec §8)

Tipe response (dideklarasikan sebagai Zod di `packages/protocol/src/registry.ts`, di-export juga sebagai TS type):

```ts
export const RegistryEngineEntry = z.object({
  id: z.string(),                     // 'adb-usb' | 'screencap-loop' | 'scrcpy' | ...
  displayName: z.string(),
  capabilities: z.array(z.string()),  // mis. ['wireless'], ['video-h264'], ['hardware-like-input']
  locks: z.array(z.string()),         // resource locks spec §9.5, mis. ['input-injection']
  requires: z.array(z.string()).default([]),   // capability yg wajib disediakan engine lain
                                               // (mis. inspector appium requires 'appium-session')
  configSchema: z.record(z.string(), z.unknown()), // JSON Schema (bisa object kosong)
  available: z.boolean(),             // false = terdaftar tapi belum diimplementasi
  unavailableReason: z.string().optional(),    // "Tersedia mulai M6 (Plan 08)" dst.
})

export const RegistryResponse = z.object({
  transports:  z.array(RegistryEngineEntry),
  displays:    z.array(RegistryEngineEntry),
  inputs:      z.array(RegistryEngineEntry),
  inspectors:  z.array(RegistryEngineEntry),
  tools:       z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    swappable: z.boolean(),
  })),
})
export type RegistryResponse = z.infer<typeof RegistryResponse>
```

Isi registry pada akhir M5 (entri `available:false` disiapkan di sini agar UI future-proof):

| Kategori | id | available | locks | Catatan |
|---|---|---|---|---|
| transports | `adb-usb`, `adb-tcp` | ✅ | — | dari Plan 01 |
| displays | `screencap-loop` | ✅ | — | dari Plan 03 |
| displays | `scrcpy` | ❌ Plan 08 | `video-encoder` | |
| inputs | `adb-input` | ✅ | `input-injection` | |
| inputs | `scrcpy-uhid`, `scrcpy-sdk` | ❌ Plan 08 | `input-injection` | |
| inputs | `scrcpy-aoa` | ❌ Plan 11 | `input-injection` | |
| inspectors | `ui-server` | ✅ | `instrumentation` | dari Plan 06 |
| inspectors | `uiautomator-dump` | ✅ (fallback) | `instrumentation` | dari Plan 05 |
| inspectors | `appium` | ❌ Plan 11 | `instrumentation`, `input-injection` | konflik dgn input scrcpy (§9.5) |

Validator shared:

```ts
// packages/protocol/src/engine-selection.ts
export interface EngineSelection { transport: string; display: string; input: string; inspection: string }

export function validateEngineSelection(
  registry: RegistryResponse, sel: EngineSelection,
): { ok: true } | { ok: false; code: 'UNKNOWN_ENGINE'|'ENGINE_UNAVAILABLE'|'LOCK_CONFLICT'|'REQUIREMENT_MISSING'; message: string } {
  // 1) semua id ada di registry; 2) semua available; 3) union locks tidak ada duplikat
  // antar engine BERBEDA; 4) tiap `requires` terpenuhi oleh capability engine terpilih lain.
  ...
}
```

Studio memanggil ini saat user membuka dropdown (opsi yang bikin invalid → disabled + tooltip alasan); core memanggil ini di handler `PATCH /api/devices/:id/drivers` dan mengembalikan `{ error: { code, message } }` bila gagal.

### 4.4 Perubahan DB & schema (Drizzle migration)

```ts
// packages/core/src/db/schema.ts — perubahan Plan 07
// (1) devices.battery — BARU (spec §12 sudah mencantumkan; kolom baru diaktifkan di sini)
battery: text('battery', { mode: 'json' }).$type<BatteryState>(),
// (2) devices.status — tambah nilai 'quarantined' (CHECK/enum level aplikasi)
// (3) devices.quarantineReason — BARU, text nullable ('thermal:47.3C @ 2026-08-01T…' / null)

// (4) farm_settings — BARU: single-row JSON tervalidasi Zod
export const farmSettings = sqliteTable('farm_settings', {
  id:        integer('id').primaryKey(),               // selalu 1
  value:     text('value', { mode: 'json' }).$type<FarmSettings>().notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// (5) script_versions — BARU (keputusan desain #9)
export const scriptVersions = sqliteTable('script_versions', {
  id:           text('id').primaryKey(),
  scriptId:     text('script_id').notNull(),
  version:      text('version').notNull(),             // unique(scriptId, version)
  bundle:       text('bundle').notNull(),
  paramsSchema: text('params_schema', { mode: 'json' }),
  publishedBy:  text('published_by'),
  publishedAt:  integer('published_at', { mode: 'timestamp' }),
})
// scripts.bundle/paramsSchema/version menjadi cache dari versi AKTIF (di-update saat activate).
```

Zod baru di `packages/protocol/src/`:

```ts
export const BatteryState = z.object({
  level: z.number().min(0).max(100),
  temperatureC: z.number(),                  // dumpsys 'temperature' (deci-°C) / 10
  status: z.enum(['charging', 'discharging', 'not_charging', 'full', 'unknown']),
  health: z.enum(['good', 'overheat', 'dead', 'over_voltage', 'cold', 'unknown']),
  voltageMv: z.number().optional(),
  updatedAt: z.number(),                     // unix detik
})

export const FarmSettings = z.object({
  defaults: z.object({
    transport:  z.string().default('adb-usb').describe('Transport default device baru'),
    display:    z.string().default('screencap-loop'),
    input:      z.string().default('adb-input'),       // jadi 'scrcpy-uhid' saat Plan 08
    inspection: z.string().default('ui-server'),
    timing: z.object({                                  // default farm utk DeviceSettings.timing
      tapJitterMs:     z.tuple([z.number(), z.number()]).default([40, 120]),
      betweenActionMs: z.tuple([z.number(), z.number()]).default([300, 900]),
      coordJitterPx:   z.number().default(2),
    }),
    inputMode: z.enum(['uhid', 'sdk', 'aoa']).default('uhid'),
  }),
  battery: z.object({
    pollIntervalSec:   z.number().int().min(10).default(60).describe('Interval poll dumpsys battery'),
    autoQuarantine:    z.boolean().default(true),
    tempThresholdC:    z.number().default(45).describe('Suhu > threshold → auto-quarantine'),
  }),
  retention: z.object({                                 // PLACEHOLDER — enforcement Plan 09
    enabled:      z.boolean().default(false),
    maxAgeDays:   z.number().int().default(30),
    maxTotalGb:   z.number().default(20),
  }).describe('Retention artifact — aktif mulai M7 (Plan 09)'),
})
```

`DeviceSettings` (spec §12) sudah ada di protocol sejak Plan 01/04 — Plan 07 hanya meng-expose JSON Schema-nya via registry/endpoint (bukan mengubah bentuknya).

### 4.5 Endpoint REST baru/berubah (core, Hono)

```
GET    /api/registry                          → RegistryResponse (§4.3)
GET    /api/settings                          → { value: FarmSettings, schema: JsonSchema }
PUT    /api/settings                          → body FarmSettings (Zod parse; error ber-path)

GET    /api/devices/:id/settings              → { value: DeviceSettings, schema: JsonSchema }
PUT    /api/devices/:id/settings              → body DeviceSettings
PATCH  /api/devices/:id/drivers               → { transport?, display?, input?, inspection?, config? }
                                                 validateEngineSelection + Zod parse configSchema
POST   /api/devices/:id/prep                  → jalankan prep dari DeviceSettings.prep
                                                 (settings put animation_scale 0 ×3, svc power stayon usb)
POST   /api/devices/:id/unquarantine          → status quarantined → offline/idle; audit log
GET    /api/devices/:id/thumbnail             → JPEG screencap terakhir (cache ≤ thumbnailIntervalSec)

GET    /api/scripts                           → list + versi aktif + enabled + jumlah job
GET    /api/scripts/:id                       → detail + versions[] + paramsSchema versi aktif
PATCH  /api/scripts/:id                       → edit metadata: { name?, enabled? }
POST   /api/scripts/:id/versions/:ver/activate→ pindah pointer versi aktif
DELETE /api/scripts/:id                       → tolak kalau ada job queued/running utk script ini
GET    /api/scripts/:id/jobs?limit&offset     → riwayat job script
POST   /api/scripts/:id/run                   → { deviceId, params } → Zod(paramsSchema versi aktif)
                                                 → enqueue (Plan 04) → { jobId }

GET    /api/jobs/:id                          → status, result, error, timestamps, deviceId, scriptId+version
GET    /api/jobs/:id/log?offset               → backfill log (runner Plan 05 menulis file log per job)
GET    /api/jobs/:id/artifacts                → list artifacts (kind, label, sizeBytes)
GET    /api/artifacts/:id/download            → stream file (Content-Disposition)
POST   /api/jobs/:id/cancel                   → dari Plan 04; dipastikan ter-expose

GET    /api/system/backup                     → snapshot .db (lihat §4.8)
POST   /api/system/restore                    → multipart upload + { confirm: true } (lihat §4.8)
```

Endpoint tools TIDAK berubah — persis spec §7.7, sudah ada sejak Plan 02; Plan 07 hanya membangun UI-nya (+ memastikan event progress ada, §4.6).

### 4.6 Message WS baru (di `packages/protocol`, discriminated union)

```
device.battery        { deviceId, battery: BatteryState }            // tiap poll yg berubah signifikan
device.quarantined    { deviceId, reason: string, temperatureC }     // + device.status ikut berubah
device.unquarantined  { deviceId, by?: string }
tool.progress         { toolId, version, phase: 'download'|'verify'|'extract', pct }  // pastikan ada
                       (kalau Plan 02 belum meng-emit ini, tambahkan di plan ini — perubahan kecil di
                        toolchain installer: callback progress → broadcast)
job.log / job.status / job.artifact                                   // sudah ada (Plan 04/05), dipakai UI
```

Aturan broadcast `device.battery`: kirim kalau `level` berubah, `status` berubah, atau `temperatureC` berubah ≥ 0.5 °C — hindari spam WS di farm 10 device.

### 4.7 Battery poller & auto-quarantine (core)

```
packages/core/src/battery/
  parse-dumpsys.ts    # parse output `dumpsys battery` → BatteryState (pure, unit-tested)
  poller.ts           # loop per device online; pakai per-device command queue Plan 01
  quarantine.ts       # keputusan quarantine/unquarantine + transisi status + audit + WS
```

- **Poll**: setiap `pollIntervalSec` (dari FarmSettings, live-reload saat settings berubah), untuk device `status != 'offline'`: `adb -s <serial> shell dumpsys battery` via per-device queue (prioritas rendah — tidak menyalip input manual/heartbeat). Parse mapping: `temperature: 312` → 31.2 °C; `status: 2→charging, 3→discharging, 4→not_charging, 5→full, else unknown`; `health: 2→good, 3→overheat, 4→dead, 5→over_voltage, 7→cold, else unknown`. Simpan ke `devices.battery`, broadcast sesuai aturan §4.6.
- **Auto-quarantine**: jika `autoQuarantine && temperatureC > tempThresholdC`:
  - Device `idle`/`manual` → langsung `quarantined` (lease manual di-revoke, client dapat `device.status`).
  - Device `busy` → job berjalan **dibiarkan selesai** (cancel tersedia manual); flag internal `pendingQuarantine` → saat release lease, transisi ke `quarantined` alih-alih `idle`. (Alasan: kill paksa merusak `finish`-cleanup script; kalau darurat, operator bisa cancel job dari UI.)
  - Tulis `devices.quarantineReason`, `audit_log(action: 'device.quarantine', meta:{tempC})`, broadcast `device.quarantined`.
- **Scheduler**: query claim job Plan 04 sudah memfilter `d.status='idle'` (spec §10.3) → `quarantined` otomatis keluar dari pool. Tambahkan guard eksplisit di enqueue: run manual ke device quarantined ditolak `DEVICE_QUARANTINED`.
- **Persist**: `quarantined` tersimpan di DB. Reconnect/restart: device yang tercatat quarantined TIDAK kembali ke `idle` — track-devices handler mengecek kolom status sebelum menaikkan ke idle.
- **Un-quarantine manual**: `POST /api/devices/:id/unquarantine` → status jadi `idle` (kalau online) / `offline`, clear reason, audit, broadcast.

### 4.8 Backup / restore DB (aman)

**Backup — `GET /api/system/backup`:**
1. `system.pauseWrites()`: scheduler pause (tidak claim job baru), semua endpoint mutasi (POST/PUT/PATCH/DELETE kecuali cancel) balas `503 { error: { code: 'BACKUP_IN_PROGRESS' } }`, tunggu transaksi single-writer aktif selesai (drain write queue, timeout 10 s → abort backup).
2. `VACUUM INTO '<data-dir>/backup/enkaku-<ISO timestamp>.db'` — snapshot transaksional konsisten.
3. `resumeWrites()` segera setelah VACUUM selesai (sebelum streaming — file snapshot sudah lepas dari DB hidup).
4. Stream file sebagai download (`enkaku-backup-2026-08-01T10-00.db`), lalu hapus file temp setelah stream selesai.
5. Catatan eksplisit di UI: backup berisi DB saja, **artifact files tidak ikut** (folder `artifacts/` terpisah — lihat Open questions).

**Restore — `POST /api/system/restore` (multipart, field `file` + `confirm=true`):**
1. Simpan upload ke temp; validasi: `PRAGMA integrity_check` == ok, tabel wajib ada, versi migrasi Drizzle ≤ versi core (kalau lebih tua → jalankan migrasi setelah swap; lebih baru → tolak `RESTORE_INCOMPATIBLE`).
2. Drain penuh: pause scheduler, tolak job baru, tunggu job running selesai/cancel (UI menampilkan daftar job yang masih jalan; operator memutuskan), putuskan lease manual.
3. Tutup koneksi SQLite → rename `enkaku.db` → `enkaku.db.pre-restore-<ts>` → pindahkan file upload jadi `enkaku.db` → reopen + `migrate()` → re-init subsistem (device registry re-sync dari track-devices) → resume.
4. Audit log `system.restore`. Respons menyarankan restart core untuk kebersihan penuh; UI menampilkan tombol/instruksi.
5. Sebelum auth ada (Plan 09), kedua endpoint hanya boleh diakses dari bind localhost (konsisten trust model spec §14 mode lokal).

### 4.9 Struktur route & komponen Studio (Next.js App Router)

| Route | Layar (spec §19) |
|---|---|
| `/` | Dashboard (grid device) |
| `/devices/[id]` | Device detail / live control |
| `/enroll` | Enrollment wizard (sudah ada — Plan 03; tidak diubah) |
| `/scripts` | Scripts list |
| `/scripts/[id]` | Script detail (source, versi, metadata, riwayat job, run) |
| `/jobs/[id]` | Job / run detail |
| `/tools` | Toolchain manager |
| `/settings` | Settings farm-wide + backup/restore |

```
packages/studio/src/
  app/
    page.tsx                          # Dashboard
    devices/[id]/page.tsx
    scripts/page.tsx
    scripts/[id]/page.tsx
    jobs/[id]/page.tsx
    tools/page.tsx
    settings/page.tsx
  components/
    schema-form/...                   # §4.2
    registry/useRegistry.ts           # fetch + cache /api/registry (SWR/context)
    devices/DeviceCard.tsx            # grid item: thumbnail, status, owner, badge baterai
    devices/BatteryBadge.tsx          # level % + suhu; merah kalau > threshold−3°C
    devices/StatusBadge.tsx           # idle/manual/busy/offline/quarantined
    devices/DriverPanel.tsx           # 4 dropdown + SchemaForm config engine
    devices/InputModePicker.tsx       # uhid/sdk/aoa dari registry.available
    scripts/ScriptRunForm.tsx         # SchemaForm dari paramsSchema + pilih device
    scripts/PublishHint.tsx           # instruksi `enkaku publish` (SDK CLI)
    jobs/JobLogView.tsx               # backfill REST + append WS job.log, autoscroll
    jobs/ArtifactGallery.tsx          # grid preview screenshot + download
    tools/ToolCard.tsx                # versi terpasang/tersedia, aksi, progress WS
    ws/useWs.ts                       # koneksi /ws + subscribe per message type (dari Plan 03, extend)
```

## 5. Langkah implementasi

### Tahap 5.1 — Protocol: schema & message baru

- [ ] `packages/protocol/src/registry.ts`: `RegistryEngineEntry`, `RegistryResponse` (§4.3).
- [ ] `packages/protocol/src/engine-selection.ts`: `validateEngineSelection()` pure function + tipe hasil.
- [ ] `packages/protocol/src/battery.ts`: `BatteryState`.
- [ ] `packages/protocol/src/farm-settings.ts`: `FarmSettings` (§4.4).
- [ ] Tambah message WS `device.battery`, `device.quarantined`, `device.unquarantined`, `tool.progress` ke discriminated union protocol.
- [ ] Pastikan repo di Zod ≥ 4 (`z.toJSONSchema` tersedia); kalau belum, upgrade + jalankan seluruh test workspace.
- [ ] **Verifikasi:** `bun test packages/protocol` hijau; `validateEngineSelection` unit test lulus (kombinasi valid, lock conflict appium×adb-input, unavailable, unknown id).

### Tahap 5.2 — Core: registry + JSON Schema endpoint

- [ ] `packages/core/src/registry/json-schema.ts`: `toFormSchema()` (§4.1).
- [ ] `packages/core/src/registry/entries.ts`: daftar engine sesuai tabel §4.3 — engine tersedia mengambil `configSchema` dari Zod config masing-masing driver (`packages/drivers`), engine `available:false` pakai schema kosong `{}` + `unavailableReason`.
- [ ] `packages/core/src/http/routes/registry.ts`: `GET /api/registry` (validasi output dengan `RegistryResponse.parse` di dev mode).
- [ ] `packages/core/src/http/routes/devices.ts`: `PATCH /api/devices/:id/drivers` → `validateEngineSelection` + parse `config` terhadap Zod engine → simpan; tolak saat device `busy`.
- [ ] **Verifikasi:** `curl :PORT/api/registry | jq` menampilkan 5 kategori; `PATCH` dengan inspector `appium` → `ENGINE_UNAVAILABLE` (karena `available:false`); simulasi lock-conflict di unit test (dua engine `input-injection`) → `LOCK_CONFLICT`; kombinasi valid tersimpan.

### Tahap 5.3 — Studio: SchemaForm renderer

- [ ] Buat seluruh file `packages/studio/src/components/schema-form/` (§4.2): `resolve.ts`, `validate.ts`, `SchemaForm.tsx`, 8 field component.
- [ ] Setup test komponen: `bun test` + `happy-dom` + `@testing-library/react` di `packages/studio` (preload di `bunfig.toml` studio).
- [ ] Unit test per tipe field (lihat §7.1) + snapshot render `FarmSettings` & `DeviceSettings` schema.
- [ ] Halaman dev-only `/dev/schema-form` (atau Storybook-lite sederhana) untuk inspeksi manual semua field type — boleh di belakang `NODE_ENV !== 'production'`.
- [ ] **Verifikasi:** semua unit test field lulus; buka `/dev/schema-form`, isi form DeviceSettings, nilai `onChange` sesuai (cek via JSON preview di halaman itu).

### Tahap 5.4 — Core: farm settings + device settings endpoint

- [ ] Migration Drizzle: tabel `farm_settings`, kolom `devices.battery`, `devices.quarantine_reason` (§4.4) + `script_versions`.
- [ ] `packages/core/src/settings/farm-settings.ts`: load (seed default via `FarmSettings.parse({})` kalau row belum ada), save, subscribe perubahan (battery poller & scheduler butuh live value).
- [ ] Routes `GET/PUT /api/settings`, `GET/PUT /api/devices/:id/settings` — response menyertakan `schema` hasil `toFormSchema()`; PUT mengembalikan error Zod ber-path (`{ error: { code:'VALIDATION', issues:[{path,message}] } }`).
- [ ] `POST /api/devices/:id/prep`: eksekusi perintah prep sesuai `DeviceSettings.prep` (`settings put global window_animation_scale 0` + transition + animator bila `disableAnimations`; `svc power stayon usb` bila `stayAwake`), lewat per-device queue.
- [ ] **Verifikasi:** `curl PUT /api/settings` dengan `tempThresholdC: "abc"` → 400 dengan `issues[0].path == ['battery','tempThresholdC']`; prep terlihat efeknya di device (`settings get global window_animation_scale` == 0).

### Tahap 5.5 — Core: battery poller + auto-quarantine

- [ ] `packages/core/src/battery/parse-dumpsys.ts` + fixture output nyata (≥ 2 vendor) di test.
- [ ] `packages/core/src/battery/poller.ts`: loop interval dari FarmSettings; skip device offline; simpan + broadcast sesuai aturan §4.6.
- [ ] `packages/core/src/battery/quarantine.ts`: transisi (§4.7) termasuk `pendingQuarantine` untuk device busy; integrasi ke state machine Plan 04 (release lease → cek pending).
- [ ] Guard scheduler/enqueue: `DEVICE_QUARANTINED` saat run ke device quarantined; track-devices reconnect tidak menaikkan device quarantined ke idle.
- [ ] `POST /api/devices/:id/unquarantine` + audit log kedua arah.
- [ ] **Verifikasi:** dengan device nyata: `adb shell dumpsys battery set temp 480` (mock suhu 48 °C) → dalam ≤ 1 interval device jadi `quarantined`, WS event terlihat, enqueue ditolak; `dumpsys battery reset` + un-quarantine via curl → kembali idle.

### Tahap 5.6 — Studio: Dashboard final

- [ ] `app/page.tsx` + `DeviceCard`, `StatusBadge`, `BatteryBadge`: grid semua device; data awal REST, update via WS (`device.status`, `device.battery`, `device.quarantined`).
- [ ] Thumbnail live opsional: toggle di header dashboard (persist localStorage), ON → tiap card fetch `GET /api/devices/:id/thumbnail` per 10 s; OFF (default) → placeholder ikon.
- [ ] Quick action per card: **Control** (→ `/devices/[id]`), **Run** (dropdown script enabled → `/scripts/[id]` dengan device terpilih). Card quarantined: badge merah + reason tooltip + tombol "Un-quarantine" (confirm dialog).
- [ ] Endpoint `GET /api/devices/:id/thumbnail` di core (screencap cached, 404 kalau offline).
- [ ] **Verifikasi:** cabut USB → card jadi offline realtime; mock suhu tinggi → badge merah + status quarantined tanpa refresh; un-quarantine dari card berhasil.

### Tahap 5.7 — Studio: Device detail final

- [ ] `app/devices/[id]/page.tsx`: pertahankan live view + klik dari Plan 03; tambah panel kanan ber-tab: **Driver**, **Settings**, **Info**.
- [ ] `DriverPanel.tsx`: 4 dropdown dari `useRegistry()`; opsi disabled + tooltip via `validateEngineSelection` (unavailable → `unavailableReason`; konflik → pesan lock). Di bawah tiap dropdown: `SchemaForm` dari `configSchema` engine terpilih. Simpan → `PATCH /api/devices/:id/drivers`; error server tampil per-field.
- [ ] `InputModePicker.tsx`: radio `uhid/sdk/aoa` (nilai `DeviceSettings.input.preferredMode`); `uhid` & `aoa` disabled dengan keterangan "Tersedia mulai M6 (Plan 08)" / "M8 (Plan 11)" — status diambil dari `available` engine input terkait di registry, bukan hardcode.
- [ ] Tab Settings: `SchemaForm` dari `GET /api/devices/:id/settings` → PUT; tombol **Prep device** (POST prep, hasil per-langkah ditampilkan).
- [ ] Saat `busy`: seluruh panel driver/settings `disabled`, badge "automation running" + link ke job aktif; video tetap jalan (core sudah reject input — spec §10.1).
- [ ] **Verifikasi:** pilih inspector `appium` → disabled (unavailable); ubah timing tapJitterMs via form → tersimpan (cek `GET`); jalankan job dummy → panel disabled + badge muncul, selesai → aktif lagi.

### Tahap 5.8 — Core + Studio: Scripts UI & versioning

- [ ] Core: migrasi alur publish Plan 05 → tulis juga `script_versions`; endpoint scripts §4.5 (list/detail/patch/activate/delete/jobs/run). Validasi params di `run`: core hanya menyimpan `paramsSchema` sebagai JSON Schema (Zod aslinya ada di dalam bundle), jadi validasi server memakai validator JSON Schema (`ajv`) di core, dan runner tetap menjalankan `params.parse()` Zod di dalam bundle sebagai lapis kedua (lihat Open questions #7).
- [ ] `app/scripts/page.tsx`: tabel (nama, versi aktif, enabled toggle, createdBy, updated, jumlah job, aksi run/delete). Delete → confirm; tolakan core (job aktif) tampil sebagai error toast.
- [ ] `app/scripts/[id]/page.tsx`, section: **Metadata** (nama — editable; enabled toggle), **Source** (bundle versi terpilih, read-only, `<pre>` + copy, collapsed default karena bundle bisa besar), **Versions** (list `script_versions`, badge aktif, tombol "Activate" versi lain + confirm), **Run** (`ScriptRunForm`: `SchemaForm` dari paramsSchema versi aktif + dropdown device — hanya device `idle`, device quarantined tampil disabled dengan alasan → submit `POST /run` → redirect `/jobs/[jobId]`), **Riwayat job** (tabel status/device/durasi/link, pagination `limit/offset`).
- [ ] `PublishHint.tsx` di halaman list & detail: blok instruksi `bunx @enkaku/sdk publish ./my-script.ts --farm http://<host>` (perintah persis sesuai CLI Plan 05) + link README SDK.
- [ ] **Verifikasi:** publish script contoh via CLI → muncul di list; publish versi 2 → Versions menampilkan 2 entri; activate v1 lagi → run form pakai paramsSchema v1; run dengan param invalid (client) tertahan di form; bypass via curl dengan param invalid → 400 dari core.

### Tahap 5.9 — Studio: Job detail

- [ ] `app/jobs/[id]/page.tsx`: header (script@versi, device, status live via WS `job.status`, created/started/finished, durasi), tombol **Cancel** (tampil saat queued/running, confirm, `POST /cancel`).
- [ ] `JobLogView.tsx`: backfill `GET /api/jobs/:id/log` lalu append WS `job.log` (filter jobId); autoscroll dengan pause-on-scroll-up; render monospace, cap DOM (virtualized/truncate > 5k baris dengan tombol "load semua").
- [ ] `ArtifactGallery.tsx`: dari `GET /api/jobs/:id/artifacts` + append WS `job.artifact`; kind `screenshot` → thumbnail grid + lightbox preview; lainnya → row file + ukuran; semua ada tombol download (`/api/artifacts/:id/download`).
- [ ] Section hasil: `result` JSON pretty-print saat success; `error` (message + stack kalau ada) dalam blok merah saat failed.
- [ ] **Verifikasi:** jalankan script contoh yang nge-log tiap detik + 2 screenshot → log mengalir realtime, screenshot muncul tanpa refresh, download OK; cancel job berjalan → status cancelled, log berhenti.

### Tahap 5.10 — Studio: Tools UI

- [ ] Pastikan core meng-emit `tool.progress` selama install (kalau Plan 02 belum: tambah callback progress di downloader `packages/toolchain` → broadcast; perubahan kecil, bukan redesign).
- [ ] `app/tools/page.tsx` + `ToolCard.tsx` per tool dari `GET /api/tools`: versi terpasang (badge **aktif**), versi tersedia dari manifest, aksi per versi: Install/Update (progress bar dari WS `tool.progress`), Activate (confirm; disabled kalau health belum dicek → jalankan check dulu otomatis), Delete (disabled utk versi aktif — tooltip alasan, sesuai §7.8).
- [ ] Tombol global: **Refresh manifest** (`POST /api/tools/manifest/refresh`), **Health check** per tool (`POST /api/tools/:id/check`, hasil hijau/merah + output).
- [ ] Tool `swappable:false` (scrcpy-server, ui-server bila demikian): card mode read-only — versi + health + label **"managed by core"**, tanpa tombol install/activate/delete (spec §7.6); jangan render aksi lalu disable satu-satu — beda template, digerakkan flag `swappable` dari API.
- [ ] **Verifikasi:** install adb versi lama → progress bar jalan → muncul sebagai terpasang non-aktif; activate → pointer pindah (cek `GET /api/tools`); delete versi aktif ditolak; scrcpy-server tidak menampilkan aksi apa pun.

### Tahap 5.11 — Core + Studio: Settings page + backup/restore

- [ ] `app/settings/page.tsx`, section: **Farm defaults** (`SchemaForm` dari `GET /api/settings` — mencakup defaults driver/timing/input mode + battery config), **Retention** (bagian `retention` dari schema yang sama, banner "Enforcement aktif di M7 (Plan 09)"), **Users & ACL** (stub: teks "Tersedia di M7"), **Backup & Restore**.
- [ ] Core: `system/backup-restore.ts` + routes §4.8 (`pauseWrites`/`resumeWrites` diimplement sebagai flag di middleware Hono + hook scheduler; `VACUUM INTO`; restore drain + swap + migrate).
- [ ] UI Backup: tombol "Download backup" (disable saat ada job running? tidak perlu — pause writes menahan sebentar saja; tampilkan spinner "menunggu writer..."). UI Restore: file input + checkbox konfirmasi "Saya paham DB saat ini akan diganti" → upload → tampilkan hasil validasi/error (`RESTORE_INCOMPATIBLE` dll.) → sukses: instruksi restart.
- [ ] **Verifikasi:** ubah `tempThresholdC` → poller pakai nilai baru tanpa restart (uji dengan mock temp); download backup saat 1 job jalan → file valid (`sqlite3 file 'PRAGMA integrity_check'` → ok) dan job tidak gagal; restore file backup → data (device label, scripts) kembali; restore file rusak → ditolak dengan pesan jelas, DB lama utuh.

### Tahap 5.12 — Integrasi, polish, dokumentasi

- [ ] Navigasi global Studio (sidebar): Dashboard / Scripts / Tools / Settings + indikator koneksi WS.
- [ ] Konsistensi error: semua fetch Studio melewati helper yang memahami `{ error: { code, message } }` → toast/inline seragam.
- [ ] Jalankan checklist e2e manual lengkap (§7.2), perbaiki temuan.
- [ ] README `packages/studio` (arsitektur schema-form, cara menambah engine tanpa menyentuh UI) + update README core (endpoint baru, battery poller, backup).
- [ ] Commit `feat(m5): ...` per tahap; commit penutup setelah acceptance lulus.
- [ ] **Verifikasi:** Definition of Done global (overview §7) — `bun test` hijau seluruh workspace, tidak ada `any`/TODO baru tanpa alasan.

## 6. Acceptance criteria

Semua wajib lulus:

1. `GET /api/registry` valid terhadap `RegistryResponse` dan memuat semua entri tabel §4.3, termasuk entri `available:false` dengan `unavailableReason`.
2. Dropdown driver di device detail men-disable: engine unavailable, dan kombinasi lock-conflict; `PATCH /api/devices/:id/drivers` menolak kombinasi yang sama via curl (server-authoritative terbukti).
3. `SchemaForm` me-render & round-trip nilai dengan benar untuk 8 tipe field (§4.1) — dibuktikan unit test hijau + halaman dev.
4. Config engine, DeviceSettings, params script, dan FarmSettings SEMUANYA dirender `SchemaForm` — grep tidak menemukan form hardcode untuk config komponen pluggable.
5. Validasi server tetap jalan saat client di-bypass: PUT settings / run script dengan payload invalid via curl → 400 ber-`issues[].path`, dan error path tampil di field yang benar saat lewat UI.
6. Scripts: publish via SDK CLI muncul di list; edit metadata, enable/disable, delete (ditolak saat ada job aktif), activate versi lama mengubah paramsSchema di run form; riwayat job per script tampil.
7. Job detail: log realtime mengalir via WS, artifacts muncul live + preview screenshot + download, cancel bekerja, hasil/error tampil sesuai status.
8. Tools UI: install/activate/delete/health/refresh-manifest semua dari UI dengan progress bar; delete versi aktif ditolak; scrcpy-server tampil "managed by core" tanpa aksi.
9. Battery: `devices.battery` terisi untuk device online, badge dashboard update realtime; interval & threshold configurable dari Settings dan efektif tanpa restart.
10. Auto-quarantine: suhu mock > threshold → status `quarantined` (persist lintas reconnect & restart core), keluar dari scheduler (job baru tidak di-claim, enqueue manual ditolak), event WS + tampilan; device busy tidak dipaksa mati — quarantine efektif setelah job selesai; un-quarantine manual dari UI mengembalikan device.
11. Backup menghasilkan file SQLite konsisten tanpa menggagalkan job berjalan; restore tervalidasi mengembalikan data dan menolak file rusak/incompatible tanpa merusak DB lama.
12. Semua layar spec §19 yang menjadi scope M5 selesai sesuai isinya (Dashboard, Device detail, Scripts, Job detail, Tools, Settings; Enrollment tetap dari Plan 03).
13. `bun test` hijau di seluruh workspace.

## 7. Test plan

### 7.1 Unit test (bun test)

**Renderer (`packages/studio/src/components/schema-form/*.test.tsx`, happy-dom + testing-library):**

- `StringField`: render label/description, ketik → onChange, `minLength` dilanggar → pesan error on-blur, `pattern` dilanggar → error.
- `NumberField`: `integer` menolak desimal; `minimum/maximum` enforced; string kosong → undefined (bukan NaN).
- `BooleanField`: toggle round-trip; default `true` ter-prefill.
- `EnumField`: opsi lengkap; nilai di luar enum (dari server lama) tetap tampil + ditandai invalid.
- `RangeTupleField`: dua input; `min > max` → error client; nilai default `[40,120]` ter-prefill; hasil onChange selalu tuple 2 angka.
- `ObjectField`: nested 3 level (schema DeviceSettings) render fieldset benar; perubahan field dalam → path nilai benar (`timing.tapJitterMs`).
- `ArrayField`: add/remove item; array kosong valid kalau tidak required.
- `UnsupportedField`: schema `anyOf` aneh → textarea JSON + warning, JSON invalid → error, tidak crash.
- `SchemaForm` integrasi: `applyDefaults` menghasilkan objek default penuh dari schema `FarmSettings`; `serverErrors` path `['battery','tempThresholdC']` tampil di field yang benar; snapshot DOM stabil.

**Protocol & core:**

- `validateEngineSelection`: valid; unknown id; unavailable; lock conflict (dua engine `input-injection`); `requires` tak terpenuhi.
- `toFormSchema(DeviceSettings)`: snapshot JSON Schema — tuple jadi `prefixItems`, default & description ikut.
- `parse-dumpsys`: fixture ≥ 2 vendor + fixture rusak → `status:'unknown'` tanpa throw; `temperature: 312` → 31.2.
- `quarantine.ts`: idle→quarantined; busy→pendingQuarantine→(release)→quarantined; reconnect device quarantined tetap quarantined; unquarantine → idle/offline.
- Broadcast throttle battery: perubahan 0.3 °C tanpa perubahan lain → tidak broadcast.
- Backup: `pauseWrites` menahan write (uji dengan write yang di-queue selama pause lalu sukses setelah resume); file hasil `VACUUM INTO` lolos integrity_check.
- Route settings: PUT invalid → 400 issues ber-path; PUT valid → subscriber (poller stub) menerima nilai baru.

### 7.2 Smoke test manual (checklist e2e per layar; butuh ≥ 1 device fisik, `ENKAKU_TEST_DEVICE=1`)

Persiapan: core jalan, 1–2 device authorized, 1 script contoh dipublish via SDK CLI.

- **Dashboard:** semua device tampil dengan status benar; cabut USB → offline realtime; toggle thumbnail ON → gambar muncul ≤ 10 s; badge baterai sesuai `dumpsys battery`; quick action Control & Run menavigasi benar.
- **Quarantine flow:** `adb shell dumpsys battery set temp 480` → badge merah + status quarantined ≤ interval poll; coba run script ke device itu → ditolak dengan pesan; restart core → masih quarantined; `dumpsys battery reset` + Un-quarantine dari card → idle.
- **Device detail:** dropdown driver menampilkan scrcpy/uhid/aoa/appium disabled + tooltip alasan; ganti inspector `ui-server` ↔ `uiautomator-dump` sukses; edit DeviceSettings.timing via form → tersimpan; tombol Prep → animation scale 0 & stay awake aktif (cek via adb); jalankan job → badge "automation running", panel disabled, video tetap tampil.
- **Scripts:** list menampilkan script; disable → run tersembunyi/ditolak; publish v2 dari CLI → versi bertambah; activate v1 → form run berubah; run dengan param kosong pada field required → tertahan client; run valid → redirect job detail.
- **Job detail:** log streaming, screenshot muncul live, download artifact OK, cancel job → cancelled + device kembali idle.
- **Tools:** refresh manifest OK; install versi adb kedua dengan progress bar; activate + health check hijau; delete versi non-aktif OK, versi aktif ditolak; scrcpy-server read-only "managed by core".
- **Settings:** ubah default input mode & threshold → tersimpan & efektif; retention form tampil dengan banner placeholder; download backup saat job jalan → job selesai normal, file valid; restore backup tadi → data kembali; upload file txt sebagai restore → ditolak rapi.
- **Renderer dev page:** semua tipe field tampil dan berfungsi di `/dev/schema-form`.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Output `z.toJSONSchema` berubah antar minor Zod → renderer salah deteksi node | Form rusak diam-diam | Snapshot test JSON Schema untuk DeviceSettings/FarmSettings; pin versi Zod di root; `UnsupportedField` sebagai fallback yang terlihat, bukan crash |
| Format `dumpsys battery` beda antar vendor/Android | Battery kosong / parse salah | Parser toleran per-baris + fixture multi-vendor; nilai tak dikenal → `unknown`, jangan gagalkan poll; log warn sekali per device |
| Auto-quarantine false positive (sensor suhu aneh, mock lupa di-reset) | Device keluar pool tanpa sebab | Threshold configurable + reason tersimpan & tampil; un-quarantine satu klik; quarantine hanya via suhu > threshold, bukan health flag |
| Poll battery menambah beban adb di farm 10 device | Input manual terasa lag | Poll lewat per-device queue prioritas rendah + global semaphore Plan 01; interval default 60 s; broadcast di-throttle |
| `pauseWrites` menahan request saat backup lama (DB besar) | UI terasa hang | `VACUUM INTO` cepat untuk DB metadata (artifact di FS, bukan DB); timeout drain 10 s → batalkan backup dengan error jelas, bukan menggantung |
| Restore di tengah job berjalan merusak state | Job zombie / lease yatim | Drain wajib sebelum swap (§4.8); UI menampilkan job yang menahan restore; sarankan restart core setelah restore |
| Bundle script besar bikin halaman detail berat | UX lambat | Source collapsed by default, load on demand (`GET` terpisah bila perlu), cap render + tombol download raw |
| `tool.progress` ternyata belum ada dari Plan 02 | Progress bar bohong | Tahap 5.10 mewajibkan verifikasi emit event; kalau belum ada, tambahkan di toolchain (perubahan kecil ter-scope) |
| Log job sangat panjang membanjiri DOM | Tab browser macet | Virtualisasi/truncate di `JobLogView` + backfill ber-offset |

## 9. Open questions

Butuh keputusan manusia — jangan diputuskan sepihak saat implementasi:

1. **Hysteresis / auto-unquarantine:** spec §15.2 hanya menyebut auto-quarantine + (per arahan M5) un-quarantine manual. Apakah nanti mau auto-recover saat suhu turun ≥ X °C di bawah threshold selama Y menit? (Sekarang: manual only.)
2. **Kill job saat overheat:** device `busy` yang melewati threshold saat ini dibiarkan menyelesaikan job (pendingQuarantine). Apakah perlu mode agresif "cancel job segera di atas threshold kedua" (mis. > 50 °C)?
3. **Backup artifact files:** backup saat ini DB-only; folder `artifacts/` bisa puluhan GB. Perlukah opsi "backup + artifacts (tar)" atau cukup didokumentasikan agar user rsync folder data? (Berkaitan retention Plan 09.)
4. **Jobs list global:** spec §19 tidak punya layar daftar semua job/antrian farm. Riwayat per script + job detail sudah cukup? Kalau operator butuh "apa yang sedang jalan di farm", tambah layar di plan mana?
5. **Hapus versi script lama:** `script_versions` tumbuh terus (bundle bisa besar). Ikut retention Plan 09, atau ada aksi "delete versi non-aktif" di Scripts UI?
6. **Default `devices.input`:** spec §12 mendefault `scrcpy-uhid` padahal engine baru ada di Plan 08. Selama M5, kolom dibiarkan berisi nilai dari plan sebelumnya (`adb-input`) dan FarmSettings.defaults.input = `adb-input`; kapan tepatnya default di-flip ke `scrcpy-uhid` (migration di Plan 08?) — konfirmasi di Plan 08.
7. **Validator JSON Schema di core untuk params script:** tahap 5.8 memakai `ajv` untuk validasi server params (karena core hanya punya JSON Schema hasil publish, bukan Zod aslinya). Setuju menambah dependency `ajv`, atau lebih suka SDK CLI ikut mengirim modul validasi ter-bundle yang dieksekusi runner saja (server-side check jadi lebih lemah)?
8. **`ui-server` swappable?** Spec §7.2 menandai `ui-server.apk` "versi ikut core" — apakah diperlakukan `swappable:false` penuh seperti scrcpy-server di Tools UI (read-only), atau boleh pilih versi? (Asumsi plan ini: `swappable:false`, tampil "managed by core".)
