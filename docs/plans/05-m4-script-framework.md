# Plan 05 — M4 : Script Framework

> **Status:** draft, siap dieksekusi setelah Plan 04 selesai.
> **Depends on:** Plan 01 (monorepo, core, adb client, per-device queue + semaphore), Plan 02 (Toolchain Manager, adb terprovisi), Plan 03 (`screencap-loop` + `adb-input` InputSink, coordinate mapping), Plan 04 (state machine device, lease + heartbeat, queue per-device dengan dummy job).
> **Referensi spec:** §11 (seluruhnya — script framework), §20 baris M4, §12 (tabel `scripts` & `artifacts`), §7 (interface `Inspector`), §7.4 (keterbatasan `uiautomator dump`), §10 (queue/lease yang di-integrasikan), §11.3 (trust model), §13 (message `job.*`).

Setelah plan ini, queue/lease dari Plan 04 tidak lagi menjalankan dummy `sleep` job, melainkan **script sungguhan**: script ditulis dengan `@enkaku/sdk` di editor author, di-publish sebagai bundle ke farm, di-enqueue dengan parameter, dieksekusi di child process terisolasi dengan tiga fase `prepare/run/finish`, menghasilkan log streaming + artifact per job.

---

## 1. Goals

Setelah plan ini selesai, semua pernyataan berikut TRUE dan terverifikasi:

- [ ] `@enkaku/sdk` (packages/sdk) meng-export `defineScript` dengan tiga fase `prepare`/`run`/`finish` yang **persis** mengcompile contoh script di spec §11.1 tanpa modifikasi (kecuali import).
- [ ] `params` script adalah Zod schema; hasil konversi ke JSON Schema tersimpan di kolom `scripts.paramsSchema` saat publish.
- [ ] SDK CLI `enkaku publish <entry>` mem-bundle script + dependency-nya (bun build) jadi **satu file**, meng-extract metadata (id, version, paramsSchema), dan POST ke core (`/api/scripts`).
- [ ] Core punya CRUD minimal `/api/scripts` (list, get, create/publish, enable/disable, delete) — UI penuh menyusul di Plan 07.
- [ ] Job dengan `scriptId` menggantikan dummy job: scheduler Plan 04 men-spawn **runner child process** (`Bun.spawn`) per job; crash/hang script tidak pernah menjatuhkan core.
- [ ] Child process **tidak pernah** membuka koneksi adb sendiri; semua aksi device berjalan lewat IPC ke core, sehingga per-device queue + semaphore (Plan 01) dan lease (Plan 04) tetap dihormati.
- [ ] `finish` selalu dieksekusi — termasuk saat `run` throw, saat abort/cancel, dan saat hard-timeout (via finish-only attempt, lihat §4.7) — dengan `ctx.error` terisi bila ada kegagalan.
- [ ] `waitFor(selector, opts)` bekerja dengan polling Inspector; selector berlapis `{id} → {desc} → {text} → {point}` sesuai spec §11.2.
- [ ] Inspector engine `uiautomator-dump` mengimplementasikan interface `Inspector` spec §7 (`dump`, `find`, `screenshot`) dan bisa di-swap ke `ui-server` (Plan 06) **tanpa mengubah API script**.
- [ ] `ctx.artifact.screenshot(label)` menyimpan PNG ke `<app-data>/artifacts/<job-id>/...`, insert row `artifacts` (kind, label, path, `sizeBytes`), dan broadcast `job.artifact` via WS.
- [ ] Log per job tertulis ke file (`<app-data>/artifacts/<job-id>/job.log`) **dan** streaming realtime via WS message `job.log`.
- [ ] `timeout` dan `retries` level script dihormati: timeout → abort bertingkat (graceful → SIGKILL), retries → attempt baru (child process baru) sampai batas.
- [ ] Lease heartbeat diperpanjang selama runner hidup; runner yang hang terdeteksi (heartbeat IPC hilang) dan di-abort — device kembali `idle` tanpa restart core.
- [ ] Script contoh e2e (buka Settings app) sukses end-to-end di device fisik: enqueue → running → success, artifact screenshot ada di disk + DB.

## 2. Non-goals

Sengaja TIDAK dikerjakan di plan ini:

- **`ui-server` persistent inspector** — Plan 06 (M4.5). Di sini hanya `uiautomator-dump` sebagai jembatan, plus desain interface yang membuat swap mulus.
- **Studio UI untuk scripts/jobs** (editor, run form dari paramsSchema, job detail page) — Plan 07 (M5). M4 hanya API + smoke test via curl/CLI.
- **Sandbox keamanan** untuk script — bukan non-goal sementara, tapi **bukan janji produk sama sekali** di mode lokal (spec §11.3). Security boundary per job (container/microVM) = Plan 11 (M8).
- **`set_text` langsung ke elemen** (lebih reliable untuk WebView) — butuh ui-server, Plan 06. M4 `type()` memakai `input text` (keterbatasan didokumentasikan, §4.4).
- **Video recording per job** sebagai artifact — spec §22 (future). Kind `video` di tabel `artifacts` dibiarkan ada tapi belum diproduksi.
- **Auth/ACL penuh** untuk publish — Plan 09 (M7). M4: token statis opsional (lihat §4.9), tanpa token bila core bind localhost (sesuai spec §14).
- **Retention/GC artifact** — Plan 09. M4 hanya memastikan `sizeBytes` terisi supaya GC nanti bisa jalan.
- **Parallel run lintas device / capability routing** — spec §22 (future). Job M4 selalu menarget satu `deviceId` eksplisit.

## 3. Konteks & keputusan desain

### 3.1 Kenapa M4 setelah M3

Plan 04 sudah membuktikan queue/lease/heartbeat benar dengan dummy job (spec §20: "queue/lease benar pakai job palsu > debug queue sambil debug automation"). M4 mengganti *payload*-nya saja: fungsi `executeDummyJob` diganti `JobRunner.execute` yang men-spawn child process. Kontrak scheduler (claim transaksi `BEGIN IMMEDIATE`, lease expiry, device `busy`) **tidak berubah**.

### 3.2 Keputusan desain utama (dan alasannya)

| Keputusan | Alasan |
|---|---|
| **Tiap job = child process `Bun.spawn`** | Spec §11.2. Crash containment: script user tidak bisa nge-crash/hang core. Hard-timeout = kill process, bukan berharap script kooperatif. |
| **Child TIDAK membuka adb** — semua aksi device via IPC ke core | Kalau child buka adb sendiri: per-device queue & semaphore (Plan 01) dan lease (Plan 04) bisa dilewati, dan child butuh path binary adb (melanggar aturan "resolve via Toolchain Manager"). Core tetap satu-satunya penjaga pintu device. |
| **IPC = Bun native IPC (`ipc` option `Bun.spawn`) dengan payload JSON tervalidasi Zod** | Child adalah proses Bun → IPC bawaan tersedia, message-framed (tidak perlu framing manual), dan **memisahkan channel protokol dari stdout/stderr**: `console.log` liar dari script user tidak bisa merusak protokol. stdout/stderr child tetap di-pipe dan masuk job log. Skema message tetap didefinisikan sebagai JSON + Zod (§4.6) sehingga kalau suatu saat transport diganti (mis. fd3 JSON-lines), hanya lapisan framing yang berubah. |
| **`finish` selalu jalan; pada hard-kill → finish-only attempt di process baru** | Spec §11.2 "finish selalu jalan → device balik clean → queue aman lanjut". Process yang sudah SIGKILL tidak bisa menjalankan apa pun, jadi satu-satunya cara menepati janji ini adalah menjalankan `finish` di process segar. Trade-off dibahas jujur di §4.7. |
| **Inspector M4 = `uiautomator-dump`, di belakang interface `Inspector` spec §7** | Spec §7.4: MVP boleh pakai `uiautomator dump` supaya cepat jadi. Script hanya melihat `ctx.device.find/waitFor` — engine di baliknya urusan `DeviceSession`. Plan 06 tinggal menukar engine, zero perubahan script. |
| **Bundle publish = satu file hasil `bun build`, farm hanya terima bundle jadi** | Spec §11.4. Dependency deterministik, runner sederhana (import satu file), tidak ada `npm install` di farm. |
| **`@enkaku/sdk` type-only + `defineScript` tipis; runtime eksekusi ada di core** | SDK dipublish ke npm (spec §4) — makin tipis makin stabil. `defineScript` hanya memvalidasi bentuk & mengembalikan objek definisi; `ScriptContext` konkret dirakit oleh child-entry milik core. Versi SDK author dan versi core tidak perlu lockstep. |
| **Trust model: crash containment, BUKAN sandbox** | Spec §11.3 (koreksi jujur v0.2). Bundle berjalan dengan akses fs/network penuh sebagai OS user core. Yang dijanjikan hanya: crash/hang script tidak menjatuhkan core, dan timeout selalu membebaskan device. Script author = operator tepercaya di mode local/self-host. Kalimat ini masuk README `packages/sdk`. |

### 3.3 Keterbatasan `uiautomator dump` — ditulis jujur

Sesuai spec §7.4, engine M4 ini **lambat dan rapuh**, dan itu diterima sebagai jembatan:

- Satu dump memakan **0,5–2 detik** → `waitFor` 15 detik efektif hanya ~8–10 kali cek.
- Dump **gagal saat UI terus berubah** ("could not get idle state") dan bisa hang di app tertentu → `dump()` kita bungkus retry + timeout internal (§4.4).
- Tidak ada `set_text`/`long_click` per elemen; `type()` memakai `input text` yang tidak reliable untuk non-ASCII.
- Semua ini adalah alasan Plan 06 (`ui-server`, target < 200 ms per find, spec §16) berprioritas tinggi. **Kontrak Plan 05 → 06:** interface `Inspector` + tipe `UiNode`/`Selector` di `@enkaku/protocol` tidak boleh berubah saat engine ditukar.

## 4. Desain teknis

### 4.1 Struktur file (dibuat/diubah di plan ini)

```
packages/
  protocol/src/
    ui-node.ts                  # BARU: UiNode, Selector, Point, KeyCode (shared)
    messages/job.ts             # UBAH: tambah job.log, job.artifact, extend job.status
  sdk/                          # BARU: @enkaku/sdk (publishable)
    package.json                #   bin: { "enkaku": "./dist/cli.js" }
    src/index.ts                #   export defineScript + semua tipe publik
    src/define-script.ts
    src/types.ts                #   ScriptContext, DeviceApi, ArtifactApi, ScriptLogger
    src/cli/index.ts            #   entry CLI (subcommand: publish)
    src/cli/publish.ts
  drivers/src/inspector/
    uiautomator-dump.ts         # BARU: engine Inspector M4
    xml-parser.ts               # BARU: XML dump → UiNode tree
    selector.ts                 # BARU: matcher selector berlapis + centerOf(bounds)
  core/src/
    runner/
      ipc.ts                    # BARU: Zod schema message parent⇄child
      child-entry.ts            # BARU: entry point child process
      device-proxy.ts           # BARU: DeviceApi di sisi child (semua call → IPC)
      job-runner.ts             # BARU: sisi parent — spawn, timeout, retries, finalisasi
      device-executor.ts        # BARU: sisi parent — eksekusi device.call ke engine
      artifact-store.ts         # BARU: tulis file artifact + insert DB + broadcast
      job-logger.ts             # BARU: job.log file + WS fan-out
    scripts/
      routes.ts                 # BARU: REST /api/scripts
      bundle-cache.ts           # BARU: materialisasi bundle DB → file utk import
    jobs/
      scheduler.ts              # UBAH (dari Plan 04): dummy executor → JobRunner
      routes.ts                 # UBAH: enqueue menerima scriptId+params, endpoint cancel
examples/
  open-settings.ts              # BARU: script e2e contoh (dipakai test plan)
```

### 4.2 Tipe publik SDK (`@enkaku/sdk`)

Kontrak ini yang dilihat script author. Contoh script spec §11.1 harus compile apa adanya terhadap tipe ini.

```ts
// packages/sdk/src/types.ts
import type { z } from 'zod'
import type { Selector, Point, UiNode, KeyCode } from '@enkaku/protocol'

export interface WaitForOptions {
  timeout?: number      // default 10_000 ms
  intervalMs?: number   // default 1_000 ms (realistis utk uiautomator-dump; ui-server nanti bisa turunkan)
}

export interface DeviceApi {
  // aksi input — via InputSink (M4: adb-input dari Plan 03)
  tap(target: Selector): Promise<void>            // selector → find → tap titik tengah; { point } → tap langsung
  swipe(from: Point, to: Point, ms?: number): Promise<void>
  type(text: string): Promise<void>               // M4: `input text` (ASCII-safe); set_text per-elemen = Plan 06
  key(code: KeyCode): Promise<void>
  // inspeksi — via Inspector (M4: uiautomator-dump)
  find(sel: Selector): Promise<UiNode | null>
  waitFor(sel: Selector, opts?: WaitForOptions): Promise<UiNode>   // reject ScriptError('WAITFOR_TIMEOUT') bila habis waktu
  screenshot(): Promise<Uint8Array>               // PNG mentah (tanpa menyimpan artifact)
  // app lifecycle — via shell exec di core
  app: {
    launch(pkg: string, opts?: { activity?: string }): Promise<void>  // activity → `am start -n`; tanpa → `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`
    forceStop(pkg: string): Promise<void>                             // `am force-stop <pkg>`
  }
}

export interface ArtifactApi {
  screenshot(label: string): Promise<void>        // ambil screenshot DI CORE, simpan sbg artifact job
  file(label: string, data: Uint8Array | string, opts?: { ext?: string }): Promise<void>  // max 8 MB (M4, lihat Open questions)
}

export interface ScriptLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export interface ScriptError { code: string; message: string; phase: 'prepare' | 'run' | 'finish' | 'timeout' }

export interface ScriptContext<P = unknown> {
  device: DeviceApi
  params: P                                       // sudah lolos params.parse()
  artifact: ArtifactApi
  log: ScriptLogger
  job: { id: string; attempt: number; deviceId: string }
  error?: ScriptError                             // HANYA terisi saat finish dipanggil setelah kegagalan
}

export interface ScriptDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string
  version: string                                 // semver string
  params: S
  timeout?: number                                // ms per attempt; default 300_000
  retries?: number                                // attempt tambahan setelah gagal; default 0
  prepare?(ctx: ScriptContext<z.infer<S>>): Promise<void>
  run(ctx: ScriptContext<z.infer<S>>): Promise<unknown>   // return value → jobs.result
  finish?(ctx: ScriptContext<z.infer<S>>): Promise<void>
}
```

```ts
// packages/sdk/src/define-script.ts
export function defineScript<S extends z.ZodTypeAny>(def: ScriptDefinition<S>): ScriptDefinition<S> {
  // validasi bentuk minimal (id non-empty, version semver, run adalah function) → throw saat build/publish, bukan saat run di farm
  return Object.freeze(def)
}
```

Catatan: `defineScript` sengaja **tanpa** side effect — hanya validasi + freeze. Semua orkestrasi (fase, timeout, retries) milik runner core, sehingga script yang di-publish dengan SDK versi lama tetap jalan di core baru selama bentuk `ScriptDefinition` kompatibel.

### 4.3 Selector berlapis & `UiNode` (di `@enkaku/protocol`)

Sesuai spec §11.2: urutan preferensi stabil → rapuh: `{ id }` → `{ desc }` → `{ text }` → `{ point }`. Satu selector = **tepat satu** kunci (Zod union, bukan gabungan bebas — gabungan multi-kriteria masuk Open questions).

```ts
// packages/protocol/src/ui-node.ts
export const Point = z.object({ x: z.number(), y: z.number() })
export const Selector = z.union([
  z.object({ id: z.string() }).strict(),      // resource-id: match penuh ATAU suffix setelah ":id/"
  z.object({ desc: z.string() }).strict(),    // content-desc: match exact
  z.object({ text: z.string() }).strict(),    // text: match exact
  z.object({ point: Point }).strict(),        // koordinat mentah — bypass inspector
])
export interface UiNode {
  resourceId: string; text: string; desc: string
  className: string; packageName: string
  bounds: { left: number; top: number; right: number; bottom: number }
  clickable: boolean; enabled: boolean; focused: boolean
  index: number
  children: UiNode[]
}
```

Aturan matching (di `drivers/src/inspector/selector.ts`, pure function → unit-testable):

- `{ id: 'caption_input' }` cocok bila `node.resourceId === 'caption_input'` **atau** `node.resourceId.endsWith(':id/caption_input')` (format Android `com.app:id/caption_input`).
- `{ desc }` / `{ text }`: exact match (trim). Substring/regex match TIDAK di M4 (Open questions).
- Traversal depth-first, kembalikan match pertama; `centerOf(bounds)` menghasilkan titik tap.
- `{ point }` tidak menyentuh Inspector sama sekali — `find({point})` mengembalikan node sintetis ber-bounds 1×1, `tap({point})` langsung ke InputSink.

### 4.4 Inspector engine `uiautomator-dump` (packages/drivers)

Mengimplementasikan interface `Inspector` spec §7 apa adanya:

```ts
// drivers/src/inspector/uiautomator-dump.ts
export class UiautomatorDumpInspector implements Inspector {
  readonly id = 'uiautomator-dump'
  constructor(private exec: DeviceExec) {}       // exec = per-device command queue Plan 01 (BUKAN adb langsung)
  async dump(): Promise<UiNode>
  async find(sel: Selector): Promise<UiNode | null>   // dump() lalu matchSelector()
  async screenshot(): Promise<Uint8Array>             // `exec-out screencap -p`
}
```

Detail implementasi `dump()`:

1. Jalur utama: `adb -s <serial> exec-out uiautomator dump /dev/tty` → XML langsung di stdout (tanpa file di device). Output diawali noise (`UI hierchary dumped to: /dev/tty`) → strip sampai `<?xml`.
2. Fallback (device yang menolak `/dev/tty`): `shell uiautomator dump /sdcard/enkaku-dump.xml` → `exec-out cat /sdcard/enkaku-dump.xml` → `shell rm -f /sdcard/enkaku-dump.xml`. Pilihan jalur di-probe sekali per device dan di-cache di memori session.
3. Retry internal: bila output mengandung `ERROR: could not get idle state` atau XML tidak parseable → retry max 2× dengan backoff 500 ms. Tetap gagal → throw `EnkakuError('INSPECTOR_DUMP_FAILED')` (dipetakan ke `ScriptError` di child).
4. Timeout internal per dump: 10 detik (uiautomator bisa hang) — lewat itu, command di-kill lewat mekanisme exec Plan 01.

Parser XML (`xml-parser.ts`): pakai `fast-xml-parser` (pure-JS, tanpa native dep) dengan `preserveOrder` + attributes. Atribut yang dipetakan: `resource-id`, `text`, `content-desc`, `class`, `package`, `clickable`, `enabled`, `focused`, `index`, dan `bounds` berformat `[l,t][r,b]` → di-parse regex `\[(\d+),(\d+)\]\[(\d+),(\d+)\]`. Node `<hierarchy>` menjadi root sintetis.

`screenshot()` juga dipakai `ctx.artifact.screenshot` dan `ctx.device.screenshot` — satu implementasi, dua konsumen.

**Kontrak swap (untuk Plan 06):** `DeviceSession` (Plan 03/04) memilih engine inspector dari `devices.inspection`. M4 mendaftarkan `uiautomator-dump` ke registry dan menjadikannya nilai efektif ketika `ui-server` (default kolom di spec §12) belum tersedia. Plan 06 hanya menambah engine + mengubah resolusi default — `device-executor.ts`, IPC, dan SDK tidak disentuh.

### 4.5 Runner: child process per job

```
   parent (core)                                child (bun child-entry.ts <bundlePath>)
   ─────────────                                ─────────────────────────────────────
   scheduler claim job (Plan 04)
   device → busy, lease aktif
   materialisasi bundle → file
   Bun.spawn([execPath, childEntry, bundlePath],
             { ipc, stdout:'pipe', stderr:'pipe' })
        │                                        import(bundlePath) → default export (ScriptDefinition)
        │◄──────────── ready ────────────────────┤
        ├──────────── init ─────────────────────►│  params = def.params.parse(init.params)  // gagal → result error PARAMS_INVALID
        │◄──────────── phase:prepare ────────────┤  await def.prepare?.(ctx)
        │◄──────────── device.call ──────────────┤       ctx.device.* → IPC request/response
        ├──────────── device.result ────────────►│
        │◄──────────── phase:run ────────────────┤  value = await def.run(ctx)
        │◄──────────── log / artifact.save ──────┤       (heartbeat tiap 10 s, paralel)
        │◄──────────── phase:finish ─────────────┤  await def.finish?.(ctx)   // ctx.error terisi bila prepare/run gagal
        │◄──────────── result ───────────────────┤
        │                                        └─ process.exit(0)
   finalisasi: register job.log sbg artifact,
   jobs.status=success/failed, result/error,
   lease release, device → idle, WS job.status
```

- Child dijalankan dengan `process.execPath` (binary bun yang sama dengan core) + `runner/child-entry.ts` (saat single-binary Plan 09, entry ini ikut ter-compile; M4 cukup path source/dist).
- Bundle dimaterialisasi dari kolom `scripts.bundle` ke `<app-data>/cache/bundles/<scriptId>-<version>.mjs` (content-addressed by row id + version; ditulis sekali, dipakai berulang). Cache di-invalidate saat script row berubah.
- Env child: minimal (`PATH` tidak dibutuhkan child — tidak ada exec tool di child), plus `ENKAKU_JOB_ID` untuk diagnosa. Konteks job dikirim via message `init`, bukan env.
- stdout/stderr child di-pipe → tiap line masuk job log dengan `source: 'stdout' | 'stderr'` (script boleh `console.log`, tapi `ctx.log` yang direkomendasikan karena berlevel + terstruktur).
- **Heartbeat dua lapis:** child kirim `heartbeat` IPC tiap 10 s; parent meneruskannya sebagai perpanjang lease (mekanisme Plan 04, interval ~15 s → 10 s aman). Parent juga memperpanjang lease saat ada `device.call` (aktivitas = bukti hidup). Bila tidak ada message apa pun dari child selama **3 × 10 s**, parent menganggap child hang → jalur abort (§4.7) tanpa menunggu timeout script.

### 4.6 Protokol IPC parent ⇄ child (Zod, `core/src/runner/ipc.ts`)

Semua message JSON, divalidasi `.safeParse()` di kedua sisi; message tak dikenal → log warn + abaikan (forward-compat).

```ts
import { z } from 'zod'
import { Selector, Point } from '@enkaku/protocol'

export const DeviceCall = z.discriminatedUnion('method', [
  z.object({ method: z.literal('tap'),        args: z.object({ target: Selector }) }),
  z.object({ method: z.literal('swipe'),      args: z.object({ from: Point, to: Point, ms: z.number().int().positive().default(300) }) }),
  z.object({ method: z.literal('type'),       args: z.object({ text: z.string() }) }),
  z.object({ method: z.literal('key'),        args: z.object({ code: z.union([z.number().int(), z.string()]) }) }),
  z.object({ method: z.literal('find'),       args: z.object({ sel: Selector }) }),
  z.object({ method: z.literal('waitFor'),    args: z.object({ sel: Selector, timeout: z.number().int().positive(), intervalMs: z.number().int().positive() }) }),
  z.object({ method: z.literal('screenshot'), args: z.object({}) }),
  z.object({ method: z.literal('app.launch'),    args: z.object({ pkg: z.string(), activity: z.string().optional() }) }),
  z.object({ method: z.literal('app.forceStop'), args: z.object({ pkg: z.string() }) }),
])

export const ChildToParent = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), scriptId: z.string(), version: z.string() }),
  z.object({ t: z.literal('phase'), phase: z.enum(['prepare', 'run', 'finish']) }),
  z.object({ t: z.literal('device.call'), callId: z.string() }).and(DeviceCall),
  z.object({ t: z.literal('artifact.save'), callId: z.string(),
             kind: z.enum(['screenshot', 'file']), label: z.string(),
             dataBase64: z.string().optional(),         // hanya kind 'file'; 'screenshot' diambil core-side
             ext: z.string().optional() }),
  z.object({ t: z.literal('log'), level: z.enum(['debug', 'info', 'warn', 'error']),
             msg: z.string(), fields: z.record(z.string(), z.unknown()).optional() }),
  z.object({ t: z.literal('heartbeat') }),
  z.object({ t: z.literal('result'),
             ok: z.boolean(), value: z.unknown().optional(),
             error: z.object({ code: z.string(), message: z.string(), phase: z.string(), stack: z.string().optional() }).optional(),
             finishRan: z.boolean() }),                  // parent tahu apakah masih perlu finish-only attempt
])

export const ParentToChild = z.discriminatedUnion('t', [
  z.object({ t: z.literal('init'),
             mode: z.enum(['full', 'finish-only']),
             job: z.object({ id: z.string(), attempt: z.number().int(), deviceId: z.string() }),
             params: z.unknown(),
             priorError: z.object({ code: z.string(), message: z.string(), phase: z.string() }).optional() }), // utk finish-only
  z.object({ t: z.literal('device.result'), callId: z.string(),
             ok: z.boolean(), value: z.unknown().optional(),
             error: z.object({ code: z.string(), message: z.string() }).optional() }),
  z.object({ t: z.literal('artifact.result'), callId: z.string(), ok: z.boolean(),
             error: z.object({ code: z.string(), message: z.string() }).optional() }),
  z.object({ t: z.literal('abort'), reason: z.enum(['timeout', 'cancelled', 'hung']) }),
])
```

Sisi parent (`device-executor.ts`): menerima `device.call` → validasi job masih pemegang lease device tsb → eksekusi lewat `DeviceSession` (InputSink `adb-input` Plan 03, Inspector §4.4, shell exec per-device queue Plan 01) → balas `device.result`. Binary hasil `screenshot` (device.call) dikembalikan sebagai base64 di `value` (ukuran screenshot PNG umumnya < 2 MB, dapat diterima untuk M4). `waitFor` **dieksekusi loop-nya di parent** (bukan child yang spam call per-poll) supaya satu call = satu semantik + pacing terpusat.

Timing realism (spec §9.3, `DeviceSettings.timing`): `device-executor` menerapkan jitter pada aksi input — delay acak `betweenActionMs` sebelum aksi, offset acak `coordJitterPx` pada koordinat tap, durasi tekan acak `tapJitterMs` — memakai nilai settings device (default schema spec §12). Implementasinya kecil karena terpusat di satu executor.

### 4.7 Lifecycle: timeout, `finish` selalu jalan, retries, cancel

**Jalur normal:** `prepare → run → finish` di satu child. `run` throw → child menangkap, mengisi `ctx.error`, tetap menjalankan `finish`, lalu kirim `result{ok:false, finishRan:true}`. `prepare` throw → sama (skip `run`). `finish` throw → dilaporkan di `result.error` bila fase sebelumnya sukses; bila sudah ada error sebelumnya, error `finish` hanya di-log (error pertama yang menang).

**Timeout (abort bertingkat):**

1. `t = def.timeout` (default 300 000 ms) per attempt, dihitung sejak `init` diterima child.
2. Saat `t` habis, parent kirim `abort{reason:'timeout'}`. Child: reject semua `device.call` yang pending, hentikan `prepare`/`run` (promise di-race dengan abort signal), lalu **jalankan `finish` dengan sisa waktu grace** (`graceMs = 30_000`), `ctx.error = { code: 'TIMEOUT', phase: 'timeout' }`.
3. Child tidak exit dalam `graceMs` → parent `SIGTERM`, tunggu 5 s, lalu `SIGKILL`. Di titik ini `finish` **tidak sempat jalan di process mati**.
4. **Finish-only attempt:** bila child mati tanpa `result.finishRan === true`, parent spawn child **baru** dengan `init{mode:'finish-only', priorError}` — child hanya `import` bundle, membangun `ctx` (dengan `ctx.error` terisi), dan menjalankan `finish` saja, timeout sendiri 30 s, tanpa retry. Gagal juga → log error + `job.error` mencatat "finish failed", device tetap dilepas ke `idle`.

**Trade-off finish-only (ditulis jujur, wajib masuk README SDK):** `finish` di process segar **tidak berbagi state memori** dengan `run` yang mati. Variabel closure, koneksi, file handle dari attempt sebelumnya hilang. Konsekuensi aturan untuk script author: **`finish` harus stateless & idempotent — hanya boleh bergantung pada `ctx`** (contoh spec §11.1 sudah begitu: screenshot bukti + `forceStop`). Alternatif yang ditolak: (a) skip `finish` saat hard-kill → melanggar janji "device balik clean" spec §11.2; (b) tidak pernah SIGKILL → script hang menyandera device selamanya. Finish-only attempt adalah kompromi yang menepati janji clean-state dengan batasan terdokumentasi.

**Retries (level script):** `def.retries` = jumlah attempt tambahan setelah attempt gagal (gagal = `prepare` throw, `run` throw, timeout, crash child). Tiap attempt = siklus child process penuh (prepare→run→finish) dengan `ctx.job.attempt` naik (1-based). Timeout berlaku **per attempt**. `finish` yang gagal TIDAK memicu retry sendiri. Attempt dicatat di job log + field `meta.attempts` dalam `jobs.result`; skema tabel `jobs` spec §12 tidak diubah. Setelah attempt terakhir gagal → `jobs.status='failed'`, `jobs.error` = error attempt terakhir.

**Cancel:** `POST /api/jobs/:id/cancel` (+ WS `job.cancel`). Status `queued` → langsung `cancelled`. Status `running` → jalur abort yang sama dengan timeout (`abort{reason:'cancelled'}` → grace → kill → finish-only bila perlu), status akhir `cancelled`, **tanpa retry**.

**Runner crash containment:** exit code non-zero / IPC putus tanpa `result` → diperlakukan seperti crash: finish-only attempt, lalu retry bila kuota masih ada. Core sendiri tidak pernah `await` child tanpa timeout — semua tunggu dibungkus deadline.

### 4.8 Artifact & log per job

Layout disk (sesuai spec §7.2 `artifacts/<job-id>/...`):

```
<app-data>/artifacts/<job-id>/
  001-sebelum-post.png          # ctx.artifact.screenshot('sebelum-post')
  002-gagal.png
  003-data-export.json          # ctx.artifact.file('data-export', ..., { ext: 'json' })
  job.log                       # JSON-lines: {ts, level, source, msg, fields?}
```

- Nama file: `<seq 3 digit>-<label tersanitasi>.<ext>` (label di-slug: lowercase, non-alnum → `-`). Kolizi tak mungkin karena seq.
- `artifact.save{kind:'screenshot'}`: **core** yang mengambil screenshot (Inspector.screenshot lewat per-device queue) — child tidak mengirim data, hanya label. Ini juga menjamin urutan: screenshot diambil setelah aksi device sebelumnya selesai di queue yang sama.
- `artifact.save{kind:'file'}`: data base64 dari child, limit 8 MB per artifact di M4 (lebih besar → error `ARTIFACT_TOO_LARGE`; chunking = Open questions).
- Setiap artifact → `INSERT artifacts (id, jobId, kind, label, path, sizeBytes, createdAt)` (path **relatif** terhadap app-data, supaya app-data bisa dipindah) → broadcast WS `job.artifact { jobId, artifact }`.
- `job.log`: `job-logger.ts` menerima line dari 4 sumber (`ctx.log` IPC, stdout, stderr, runner sendiri — mis. "attempt 2 mulai", "abort: timeout") → append file + broadcast WS `job.log { jobId, ts, level, source, msg }`. Saat job selesai, `job.log` didaftarkan sebagai row `artifacts` dengan `kind:'log'`, `sizeBytes` = ukuran file.
- Message WS `job.log`/`job.artifact` ditambahkan ke discriminated union `packages/protocol/src/messages/job.ts` (melengkapi `job.enqueue`/`job.status` dari Plan 04, sesuai spec §13).

### 4.9 Publish flow (spec §11.4) & API scripts

**SDK CLI `enkaku publish <entry.ts>`** (di `packages/sdk/src/cli/publish.ts`):

1. `bun build <entry> --target bun --format esm --outfile <tmp>/bundle.mjs` — bundle **semua** dependency (termasuk `@enkaku/sdk` dan `zod`) jadi satu file, tanpa external. Deterministik: farm tidak pernah install dependency (spec §11.4).
2. `await import(bundle)` di process CLI → ambil `default` export, validasi bentuk `ScriptDefinition` (id, version semver, `params` adalah Zod schema, `run` function). Catatan: import ini menjalankan kode top-level script **di mesin author** — wajar (kode milik author sendiri).
3. Konversi `params` → JSON Schema via `z.toJSONSchema()` (Zod v4 native; repo memakai Zod v4 sejak Plan 01 — bila ternyata v3, pakai `zod-to-json-schema`, lihat Open questions).
4. `POST {farmUrl}/api/scripts` body `{ name: def.id, version: def.version, bundle: <isi file>, paramsSchema }`. `farmUrl` dari flag `--farm` (default `http://localhost:<port core Plan 01>`); token dari `--token` / env `ENKAKU_TOKEN` → header `Authorization: Bearer ...`.
5. Cetak hasil: id row, name@version, ukuran bundle.

**Auth M4 (sederhana, sesuai spec §14):** core menerima config opsional `publishToken` (env `ENKAKU_PUBLISH_TOKEN` / config file Plan 01). Bila di-set → semua endpoint mutasi `/api/scripts` & `/api/jobs` wajib Bearer token itu. Bila tidak di-set → hanya diizinkan saat core bind `localhost` (konsisten spec §14 "auto-create admin / skip login hanya kalau bind localhost"). Auth betulan (argon2, session, ACL) = Plan 09.

**REST API (CRUD minimal; UI penuh Plan 07):**

```
GET    /api/scripts                 → list (tanpa kolom bundle — berat)
GET    /api/scripts/:id             → detail + paramsSchema (+ ?bundle=1 utk ikutkan bundle)
POST   /api/scripts                 → publish { name, version, bundle, paramsSchema }
                                      unique (name, version); versi sama sudah ada → 409
PATCH  /api/scripts/:id             → { enabled: boolean }
DELETE /api/scripts/:id             → tolak 409 bila masih ada job queued/running yang memakainya
```

Versioning: tiap publish = row baru (id `crypto.randomUUID()`); `(name, version)` unik (tambah unique index via migrasi Drizzle — kolom mengikuti spec §12 apa adanya). Job selalu mereferensikan `scriptId` row spesifik → run lama tetap reproducible walau versi baru terbit.

### 4.10 Integrasi queue/scheduler (mengganti dummy Plan 04)

- `POST /api/jobs` (dan WS `job.enqueue`) sekarang menerima `{ scriptId, deviceId, params, priority? }`. Core memverifikasi: script ada & `enabled`, device terdaftar. **Validasi params otoritatif terjadi di child** (`def.params.parse()` dari bundle — sumber kebenaran runtime); gagal parse → job `failed` cepat dengan error `PARAMS_INVALID` tanpa menyentuh device (parse dilakukan sebelum `prepare`). Validasi form-side dari `paramsSchema` JSON = urusan Studio Plan 07.
- Transaksi claim `BEGIN IMMEDIATE` Plan 04 (spec §10.3) **tidak berubah**. Yang berubah hanya executor: `scheduler.ts` memanggil `JobRunner.execute(job)` alih-alih dummy sleep.
- `JobRunner.execute`: set device `busy` (sudah dilakukan claim Plan 04) → materialisasi bundle → loop attempt (§4.7) → finalisasi: update `jobs` (`status`, `result`, `error`, `finishedAt`), release lease, device → `idle`, broadcast `job.status`.
- Lease heartbeat: dari heartbeat IPC child (§4.5). Lease expired paksa (kasus patologis: parent core sendiri stuck — seharusnya tak terjadi) tetap ditangani watchdog Plan 04: job failed, device force-release.
- Selama `busy`, input manual di-reject core (state machine Plan 04, spec §10.1) — tidak ada kerjaan baru di sini, hanya memastikan test e2e mencakupnya.

## 5. Langkah implementasi

### Tahap 1 — Tipe shared di `@enkaku/protocol`

- [ ] Buat `packages/protocol/src/ui-node.ts`: `Point`, `Selector` (Zod union §4.3), `UiNode`, `KeyCode` (union number | nama key umum `'HOME'|'BACK'|'ENTER'|...` yang dipetakan ke keycode Android).
- [ ] Ubah `packages/protocol/src/messages/job.ts`: tambah message `job.log`, `job.artifact`, `job.cancel`; extend payload `job.status` dengan `attempt` & `phase`.
- [ ] Export semuanya dari index protocol.
- **Verifikasi:** `bun test packages/protocol` hijau; `Selector.parse({ id: 'x' })` OK, `Selector.parse({ id: 'x', text: 'y' })` gagal (strict).

### Tahap 2 — Package `@enkaku/sdk` (tanpa CLI dulu)

- [ ] Buat `packages/sdk/package.json` (name `@enkaku/sdk`, publishable, deps: `zod` peer + `@enkaku/protocol`), `tsconfig` extend base.
- [ ] Tulis `src/types.ts` (§4.2 persis) dan `src/define-script.ts`; `src/index.ts` re-export.
- [ ] Tulis type-level test: file `src/define-script.test.ts` yang berisi **contoh script spec §11.1 verbatim** (id `post-content`) — harus compile & `defineScript` mengembalikan objek frozen.
- **Verifikasi:** `bun test packages/sdk` hijau; `tsc --noEmit` bersih di package sdk.

### Tahap 3 — Inspector `uiautomator-dump` di `packages/drivers`

- [ ] `src/inspector/xml-parser.ts`: parse XML dump → `UiNode` (fast-xml-parser; tambah dep ke drivers). Simpan 2–3 fixture XML nyata di `src/inspector/__fixtures__/` (ambil dari device: `adb exec-out uiautomator dump /dev/tty`).
- [ ] `src/inspector/selector.ts`: `matchSelector(root, sel): UiNode | null`, `centerOf(bounds): Point` — pure functions.
- [ ] `src/inspector/uiautomator-dump.ts`: class `UiautomatorDumpInspector` (§4.4) — jalur `/dev/tty` + fallback file, retry idle-state, timeout 10 s, `screenshot()` via `exec-out screencap -p`.
- [ ] Registrasi engine ke registry driver (mekanisme Plan 03) dengan id `uiautomator-dump`; resolusi `devices.inspection`: nilai `ui-server` yang belum tersedia → efektif `uiautomator-dump` (log warn sekali).
- **Verifikasi:** unit test parser & matcher hijau dengan fixtures; dengan device (`ENKAKU_TEST_DEVICE=1`): `bun test drivers --grep dump` → dump nyata menghasilkan tree dengan >0 node ber-`resourceId`.

### Tahap 4 — Protokol IPC + child entry

- [ ] `core/src/runner/ipc.ts`: schema `DeviceCall`, `ChildToParent`, `ParentToChild` (§4.6) + helper `sendToParent`/`sendToChild` yang selalu `safeParse` sebelum kirim/proses.
- [ ] `core/src/runner/device-proxy.ts`: implementasi `DeviceApi` sisi child — tiap method membuat `callId` (`crypto.randomUUID()`), kirim `device.call`, tunggu `device.result` (Map pending by callId); abort signal me-reject semua pending.
- [ ] `core/src/runner/child-entry.ts`: `import(bundlePath)` → validasi default export → kirim `ready` → tunggu `init` → mode `full`: `params.parse` → prepare → run → finish; mode `finish-only`: langsung finish dengan `ctx.error = priorError`. Tangani `abort` (AbortController di-race dengan fase aktif). Heartbeat `setInterval(10_000)`. Selalu akhiri dengan `result{finishRan}` lalu `process.exit`.
- [ ] Konstruksi `ctx`: `device` = device-proxy, `artifact` = proxy `artifact.save`, `log` = kirim message `log`, `job` dari init, `error` diisi runner child sebelum finish.
- **Verifikasi:** unit test IPC round-trip (encode → parse) hijau; test child-entry dengan parent palsu (spawn child dengan bundle stub yang me-log & return) → urutan message `ready → phase×3 → result` sesuai.

### Tahap 5 — Parent-side runner

- [ ] `core/src/runner/device-executor.ts`: handler `device.call` → cek lease job atas device → route: input (`tap/swipe/type/key`) ke InputSink Plan 03 (+ timing jitter §4.6), `find/waitFor/screenshot` ke Inspector, `app.launch/forceStop` ke shell exec per-device queue (`monkey`/`am start`, `am force-stop`). Loop `waitFor` di parent (poll `intervalMs`, deadline `timeout`).
- [ ] `core/src/runner/artifact-store.ts`: mkdir `artifacts/<job-id>`, seq counter, sanitasi label, tulis file, insert row `artifacts` dengan `sizeBytes`, broadcast `job.artifact`. Limit 8 MB kind `file`.
- [ ] `core/src/runner/job-logger.ts`: append JSON-lines ke `job.log`, fan-out WS `job.log`; sumber: IPC log, stdout, stderr, runner. Saat job selesai → daftarkan `job.log` sebagai artifact `kind:'log'`.
- [ ] `core/src/runner/job-runner.ts`: `execute(job)` — materialisasi bundle (`scripts/bundle-cache.ts`), loop attempt dengan timeout/abort/SIGTERM/SIGKILL/finish-only (§4.7), retries, heartbeat→lease extend, watchdog silence 30 s, finalisasi job+device+WS.
- [ ] `core/src/scripts/bundle-cache.ts`: tulis `cache/bundles/<scriptId>-<version>.mjs` bila belum ada.
- **Verifikasi:** unit test dengan **bundle stub tanpa device** (script yang hanya log/sleep/throw — semua method device tidak dipanggil): (a) happy path → status success, result tersimpan; (b) run throw → finish tetap jalan (dibuktikan lewat log finish), status failed; (c) sleep ∞ + timeout 2 s → child terbunuh < 10 s, finish-only attempt jalan; (d) retries: 1 → tepat 2 attempt.

### Tahap 6 — API scripts + publish CLI

- [ ] Migrasi Drizzle: unique index `(name, version)` di tabel `scripts` (kolom sudah ada dari Plan 01/04 sesuai spec §12; bila tabel belum dibuat, buat persis spec §12).
- [ ] `core/src/scripts/routes.ts`: endpoint §4.9 + guard `publishToken`/localhost. Registrasi ke Hono app.
- [ ] `packages/sdk/src/cli/publish.ts` + `src/cli/index.ts` + field `bin` di package.json: alur 5 langkah §4.9 (`bun build` → import → `z.toJSONSchema` → POST → cetak). Error jelas untuk: entry tanpa default export, `params` bukan Zod schema, version bukan semver, 409 versi duplikat.
- **Verifikasi:** `bun run packages/sdk/src/cli/index.ts publish examples/open-settings.ts --farm http://localhost:<port>` → 201; `curl /api/scripts` menampilkan row dengan `paramsSchema` JSON valid; publish ulang versi sama → 409; `PATCH enabled:false` → enqueue ditolak.

### Tahap 7 — Integrasi scheduler (ganti dummy) + cancel

- [ ] Ubah `core/src/jobs/scheduler.ts`: executor dummy Plan 04 → `JobRunner.execute`. Hapus/karantina kode dummy ke test helper.
- [ ] Ubah `core/src/jobs/routes.ts`: enqueue `{ scriptId, deviceId, params, priority? }` + validasi script enabled & device ada; endpoint `POST /api/jobs/:id/cancel`; WS `job.cancel`.
- [ ] Pastikan `job.status` broadcast memuat `attempt`/`phase` (dari message `phase` child).
- **Verifikasi:** tanpa device — enqueue job dengan scriptId stub di DB → scheduler claim → child spawn → status berubah `queued→running→success` terlihat via WS; cancel saat running → status `cancelled`, device `idle`.

### Tahap 8 — Script contoh + e2e device + dokumentasi

- [ ] Tulis `examples/open-settings.ts` (dipakai test plan §7): launch `com.android.settings`, `waitFor` node settings, screenshot artifact, finish `forceStop`.
- [ ] README `packages/sdk`: cara nulis script, tiga fase, aturan **finish harus stateless/idempotent** (§4.7), selector berlapis, cara publish, **trust model jujur** (crash containment, bukan sandbox — spec §11.3).
- [ ] README singkat `core/src/runner/` (arsitektur runner + IPC) — cukup komentar modul/README package core.
- [ ] Jalankan seluruh acceptance criteria §6 + test plan §7 (termasuk e2e device), perbaiki sampai hijau.
- **Verifikasi:** semua checklist §6 tercentang; commit `feat(m4): ...`.

## 6. Acceptance criteria

Semua harus lulus sebelum lanjut Plan 06:

1. Contoh script spec §11.1 compile tanpa perubahan terhadap `@enkaku/sdk` (dibuktikan test Tahap 2).
2. `enkaku publish examples/open-settings.ts` menghasilkan satu bundle file, POST sukses, row `scripts` berisi `bundle` + `paramsSchema` (JSON Schema valid dari Zod).
3. Enqueue job `{scriptId, deviceId, params}` → job jalan di child process (terlihat PID berbeda di log runner), status `queued → running → success` via WS `job.status`.
4. Selama job running: (a) device berstatus `busy`; (b) input manual via WS `input.tap` di-reject core; (c) lease terus diperpanjang (tidak pernah expired selama child sehat).
5. `ctx.artifact.screenshot('x')` → file PNG ada di `<app-data>/artifacts/<job-id>/`, row `artifacts` dengan `sizeBytes > 0`, WS `job.artifact` diterima client.
6. `job.log` file berisi JSON-lines dari `ctx.log`, stdout, stderr, dan runner; WS `job.log` streaming realtime saat job jalan; setelah selesai terdaftar sebagai artifact `kind:'log'`.
7. Script yang `run`-nya throw: `finish` tetap dieksekusi dengan `ctx.error` terisi (dibuktikan artifact screenshot 'gagal' dari finish), job `failed`, device kembali `idle`.
8. Script sleep-forever dengan `timeout: 5000`: child menerima abort, dan bila tetap hidup di-SIGKILL; `finish` tetap tereksekusi (in-process saat graceful, atau finish-only attempt saat kill); total waktu job < timeout + grace + 15 s; device kembali `idle`.
9. Script dengan `retries: 1` yang selalu gagal → tepat 2 attempt (terlihat di log + `ctx.job.attempt`), `finish` jalan di tiap attempt.
10. Child yang di-`kill -9` manual dari luar → runner mendeteksi, finish-only attempt jalan, job failed/retry sesuai kuota, core tetap hidup, device `idle`.
11. `find`/`waitFor` bekerja untuk keempat lapis selector (`id`, `desc`, `text`, `point`) terhadap fixture & device nyata; `waitFor` yang tak menemukan → `ScriptError` code `WAITFOR_TIMEOUT` setelah ± timeout.
12. Tidak ada kode di `packages/core/src/runner/child-entry.ts`/`device-proxy.ts` yang mengimport `@enkaku/adb` atau membaca path binary adb (dicek grep) — bukti semua akses device via IPC.
13. `bun test` hijau di seluruh workspace; tidak ada `any` baru tak beralasan; README sdk memuat trust model & aturan finish.

## 7. Test plan

### 7.1 Unit test (`bun test`, tanpa device)

| Area | File test | Kasus |
|---|---|---|
| XML parser | `drivers/src/inspector/xml-parser.test.ts` | fixture dump nyata → tree benar; bounds `[0,63][1080,231]` ter-parse; XML rusak → error; noise prefix `/dev/tty` ter-strip |
| Selector matcher | `drivers/src/inspector/selector.test.ts` | `{id}` full & suffix `:id/`; `{desc}`/`{text}` exact (bukan substring); `{point}` node sintetis; tidak ketemu → null; `centerOf` benar |
| IPC schema | `core/src/runner/ipc.test.ts` | round-trip semua varian message; message tak dikenal → safeParse gagal tanpa throw; `device.call` args invalid ditolak |
| defineScript | `packages/sdk/src/define-script.test.ts` | contoh spec §11.1 compile; objek frozen; id kosong/version non-semver → throw |
| Runner lifecycle | `core/src/runner/job-runner.test.ts` (bundle stub, tanpa device) | happy path; run throw → finish jalan; prepare throw → run di-skip, finish jalan; timeout → abort → (graceful finish) dan varian ignore-abort → SIGKILL + finish-only; retries=1 → 2 attempt; cancel saat running → `cancelled`; child kill -9 → terdeteksi |
| Artifact store | `core/src/runner/artifact-store.test.ts` | path `artifacts/<job-id>/001-label.png`; sanitasi label; sizeBytes benar; file > 8 MB ditolak; row DB (SQLite in-memory) |
| Bundle cache | `core/src/scripts/bundle-cache.test.ts` | tulis sekali, reuse; invalidasi saat versi beda |
| Scripts API | `core/src/scripts/routes.test.ts` | publish → 201; duplikat (name,version) → 409; delete dengan job running → 409; guard token |

### 7.2 e2e dengan device fisik (`ENKAKU_TEST_DEVICE=1`)

Script contoh `examples/open-settings.ts`:

```ts
import { z } from 'zod'
import { defineScript } from '@enkaku/sdk'

export default defineScript({
  id: 'open-settings',
  version: '1.0.0',
  params: z.object({ screenshotLabel: z.string().default('settings-home') }),
  timeout: 60_000,
  retries: 0,
  async prepare(ctx) {
    await ctx.device.app.forceStop('com.android.settings')
  },
  async run(ctx) {
    await ctx.device.app.launch('com.android.settings')
    await ctx.device.waitFor({ text: 'Settings' }, { timeout: 15_000 })  // sesuaikan bahasa device test
    await ctx.artifact.screenshot(ctx.params.screenshotLabel)
    return { opened: true }
  },
  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('gagal')
    await ctx.device.app.forceStop('com.android.settings')
  },
})
```

Prosedur smoke (perintah eksplisit; `$FARM` = URL core dari Plan 01):

```bash
# 1. publish
bun run --cwd packages/sdk src/cli/index.ts publish ../../examples/open-settings.ts --farm $FARM
# 2. ambil scriptId & deviceId
curl -s $FARM/api/scripts | jq '.[0].id'
curl -s $FARM/api/devices | jq '.[0].id'
# 3. enqueue
curl -s -X POST $FARM/api/jobs -H 'content-type: application/json' \
  -d '{"scriptId":"<id>","deviceId":"<id>","params":{}}'
# 4. tail log realtime (helper WS dari Plan 04, subscribe job.log/job.status/job.artifact)
bun run packages/core/scripts/ws-tail.ts --job <jobId>
# 5. verifikasi hasil
curl -s $FARM/api/jobs/<jobId> | jq '.status,.result'
ls -la "$ENKAKU_DATA_DIR/artifacts/<jobId>/"          # PNG + job.log ada
sqlite3 "$ENKAKU_DATA_DIR/enkaku.db" "select kind,label,size_bytes from artifacts where job_id='<jobId>'"
```

Kasus e2e wajib: (a) sukses penuh seperti di atas; (b) saat job running, kirim `input.tap` manual → reject; (c) ubah `waitFor` ke text ngawur → job failed + artifact `gagal.png` dari finish; (d) `POST /api/jobs/<id>/cancel` di tengah run → `cancelled`, Settings ter-forceStop.

### 7.3 NFR check (spec §16)

- Job overhead (claim → `phase:prepare` diterima) diukur dari log timestamp: target **< 3 detik** (spec §16 "spawn→prepare"). Catat hasilnya di PR; bila meleset karena dump pertama lambat, itu jatah Plan 06 — yang dinilai di sini murni spawn+init.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| `uiautomator dump` gagal/hang di app tertentu ("could not get idle state") | `waitFor`/`find` gagal, job failed palsu | Retry+backoff internal `dump()`, timeout 10 s per dump, error code jelas (`INSPECTOR_DUMP_FAILED`); didokumentasikan sebagai keterbatasan M4; Plan 06 solusi struktural (spec §7.4) |
| Dump lambat (0,5–2 s) bikin script merayap | Ekspektasi user meleset | Default `intervalMs` waitFor 1 s (tidak spam); README menyebut angka jujur + roadmap ui-server; NFR inspector < 200 ms baru ditagih di Plan 06 |
| Child ignore `abort` (script pakai loop sinkron ketat) | Graceful finish tak jalan | Lapisan SIGTERM→SIGKILL selalu ada; finish-only attempt menjamin clean-state; watchdog silence 30 s menangkap hang lebih awal dari timeout panjang |
| Finish-only attempt gagal juga (device dalam state aneh) | Device kotor untuk job berikutnya | Log error mencolok + `jobs.error` mencatat finish gagal; device tetap dilepas (pilihan sadar: availability > kebersihan di M4); reset-antar-lease = fitur spec §14 di plan lanjutan |
| `input text` tidak reliable (non-ASCII, karakter spesial) | `type()` salah ketik | Escape agresif (spasi → `%s`, quote shell), dokumentasikan ASCII-only di README; `set_text` per-elemen datang di Plan 06 |
| Base64 screenshot besar lewat IPC | Memori/latency | Screenshot artifact diambil core-side (tanpa lewat IPC); hanya `ctx.device.screenshot()` yang lewat IPC — dokumentasikan agar author pakai `ctx.artifact.screenshot` untuk bukti |
| Bundle jahat/berat (script author) berjalan dengan akses penuh | Keamanan host | **Bukan bug M4 — trust model spec §11.3:** author = operator tepercaya; README + AUP menegaskan; boundary sungguhan Plan 11 |
| `monkey` launch punya side effect (event tak terduga) di beberapa ROM | Launch tidak bersih | Gunakan `-c android.intent.category.LAUNCHER 1` (satu event launch saja); bila `activity` diketahui author, `am start -n` dipakai (jalur yang disarankan di README) |
| Zod versi author ≠ versi farm | paramsSchema/parse beda perilaku | Zod ikut ter-bundle (parse pakai Zod milik bundle — konsisten dengan author); JSON Schema hanya untuk form UI |
| Drift kontrak saat swap ke ui-server (Plan 06) | Script rusak diam-diam | `Selector`/`UiNode`/`Inspector` dibekukan di `@enkaku/protocol` + test kontrak (fixture matcher) yang wajib tetap hijau di Plan 06 |

## 9. Open questions

Ambiguitas spec yang butuh keputusan manusia — jangan diputuskan sepihak saat implementasi:

1. **Selector multi-kriteria & partial match.** Spec §11.2 hanya mendefinisikan empat lapis tunggal (`id/desc/text/point`). Perlukah `{ text, className }` gabungan, `textContains`, atau regex? M4 memilih exact-single-key; kalau kebutuhan nyata muncul di Plan 06/07, putuskan bentuknya di protocol dulu.
2. **Timeout total vs per attempt.** Spec §11.1 hanya menulis `timeout: 180_000` tanpa menyebut interaksi dengan `retries`. M4 memakai per-attempt (worst case ≈ `(retries+1) × (timeout + grace)`). Konfirmasi apakah perlu cap total per job.
3. **Limit artifact `file` 8 MB & chunking IPC.** Spec tidak menyebut batas ukuran artifact dari script. Angka 8 MB adalah pilihan pragmatis M4; kalau use case butuh file besar (video, dump APK), perlu chunking atau jalur tulis-file-langsung — putuskan bersama desain retention/GC (Plan 09).
4. **Kolom `attempt` di tabel `jobs`.** Spec §12 tidak punya kolom attempt; M4 menyimpannya di `result.meta` + log. Kalau Studio Plan 07 mau menampilkan riwayat attempt terstruktur, pertimbangkan revisi spec §12 (tambah kolom/tabel `job_attempts`).
5. **Versi Zod & konversi JSON Schema.** Plan mengasumsikan Zod v4 (`z.toJSONSchema()` native). Bila workspace ternyata di Zod v3 sejak Plan 01, keputusan: upgrade v4 atau dependensi `zod-to-json-schema` di CLI — pilih satu, konsisten dengan `configSchema` registry (spec §8).
6. **`enabled=false` terhadap job queued.** Menonaktifkan script membatalkan job yang sudah queued, atau hanya mencegah enqueue baru? M4 mengimplementasikan yang kedua (paling tidak destruktif); konfirmasi perilaku yang diinginkan untuk Plan 07 UI.
7. **`ctx.device.type()` dan fokus elemen.** `input text` mengetik ke elemen yang sedang fokus; spec §11.1 memanggil `type` setelah `waitFor({id})` tanpa tap eksplisit. Apakah `waitFor` cukup (elemen auto-fokus) atau contoh spec mengasumsikan tap dulu? M4: `type` polos + catatan README "pastikan fokus (tap dulu bila perlu)"; jawaban final mungkin `set_text(selector)` di Plan 06.
8. **Publish token vs user auth.** Spec §14 baru mendefinisikan auth penuh di M7. Apakah token statis `ENKAKU_PUBLISH_TOKEN` M4 perlu dipertahankan sebagai "API token" jangka panjang (untuk CI) setelah Plan 09, atau digantikan session/user token sepenuhnya?
