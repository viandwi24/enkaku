# Plan 04 — M3 : Session, Lease, Queue, Scheduler

> **Status:** draft — siap dieksekusi setelah Plan 01–03 selesai.
> **Depends on:** Plan 01 (core daemon, device registry + stableId, SQLite + Drizzle, WS broadcast, per-device adb queue + semaphore), Plan 02 (Toolchain Manager), Plan 03 (kontrol dasar `screencap-loop` + `adb-input`, Studio live view + klik, enrollment wizard).
> **Referensi spec:** §10 (seluruhnya: state machine, lease + heartbeat, queue SQLite, serialisasi adb), §12 (tabel `jobs`, kolom `devices.status`), §13 (kategori message Queue/job & Control), §20 baris M3.
>
> **Catatan urutan (spec §20):** M3 sengaja dikerjakan **sebelum** script framework (M4). Queue/lease divalidasi memakai **dummy job (`sleep`)** — men-debug antrian dengan job palsu jauh lebih waras daripada men-debug antrian sambil men-debug automation.

---

## 1. Goals

Setelah plan ini selesai, semua pernyataan berikut TRUE dan bisa didemokan:

- Device punya state machine eksplisit `offline → idle → { manual | busy }` + `quarantined`, di-enforce **server-side** di core; transisi ilegal ditolak dan ter-log.
- Saat device `busy`, message `input.*` dari client **di-reject core** dengan error ber-kode (`device_busy`) — bukan sekadar UI di-disable. Video/screen stream tetap berjalan sehingga user bisa menonton automation.
- Lease bekerja untuk dua holder: **manual** (user pegang device dari Studio) dan **job** (executor). Acquire/renew/release konsisten; hanya pemegang lease yang boleh mengirim input.
- Heartbeat executor tiap ~15 detik memperpanjang lease job; lease yang expired otomatis → job `failed` + device **force-release** kembali ke pool (spec §10.2).
- Manual lease punya idle-timeout (default 5 menit, configurable) dan auto-release saat koneksi WS client putus.
- Queue job tersimpan di SQLite (tabel `jobs` persis spec §12); claim job memakai transaksi single-writer `BEGIN IMMEDIATE` persis pola SQL spec §10.3; ordering `priority DESC, created_at ASC`; constraint **per-device** (satu device = maksimal satu job running).
- Scheduler loop berjalan event-driven (device jadi idle / job masuk) dengan fallback interval, dan **hanya scheduler** yang memindahkan status device `idle ↔ busy`.
- Job type dummy `sleep` (param `durationMs`) memvalidasi seluruh alur: `queued → running → success | failed | cancelled`, lease renew, timeout, cancel.
- API tersedia: `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`; WS message `job.enqueue`, `job.cancel`, event `job.status`; semua tervalidasi Zod di `packages/protocol`.
- Studio punya halaman/section antrian minimal: list job + status realtime + tombol enqueue dummy job + tombol cancel.
- Recovery saat core restart: job berstatus `running` yatim ditandai `failed` dengan error `core restarted`; status device di-rekonsiliasi dari kenyataan (track-devices).
- Semua unit test state machine, lease, dan queue hijau di `bun test` (in-memory/temp SQLite, tanpa device fisik).

## 2. Non-goals

Sengaja TIDAK dikerjakan di plan ini:

- **Script framework** (`defineScript`, runner subprocess, artifact/log per job, SDK) → Plan 05 (M4). Di plan ini executor hanya `sleep` in-process.
- **Inspector** apa pun (`uiautomator dump`, `ui-server`) → Plan 05/06.
- **Job detail UI lengkap** (log realtime, artifact viewer, hasil/error kaya) → Plan 07 (M5). Di sini hanya list + status.
- **Auto-quarantine battery/thermal** (spec §15.2) → Plan 07. Plan ini hanya menyiapkan status `quarantined` di state machine + guard scheduler; pemicunya baru API admin manual (opsional) dan belum ada trigger otomatis.
- **Multi-user ACL / auth** untuk lease (siapa boleh nge-lease device siapa) → Plan 09 (M7). Di M3 identitas holder = `clientId` koneksi WS (single-trust local).
- **Retry policy job** (`retries` ada di `defineScript` spec §11.1) → Plan 05, karena retry milik semantics script, bukan queue.
- **Reset device antar-lease** (data hygiene, spec §14) → Plan 09.
- **Postgres / driver DB lain** — SQLite tetap (keputusan final, overview §3).

## 3. Konteks & keputusan desain

Ringkasan keputusan, semuanya merujuk spec:

1. **Server-authoritative (spec §2, §14).** Semua aturan lease/status tinggal di core. Studio hanya merefleksikan state; ketika `busy`, core menolak `input.*` dengan error code — client yang "nakal" (atau bug UI) tidak bisa menabrak automation.
2. **Status device = kolom DB + guard transisi (spec §12).** `devices.status` (`offline|idle|manual|busy|quarantined`) adalah sumber kebenaran, dimutasi hanya lewat satu modul `DeviceStateMachine` dengan `UPDATE ... WHERE status = <from>` (compare-and-swap) supaya transisi ilegal gagal secara atomik, bukan tergantung disiplin caller.
3. **Pembagian wewenang mutasi status (anti-race):**
   - `offline ↔ (idle|…)`: hanya **connectivity handler** (event `adb track-devices` dari Plan 01).
   - `idle ↔ manual`: hanya **LeaseManager** (manual acquire/release).
   - `idle ↔ busy`: hanya **Scheduler** (claim job / job selesai / force-release).
   - `→ quarantined` / `quarantined →`: hanya **quarantine handler** (di M3 cuma via API admin opsional; trigger otomatis Plan 07).
   Race manual-vs-scheduler selesai dengan sendirinya: keduanya CAS dari `idle`; siapa cepat dia menang, yang kalah dapat 0 row → mundur (scheduler skip device, manual acquire dapat error `device_busy`).
4. **Lease job persist di DB, lease manual in-memory.** `jobs.lease_expires_at` sudah ada di schema spec §12 — job lease harus tahan restart (dipakai recovery). Lease manual tidak butuh tahan restart: kalau core mati, koneksi WS semua client ikut mati, sehingga lease manual memang harus lenyap. Maka lease manual cukup map in-memory di `LeaseManager`. (Tidak menambah tabel baru di luar spec.)
5. **Clock = waktu server saja.** Semua expiry dihitung dengan `strftime('%s','now')` (SQLite) atau `Date.now()` core — tidak pernah memakai timestamp kiriman client. Konsisten dengan konvensi timestamp epoch-detik (overview §4.2), `lease_expires_at` disimpan **detik**.
6. **Queue di SQLite dengan `BEGIN IMMEDIATE` (spec §10.3).** SQLite hanya punya satu writer; `BEGIN IMMEDIATE` mengambil write-lock di awal sehingga claim job bersifat serial dan bebas double-claim, bahkan seandainya kelak ada lebih dari satu proses. Pola SQL spec dipakai persis, ditambah update status device dalam transaksi yang sama (lihat §4.4).
7. **Dummy executor `sleep` in-process (spec §20 M3).** Belum ada subprocess runner (itu M4). `sleep` executor = `setTimeout` + heartbeat timer + dukungan abort. Ini cukup untuk memvalidasi: claim, renew, expiry, timeout, cancel, dan serialisasi antrian — tanpa satu baris pun kode automation.
8. **Interaksi dengan per-device adb queue (Plan 01, spec §10.4).** Lease dan adb-queue adalah dua lapisan berbeda: lease = *siapa boleh memakai device*; adb-queue = *serialisasi command ke satu device*. Executor & input manual tetap mengirim command lewat per-device queue + global semaphore. Heartbeat lease **tidak** lewat adb (murni core→DB), jadi operasi adb berat tidak bisa membunuh lease — sejalan dengan alasan revisi §10.4.
9. **Reserved scriptId untuk dummy job.** `jobs.script_id` NOT NULL (spec §12) tapi tabel `scripts` belum terpakai sampai M4. Dummy job memakai id ter-reserve **`internal:sleep`** (prefix `internal:` tidak akan pernah valid sebagai id script user). Tidak ada perubahan schema. (Lihat Open questions #1.)

## 4. Desain teknis

### 4.1 State machine device

Status (kolom `devices.status`, spec §12): `offline | idle | manual | busy | quarantined`.

```
                    +-------------------+
                    |     offline       |◄──────────────────────────┐
                    +-------------------+                           │
                        │          ▲                                │
        DEVICE_CONNECTED│          │DEVICE_DISCONNECTED             │DEVICE_DISCONNECTED
                        ▼          │  (dari state mana pun          │
                    +-------------------+   kecuali quarantined)    │
             ┌─────►|       idle        |─────────┐                 │
             │      +-------------------+         │                 │
   MANUAL_   │        │            │              │                 │
   RELEASED  │        │MANUAL_     │JOB_CLAIMED   │QUARANTINE       │
             │        │ACQUIRED    │(scheduler)   │                 │
             │        ▼            ▼              ▼                 │
      +-----------+       +-----------+      +--------------+       │
      |  manual   |       |   busy    |─────►| quarantined  |───────┘
      +-----------+       +-----------+ QUAR.+--------------+  (tetap quarantined,
             │                  │            ▲    │   UNQUARANTINE   connectivity dicatat
             │       JOB_FINISHED│           │    ▼    → offline/idle terpisah)
             └───────────────────┴───────────┘ (manual juga bisa di-quarantine)
```

Tabel transisi eksplisit (event → from → to). Event di luar tabel = **transisi ilegal** → di-log `warn` dan ditolak (CAS gagal):

| Event | From | To | Pemicu / side effect |
|---|---|---|---|
| `DEVICE_CONNECTED` | `offline` | `idle` | adb track-devices (Plan 01). Kick scheduler. |
| `DEVICE_CONNECTED` | `quarantined` | `quarantined` | Konektivitas dicatat (`last_seen`), status TIDAK berubah. |
| `DEVICE_DISCONNECTED` | `idle` | `offline` | — |
| `DEVICE_DISCONNECTED` | `manual` | `offline` | LeaseManager release lease manual, notify client. |
| `DEVICE_DISCONNECTED` | `busy` | `offline` | Job running di device itu → `failed` (`error: 'device disconnected'`), lease dilepas, abort executor. |
| `DEVICE_DISCONNECTED` | `quarantined` | `quarantined` | `last_seen` saja. |
| `MANUAL_ACQUIRED` | `idle` | `manual` | LeaseManager membuat lease manual. |
| `MANUAL_RELEASED` | `manual` | `idle` | Release eksplisit / WS disconnect / idle-timeout. Kick scheduler. |
| `JOB_CLAIMED` | `idle` | `busy` | Hanya Scheduler, di dalam transaksi claim (§4.4). |
| `JOB_FINISHED` | `busy` | `idle` | Job success/failed/cancelled/expired. Kick scheduler. |
| `QUARANTINE` | `idle` \| `manual` \| `busy` | `quarantined` | Dari `manual`: release lease. Dari `busy`: job → `failed` (`error: 'device quarantined'`). |
| `UNQUARANTINE` | `quarantined` | `idle` atau `offline` | `idle` jika device tersambung (cek track-devices), else `offline`. |

Aturan enforcement server-side terkait status (spec §10.1):

- `manual` dan `busy` **mutually exclusive** — dijamin struktural (keduanya hanya bisa dicapai dari `idle` via CAS).
- Saat `busy`: setiap `input.tap|swipe|key|text` dari client mana pun → reply error `{ code: 'device_busy', message: 'Device is running an automation job' }`. **Display stream (screencap-loop Plan 03) tidak disentuh** — tetap broadcast ke subscriber.
- Saat `manual`: `input.*` hanya diterima dari koneksi pemegang lease; client lain → error `not_lease_holder`. (Plan 03 belum membedakan ini; M3 memperketatnya.)
- Saat `idle`: `input.*` → error `no_lease` (client harus `lease.acquire` dulu; Studio melakukannya otomatis saat membuka live control).
- Saat `offline`/`quarantined`: `input.*` → error `device_unavailable`.
- Scheduler hanya meng-claim job untuk device `idle` (sudah tertanam di SQL claim) — device `manual`, `offline`, `quarantined` otomatis ter-skip.

### 4.2 Lease

```ts
// packages/core/src/lease/types.ts
export type LeaseType = 'manual' | 'job'

export interface Lease {
  deviceId: string
  type: LeaseType
  holder: string          // manual: clientId koneksi WS; job: jobId
  acquiredAt: number      // epoch detik (server clock)
  expiresAt: number       // epoch detik (server clock)
}
```

**LeaseManager** (`packages/core/src/lease/lease-manager.ts`) — satu instance di core:

- `acquireManual(deviceId, clientId): Lease` — CAS `idle → manual`; gagal → throw `EnkakuError('device_busy' | 'device_unavailable')`. `expiresAt = now + manualIdleTimeout`.
- `touchManual(deviceId, clientId)` — dipanggil setiap ada aktivitas input dari holder; geser `expiresAt`. Murah (in-memory).
- `releaseManual(deviceId, clientId)` — CAS `manual → idle`, hapus lease, kick scheduler. Dipanggil dari: request eksplisit, WS `close` handler (release semua lease milik `clientId`), dan reaper saat idle-timeout lewat.
- `acquireJob(deviceId, jobId, ttlSec)` — **tidak dipanggil terpisah**: lease job lahir di dalam transaksi claim scheduler (§4.4), LeaseManager hanya mencatat mirror in-memory untuk lookup cepat.
- `renewJob(jobId)` — `UPDATE jobs SET lease_expires_at = strftime('%s','now') + :ttl WHERE id = :jobId AND status = 'running'`. Dipanggil heartbeat executor.
- `forceReleaseJob(jobId, reason)` — job → `failed`, device CAS `busy → idle`, abort executor kalau masih hidup, kick scheduler.
- `getLease(deviceId): Lease | null` — dipakai gateway input untuk otorisasi.
- `checkInputAllowed(deviceId, clientId)` — mengembalikan `ok` atau error code sesuai aturan §4.1.

**Reaper loop** (interval `reaperIntervalMs`, default 5 000 ms):

- Job: `SELECT * FROM jobs WHERE status='running' AND lease_expires_at < strftime('%s','now')` → tiap hasil: `forceReleaseJob(jobId, 'lease expired')` (spec §10.2: lease expired → job failed + device force-release).
- Manual: lease in-memory dengan `expiresAt < now` → `releaseManual` + notify client (`lease.revoked`, reason `idle_timeout`).

**Konfigurasi** (via `packages/core/src/config.ts` dari Plan 01, semua override-able lewat env):

| Key | Default | Env |
|---|---|---|
| `lease.jobTtlSec` | `60` | `ENKAKU_LEASE_JOB_TTL` |
| `lease.heartbeatMs` | `15_000` | `ENKAKU_LEASE_HEARTBEAT_MS` |
| `lease.manualIdleTimeoutSec` | `300` (5 menit) | `ENKAKU_LEASE_MANUAL_IDLE_TIMEOUT` |
| `lease.reaperIntervalMs` | `5_000` | `ENKAKU_LEASE_REAPER_MS` |
| `scheduler.fallbackIntervalMs` | `2_000` | `ENKAKU_SCHEDULER_INTERVAL_MS` |

TTL 60s + heartbeat 15s = executor boleh telat 3 heartbeat sebelum dianggap mati — sesuai angka `+ 60` di SQL spec §10.3 dan "~15s" di §10.2.

### 4.3 Schema DB: tabel `jobs`

Ambil **persis** dari spec §12 (Drizzle, `packages/core/src/db/schema.ts` — file schema sudah ada sejak Plan 01, tinggal menambah tabel + index):

```ts
export const jobs = sqliteTable('jobs', {
  id:        text('id').primaryKey(),                 // crypto.randomUUID()
  scriptId:  text('script_id').notNull(),             // M3: 'internal:sleep'
  deviceId:  text('device_id').notNull(),
  params:    text('params', { mode: 'json' }),        // M3: { durationMs, failAfterMs?, ignoreCancel? }
  priority:  integer('priority').default(0),
  status:    text('status').default('queued'),        // queued|running|success|failed|cancelled
  leaseExpiresAt: integer('lease_expires_at'),        // epoch detik
  result:    text('result', { mode: 'json' }),
  error:     text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
}, (t) => [
  index('idx_jobs_claim').on(t.status, t.deviceId, t.priority, t.createdAt), // buat query claim
  index('idx_jobs_device').on(t.deviceId, t.createdAt),                      // buat list per device
])
```

State machine **job** (dipusatkan di `job-store.ts`, transisi lain ditolak):

```
queued ──claim──► running ──► success
   │                 │  └────► failed     (error runtime | lease expired | disconnect |
   └──cancel──► cancelled ◄───┘            core restarted | quarantined)
                     ▲
                     └─ cancel saat running (abort executor dulu, lalu cancelled)
```

### 4.4 Claim transaksi (single-writer) & scheduler

SQL claim persis pola spec §10.3, dibungkus `BEGIN IMMEDIATE`, ditambah dua statement dalam **transaksi yang sama** supaya status device & `started_at` atomik dengan claim:

```sql
BEGIN IMMEDIATE;

UPDATE jobs
SET status = 'running',
    lease_expires_at = strftime('%s','now') + 60,      -- :jobTtlSec
    started_at       = strftime('%s','now')
WHERE id = (
  SELECT j.id FROM jobs j
  JOIN devices d ON d.id = j.device_id
  WHERE j.status = 'queued' AND d.status = 'idle'
  ORDER BY j.priority DESC, j.created_at
  LIMIT 1
)
RETURNING *;

-- hanya jika RETURNING menghasilkan 1 row (jobId, deviceId di-bind dari row itu):
UPDATE devices SET status = 'busy'
WHERE id = :deviceId AND status = 'idle';
-- kalau row-count = 0 (mustahil selama semua mutasi status lewat DB yang sama,
-- tapi tetap dicek): ROLLBACK dan skip — device keburu diambil manual.

COMMIT;
```

Implementasi via `db.transaction(..., { behavior: 'immediate' })` (Drizzle + bun:sqlite) atau raw `db.run('BEGIN IMMEDIATE')` — yang penting write-lock dipegang sejak awal transaksi.

**Scheduler** (`packages/core/src/queue/scheduler.ts`) — satu instance, event-driven + fallback interval:

```
kick() dipanggil saat: job.enqueue │ JOB_FINISHED │ MANUAL_RELEASED │ DEVICE_CONNECTED
                       │ UNQUARANTINE │ fallback tiap 2s (jaring pengaman)
        │
        ▼
loop {  claimNext()  -- transaksi §4.4
        ├─ dapat job → start executor (async, tidak ditunggu) → ulangi loop
        └─ tidak ada → berhenti, tunggu kick berikutnya
}
```

- `kick()` idempotent & coalescing: kalau loop sedang jalan, cukup set flag `dirty` — tidak ada dua loop paralel (guard boolean sederhana; core single-process).
- Loop berulang sampai `claimNext()` kosong → sekali kick bisa mengisi **banyak** device idle sekaligus (satu job per device per iterasi, karena setelah claim device jadi `busy` dan tidak match lagi).
- Constraint per-device implicit dari SQL: job hanya match kalau `d.status='idle'`; device yang `busy|manual|offline|quarantined` otomatis ter-skip → **race manual vs scheduler**: siapa pun yang lebih dulu memindahkan device keluar dari `idle` menang.
- Ordering global `priority DESC, created_at ASC` sesuai spec — job prioritas tinggi dari device mana pun di-claim lebih dulu.

### 4.5 Job executor & dummy `sleep`

```ts
// packages/core/src/jobs/executor.ts
export interface JobExecutor {
  /** Jalankan job sampai selesai; resolve = success (dengan result), reject = failed. */
  run(job: JobRow, ctx: ExecutorContext): Promise<unknown>
}
export interface ExecutorContext {
  signal: AbortSignal                    // di-abort saat cancel / force-release
  heartbeat(): Promise<void>             // panggil renewJob(jobId)
  log: Logger
}
```

- `ExecutorHost` (`packages/core/src/jobs/executor-host.ts`) membungkus tiap run: mulai timer heartbeat `setInterval(ctx.heartbeat, 15_000)`, jalankan `executor.run()`, dan pada settle: stop heartbeat, tulis status final + `finished_at` + `result|error`, `JOB_FINISHED` (device → `idle`), broadcast `job.status`, `kick()` scheduler. Registry executor: `Map<scriptId, JobExecutor>`; M3 hanya berisi `internal:sleep`. M4 nanti menambahkan executor subprocess tanpa mengubah host.
- **Dummy `sleep`** (`packages/core/src/jobs/executors/sleep.ts`), params (Zod di protocol):

```ts
export const SleepJobParams = z.object({
  durationMs:  z.number().int().min(0).max(3_600_000),
  failAfterMs: z.number().int().min(0).optional(),  // simulasi job gagal di tengah jalan
  ignoreCancel: z.boolean().default(false),          // simulasi job bandel (tes force-release/expiry)
})
```

  Implementasi: timer yang resolve setelah `durationMs`; reject `EnkakuError('job_failed_simulated')` kalau `failAfterMs` tercapai lebih dulu; listen `signal.abort` → reject `job_cancelled` (kecuali `ignoreCancel: true`, dipakai untuk mengetes jalur lease-expiry: heartbeat host tetap dimatikan oleh cancel, executor pura-pura budek, reaper yang mengeksekusi). Tidak menyentuh adb sama sekali.
- **Cancel semantics:**
  - `queued` → langsung `UPDATE jobs SET status='cancelled', finished_at=... WHERE id=? AND status='queued'` (CAS; kalau keburu running, jatuh ke kasus berikut).
  - `running` → `abortController.abort()`; host menunggu executor settle (grace `5s`), lalu status `cancelled`, device → `idle`. Kalau executor tidak settle dalam grace period → berhenti heartbeat, biarkan reaper meng-expire lease-nya (M4: subprocess akan di-`kill` paksa; in-process M3 tidak bisa kill timer orang lain secara paksa — batasan yang diterima, didokumentasikan).
  - `success|failed|cancelled` → error `job_not_cancellable`.

### 4.6 Recovery saat core boot

Di startup core (`packages/core/src/index.ts`, sebelum scheduler dinyalakan):

1. `UPDATE jobs SET status='failed', error='core restarted', finished_at=strftime('%s','now') WHERE status='running'` — job running yatim **ditandai failed, bukan re-queue** (keputusan: dummy/script job tidak dijamin idempotent; re-queue otomatis berbahaya. Lihat Open questions #2).
2. `UPDATE devices SET status='offline' WHERE status IN ('idle','manual','busy')` — lalu track-devices (Plan 01) menaikkan yang benar-benar tersambung ke `idle`. `quarantined` dipertahankan (sticky).
3. Baru kemudian scheduler `kick()` pertama.

### 4.7 Protocol & API

**`packages/protocol/src/messages/job.ts`** (baru) + perluasan `device.ts` / `input.ts`:

```ts
// client → server
export const JobEnqueueMsg = z.object({
  type: z.literal('job.enqueue'),
  id: z.string().optional(),                    // request-reply correlation (overview §4.3)
  payload: z.object({
    scriptId: z.string(),                       // M3: hanya 'internal:sleep' yang diterima
    deviceId: z.string(),
    params: z.unknown(),                        // divalidasi per-executor (SleepJobParams)
    priority: z.number().int().default(0),
  }),
})
export const JobCancelMsg = z.object({
  type: z.literal('job.cancel'), id: z.string().optional(),
  payload: z.object({ jobId: z.string() }),
})
export const LeaseAcquireMsg = z.object({
  type: z.literal('lease.acquire'), id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})
export const LeaseReleaseMsg = z.object({
  type: z.literal('lease.release'), id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

// server → client (broadcast)
export const JobStatusEvent = z.object({
  type: z.literal('job.status'),
  payload: z.object({
    jobId: z.string(), deviceId: z.string(), scriptId: z.string(),
    status: z.enum(['queued','running','success','failed','cancelled']),
    error: z.string().nullable(), priority: z.number(),
    createdAt: z.number(), startedAt: z.number().nullable(), finishedAt: z.number().nullable(),
  }),
})
export const LeaseRevokedEvent = z.object({
  type: z.literal('lease.revoked'),
  payload: z.object({ deviceId: z.string(), reason: z.enum(['idle_timeout','disconnected','quarantined']) }),
})
// device.status (sudah ada dari Plan 01) — payload status kini bisa 'manual'|'busy'|'quarantined'
```

Error codes baru di `packages/protocol/src/errors.ts`: `device_busy`, `device_unavailable`, `no_lease`, `not_lease_holder`, `job_not_found`, `job_not_cancellable`, `invalid_job_params`, `unknown_script`.

**REST** (`packages/core/src/api/jobs.ts`, Hono route di-mount `/api/jobs`):

| Method + path | Body / query | Respons |
|---|---|---|
| `POST /api/jobs` | `{ scriptId, deviceId, params, priority? }` | `201 { job }` — validasi: device ada & tidak `quarantined`; scriptId terdaftar di registry executor; params lolos schema executor. Device `offline` boleh di-enqueue (job menunggu device online — scheduler hanya match `idle`). |
| `GET /api/jobs` | `?deviceId=&status=&limit=&offset=` (default limit 50, urut `created_at DESC`) | `200 { jobs, total }` |
| `GET /api/jobs/:id` | — | `200 { job }` / `404 { error: { code: 'job_not_found' } }` |
| `POST /api/jobs/:id/cancel` | — | `200 { job }` / `409 { error: { code: 'job_not_cancellable' } }` |

`job.enqueue` / `job.cancel` via WS memakai jalur kode yang sama (service layer `job-service.ts`), hanya beda transport. Setiap perubahan status job → broadcast `job.status` ke semua client WS (satu sumber: `ExecutorHost`/`job-store`, bukan tersebar).

### 4.8 Studio: section antrian minimal

- Halaman baru `packages/studio/src/app/jobs/page.tsx` (App Router): tabel job (id pendek, script, device label, status badge berwarna, priority, created/started/finished, error) + filter status + tombol **Cancel** (muncul untuk `queued|running`).
- Form enqueue dummy: pilih device (dari registry realtime) + input `durationMs` (+ opsional `failAfterMs`) → `POST /api/jobs` dengan `scriptId: 'internal:sleep'`. Ini alat validasi M3 sekaligus demo antrian.
- Realtime: subscribe `job.status` lewat WS client yang sudah ada (Plan 03), update row in-place — tanpa polling.
- Halaman device (Plan 03) diperluas kecil: badge status baru (`manual/busy/quarantined`), tombol "Take control" → `lease.acquire` sebelum input aktif, banner "Automation running — input disabled (watch only)" saat `busy`, dan handling toast untuk `lease.revoked` & error `device_busy`.
- Job detail lengkap tetap Plan 07 — di sini klik row cukup expand JSON job.

### 4.9 Struktur file (dibuat/diubah)

```
packages/protocol/src/
  messages/job.ts                 # BARU — message job.* & lease.*, SleepJobParams
  messages/device.ts              # UBAH — enum status +manual/busy/quarantined
  errors.ts                       # UBAH — error codes baru
packages/core/src/
  db/schema.ts                    # UBAH — tabel jobs + index
  db/migrations/000X_jobs.sql     # BARU — migration (mekanisme migrasi dari Plan 01)
  device/state-machine.ts         # BARU — transisi CAS + tabel event (§4.1)
  lease/types.ts                  # BARU
  lease/lease-manager.ts          # BARU — manual+job lease, reaper (§4.2)
  queue/job-store.ts              # BARU — CRUD jobs + transisi status job + claim tx (§4.3–4.4)
  queue/scheduler.ts              # BARU — loop kick/claim (§4.4)
  jobs/executor.ts                # BARU — interface + registry
  jobs/executor-host.ts           # BARU — heartbeat, settle, broadcast (§4.5)
  jobs/executors/sleep.ts         # BARU — dummy executor (§4.5)
  services/job-service.ts         # BARU — enqueue/cancel/list dipakai REST & WS
  api/jobs.ts                     # BARU — route REST (§4.7)
  ws/handlers/input.ts            # UBAH — guard checkInputAllowed (§4.1)
  ws/handlers/lease.ts            # BARU — lease.acquire/release, release-on-close
  ws/handlers/job.ts              # BARU — job.enqueue/cancel via WS
  index.ts                        # UBAH — wiring: recovery boot (§4.6), reaper, scheduler
packages/studio/src/
  app/jobs/page.tsx               # BARU — list + enqueue form + cancel (§4.8)
  components/job-status-badge.tsx # BARU
  app/devices/[id]/...            # UBAH — take-control, banner busy, badge status
```

## 5. Langkah implementasi

### Tahap 1 — Protocol & schema DB

- [ ] 1.1 Tambah `packages/protocol/src/messages/job.ts`: `JobEnqueueMsg`, `JobCancelMsg`, `LeaseAcquireMsg`, `LeaseReleaseMsg`, `JobStatusEvent`, `LeaseRevokedEvent`, `SleepJobParams`; daftarkan ke discriminated union utama protocol.
- [ ] 1.2 Ubah `packages/protocol/src/messages/device.ts`: enum status device lengkap (`offline|idle|manual|busy|quarantined`).
- [ ] 1.3 Tambah error codes (§4.7) di `packages/protocol/src/errors.ts`.
- [ ] 1.4 Tambah tabel `jobs` + dua index ke `packages/core/src/db/schema.ts` persis §4.3; buat migration `packages/core/src/db/migrations/000X_jobs.sql`.
- **Verifikasi:** `bun test` protocol lulus (parse/reject sample message); core boot di DB kosong → tabel `jobs` tercipta; `sqlite3 enkaku.db '.schema jobs'` menunjukkan kolom sesuai spec §12.

### Tahap 2 — Device state machine

- [ ] 2.1 Buat `packages/core/src/device/state-machine.ts`: tipe `DeviceEvent`, tabel transisi §4.1 sebagai data (`Array<{event, from, to}>`), fungsi `transition(deviceId, event): Promise<TransitionResult>` yang melakukan `UPDATE devices SET status=:to WHERE id=:id AND status=:from` dan mengembalikan `{ ok, from, to }` — 0 row = `{ ok: false }` + log warn "illegal/lost transition".
- [ ] 2.2 Emit event internal (`EventEmitter` core dari Plan 01) + broadcast WS `device.status` pada tiap transisi sukses.
- [ ] 2.3 Refactor connectivity handler Plan 01: track-devices tidak lagi menulis `devices.status` langsung, melainkan memanggil `transition(id, DEVICE_CONNECTED | DEVICE_DISCONNECTED)`; pastikan perlakuan khusus `quarantined` (§4.1) jalan.
- **Verifikasi:** unit test transisi (Tahap 8) hijau; cabut-colok device fisik (atau `adb disconnect` emulator) → status berubah `idle ↔ offline` di WS event log.

### Tahap 3 — LeaseManager + guard input

- [ ] 3.1 Buat `packages/core/src/lease/types.ts` & `lease-manager.ts`: API §4.2, map in-memory lease, config §4.2 dibaca dari `config.ts` (tambahkan key + env baru).
- [ ] 3.2 Buat `packages/core/src/ws/handlers/lease.ts`: `lease.acquire`/`lease.release` (reply sukses/error via envelope `id`), hook `onClose(clientId)` → `releaseAllForClient(clientId)`.
- [ ] 3.3 Ubah `packages/core/src/ws/handlers/input.ts`: sebelum meneruskan `input.*` ke driver, panggil `leaseManager.checkInputAllowed(deviceId, clientId)`; tolak dengan error code sesuai matrix §4.1; kalau lolos → `touchManual()` lalu teruskan ke per-device adb queue (jalur Plan 03 tidak berubah).
- [ ] 3.4 Implement reaper manual-idle-timeout di LeaseManager (bagian job menyusul Tahap 5) + broadcast `lease.revoked`.
- **Verifikasi:** dua tab browser/`wscat`: tab A `lease.acquire` → tap jalan; tab B tap → error `not_lease_holder`; tutup tab A → device kembali `idle`; diam ≥ `manualIdleTimeoutSec` (set env kecil, mis. 5) → `lease.revoked` reason `idle_timeout`.

### Tahap 4 — Job store + claim transaksi

- [ ] 4.1 Buat `packages/core/src/queue/job-store.ts`: `create()` (id `crypto.randomUUID()`, status `queued`, `created_at` server clock), `get/list` (filter+paging §4.7), transisi status job ber-CAS (`markSuccess/markFailed/markCancelledQueued/markCancelledRunning`), `renewLease(jobId)`, `findExpired()`, `failOrphansOnBoot()`.
- [ ] 4.2 Implement `claimNext()` dengan `BEGIN IMMEDIATE` **persis** SQL §4.4 (statement claim spec §10.3 + update device `busy` satu transaksi; TTL dari config, bukan hardcode 60).
- [ ] 4.3 Semua fungsi yang mengubah status job memanggil satu `emitJobStatus(job)` → EventEmitter + broadcast WS.
- **Verifikasi:** unit test claim di temp SQLite (Tahap 8): ordering priority/created_at benar, device non-idle ter-skip, dua `claimNext()` back-to-back tidak pernah mengembalikan job yang sama.

### Tahap 5 — Executor host + dummy sleep + reaper job

- [ ] 5.1 Buat `packages/core/src/jobs/executor.ts` (interface + `registerExecutor`/`getExecutor`) dan `executors/sleep.ts` sesuai §4.5 (durationMs/failAfterMs/ignoreCancel, abort-aware).
- [ ] 5.2 Buat `packages/core/src/jobs/executor-host.ts`: start heartbeat interval (`lease.heartbeatMs`) → `jobStore.renewLease`; settle handler → status final + `JOB_FINISHED` transition + emit + `scheduler.kick()`; simpan `AbortController` per jobId untuk cancel/force-release.
- [ ] 5.3 Lengkapi reaper di LeaseManager: `findExpired()` → `forceReleaseJob(jobId, 'lease expired')` (job `failed`, error `'lease expired'`, abort controller, device `busy → idle`).
- [ ] 5.4 Tangani `DEVICE_DISCONNECTED` saat `busy`: subscribe event state-machine → job aktif device itu `failed` (`'device disconnected'`) + abort; device sudah `offline` (job TIDAK memindahkan device ke idle dalam kasus ini — guard: `JOB_FINISHED` transition hanya dari `busy`).
- **Verifikasi:** manual via `bun repl`/script kecil: enqueue sleep 10s → status `running`, `lease_expires_at` bergeser tiap 15s (cek query); set `ignoreCancel:true` + cancel → dalam ≤ TTL+reaper job jadi `failed 'lease expired'` dan device kembali `idle`.

### Tahap 6 — Scheduler + recovery boot

- [ ] 6.1 Buat `packages/core/src/queue/scheduler.ts`: `kick()` coalescing + loop `claimNext()` → `executorHost.start(job)` (§4.4); fallback `setInterval(kick, fallbackIntervalMs)`.
- [ ] 6.2 Wire sumber kick: `job.enqueue`, `JOB_FINISHED`, `MANUAL_RELEASED`, `DEVICE_CONNECTED`, `UNQUARANTINE`.
- [ ] 6.3 Ubah `packages/core/src/index.ts` urutan boot: migrasi DB → `failOrphansOnBoot()` (`error='core restarted'`) → reset status device non-quarantined ke `offline` → start track-devices → start reaper → start scheduler → `kick()`.
- **Verifikasi:** enqueue 3 job sleep ke 1 device → jalan berurutan otomatis; matikan core saat job running → start ulang → job itu `failed` dengan error `core restarted`, device kembali `idle` setelah terdeteksi, job `queued` sisanya lanjut jalan.

### Tahap 7 — API REST + WS handler + Studio

- [ ] 7.1 Buat `packages/core/src/services/job-service.ts` (validasi enqueue §4.7: device ada, bukan `quarantined`, executor terdaftar, params lolos Zod executor) dan `packages/core/src/api/jobs.ts` (4 endpoint, error envelope `{ error: { code, message } }`).
- [ ] 7.2 Buat `packages/core/src/ws/handlers/job.ts`: `job.enqueue`/`job.cancel` → job-service, reply via correlation `id`.
- [ ] 7.3 Buat halaman `packages/studio/src/app/jobs/page.tsx` + `components/job-status-badge.tsx`: tabel + filter + enqueue form dummy + cancel, subscribe `job.status` (§4.8).
- [ ] 7.4 Ubah halaman device Studio: tombol "Take control" (`lease.acquire`) sebelum input, banner watch-only saat `busy`, badge status baru, toast `lease.revoked`/`device_busy`.
- **Verifikasi:** dari browser: enqueue 3 job dari form → tabel update realtime tanpa refresh; `curl -s localhost:PORT/api/jobs | jq` konsisten dengan tabel; cancel job queued dari UI → badge `cancelled` seketika.

### Tahap 8 — Test & dokumentasi

- [ ] 8.1 Tulis semua unit/integration test §7 (colocated `*.test.ts`, temp/in-memory SQLite via `ENKAKU_DATA_DIR` tmp / `:memory:`).
- [ ] 8.2 Update `packages/core/README.md` (bagian: state machine, lease, queue, konfigurasi env baru) & `packages/protocol/README.md` (message baru).
- [ ] 8.3 Jalankan seluruh acceptance criteria §6, catat hasil.
- **Verifikasi:** `bun test` hijau di seluruh workspace; smoke test manual §7.3 lulus.

## 6. Acceptance criteria

Semua harus lulus sebelum commit final `feat(m3): ...`:

- [ ] Tabel `jobs` ada di SQLite sesuai spec §12; migration jalan di DB lama (dari Plan 03) tanpa kehilangan data.
- [ ] Transisi status device hanya terjadi sesuai tabel §4.1; event ilegal tidak mengubah DB dan ter-log warn.
- [ ] `input.*` saat device `busy` → reply error `device_busy`; frame screencap tetap mengalir ke subscriber selama job jalan (dibuktikan menonton device saat dummy job running — layar tetap update).
- [ ] `input.*` tanpa lease → `no_lease`; dari client bukan holder → `not_lease_holder`; device `offline|quarantined` → `device_unavailable`.
- [ ] Manual lease: auto-release saat WS close, dan saat idle-timeout (default 300s, bisa diubah via `ENKAKU_LEASE_MANUAL_IDLE_TIMEOUT`) dengan event `lease.revoked`.
- [ ] 3 job sleep di-enqueue ke 1 device idle → berjalan **berurutan** (tidak pernah 2 `running` untuk device yang sama; dibuktikan query + test), semua berakhir `success`, device kembali `idle`.
- [ ] Job di 2 device berbeda berjalan **paralel** (queue-nya per-device, bukan global-serial).
- [ ] Ordering: job priority lebih tinggi di-claim duluan meski `created_at` lebih baru; priority sama → FIFO `created_at`.
- [ ] Heartbeat memperpanjang `lease_expires_at` setiap ~15s selama job jalan; executor yang berhenti heartbeat → dalam ≤ TTL + interval reaper job jadi `failed` `'lease expired'` dan device force-release ke `idle`, lalu job antrian berikutnya jalan.
- [ ] Cancel job `queued` → `cancelled` tanpa pernah running; cancel job `running` → executor di-abort, job `cancelled`, device `idle`.
- [ ] Device disconnect saat job running → job `failed` `'device disconnected'`, device `offline`; saat reconnect, job `queued` berikutnya jalan.
- [ ] Core restart saat ada job running → setelah boot: job itu `failed` `'core restarted'`, tidak ada device nyangkut di `busy`, scheduler lanjut memproses antrian.
- [ ] Race manual vs scheduler: device yang keburu `manual` tidak pernah di-claim scheduler; `lease.acquire` ke device `busy` → error `device_busy`.
- [ ] `POST/GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel` berperilaku sesuai §4.7 termasuk error envelope; enqueue `scriptId` tak dikenal → `unknown_script`, params invalid → `invalid_job_params`.
- [ ] Halaman Studio `/jobs` menampilkan antrian realtime (tanpa refresh) + bisa enqueue & cancel dummy job.
- [ ] Semua timestamp/expiry memakai clock server (tidak ada `Date` dari payload client yang dipakai untuk keputusan).
- [ ] `bun test` hijau; tidak ada `console.log` liar; error semua lewat `EnkakuError` ber-kode.

## 7. Test plan

### 7.1 Unit test (bun test, tanpa device — pure logic + temp SQLite)

`packages/core/src/device/state-machine.test.ts` (DB `:memory:` + seed 1 device):
- Setiap baris tabel transisi §4.1 → `ok: true` dan status DB berubah benar.
- Event ilegal (mis. `JOB_CLAIMED` saat `manual`, `MANUAL_ACQUIRED` saat `busy`, `JOB_FINISHED` saat `offline`) → `ok: false`, status tidak berubah.
- `DEVICE_CONNECTED` saat `quarantined` → tetap `quarantined`.
- Dua transisi bersaing dari `idle` (simulasi: panggil `MANUAL_ACQUIRED` lalu `JOB_CLAIMED` tanpa await interleaving) → tepat satu yang `ok`.

`packages/core/src/lease/lease-manager.test.ts` (fake timers Bun):
- acquire manual di `idle` → lease tercatat, device `manual`; acquire kedua (clientId lain) → `device_busy`.
- `touchManual` menggeser `expiresAt`; tanpa touch, setelah timeout reaper me-release + emit `lease.revoked`.
- `releaseAllForClient` melepas semua lease client tsb.
- `checkInputAllowed` matrix lengkap: idle→`no_lease`, manual-holder→ok, manual-non-holder→`not_lease_holder`, busy→`device_busy`, offline/quarantined→`device_unavailable`.

`packages/core/src/queue/job-store.test.ts` (temp file SQLite — perlu `BEGIN IMMEDIATE` nyata):
- `claimNext` menghormati `priority DESC, created_at ASC` (seed 5 job acak).
- `claimNext` skip job yang device-nya `manual|busy|offline|quarantined`.
- Setelah claim: job `running` + `lease_expires_at ≈ now+TTL` + `started_at` terisi + device `busy` (atomik — assert dalam satu read setelah transaksi).
- Dua claim berurutan tidak pernah mengembalikan job sama; claim saat kosong → null.
- CAS transisi job: `markCancelledQueued` pada job running → gagal; `renewLease` pada job non-running → 0 row.
- `failOrphansOnBoot` → semua `running` jadi `failed` `'core restarted'`.

`packages/core/src/queue/scheduler.test.ts` (temp SQLite + executor sleep asli, durasi kecil 20–50 ms, fake device rows):
- **Skenario wajib 1:** 3 job antri di 1 device → selesai berurutan; assert lewat urutan `started_at` & tidak pernah ada 2 running (subscribe `job.status`, hitung concurrent max = 1).
- 2 device × 2 job → concurrent max = 2, per device tetap serial.
- **Skenario wajib 2 (lease expiry membebaskan device):** job `ignoreCancel:true` durasi panjang, config TTL 1s/heartbeat dimatikan/reaper 200ms → job `failed 'lease expired'`, device `idle`, job berikutnya di device sama ikut jalan.
- **Skenario wajib 3 (cancel):** cancel job `queued` → `cancelled`, tak pernah running; cancel job `running` → abort, `cancelled`, device `idle`, job berikut jalan.
- `failAfterMs` → job `failed`, device tetap dibebaskan (finish path failed == success path untuk device).
- Kick coalescing: 100× `kick()` beruntun → jumlah transaksi claim wajar (tidak meledak), tidak ada double-claim.

`packages/protocol/src/messages/job.test.ts`: parse/reject payload valid & invalid tiap message; `SleepJobParams` menolak `durationMs` negatif.

### 7.2 Integration test (bun test, core di-boot in-process, WS via `Bun.serve` port acak, tanpa device fisik — device di-seed langsung ke DB dengan status `idle` dan connectivity handler dimatikan)

- Enqueue via `POST /api/jobs` → event `job.status` diterima client WS untuk `queued→running→success`.
- `input.tap` saat busy via WS → error reply `device_busy`.
- WS close client pemegang manual lease → `device.status` kembali `idle`.
- Boot-recovery: tulis row job `running` langsung ke DB → boot core → `GET /api/jobs/:id` = `failed`, error `core restarted`.

### 7.3 Smoke test manual (butuh 1–2 device fisik, `ENKAKU_TEST_DEVICE=1`; dokumentasikan hasil di PR)

```bash
# 0. jalankan core + studio (Plan 03 dev setup)
bun run --cwd packages/core dev

# 1. antrian serial di 1 device (DEV1 = deviceId dari GET /api/devices)
for i in 1 2 3; do
  curl -sX POST localhost:3000/api/jobs -H 'content-type: application/json' \
    -d '{"scriptId":"internal:sleep","deviceId":"'$DEV1'","params":{"durationMs":8000}}'; done
watch -n1 'curl -s "localhost:3000/api/jobs?deviceId='$DEV1'" | jq ".jobs[] | {id,status}"'
# harapkan: running satu-satu, sisanya queued; device badge "busy" di Studio; video tetap jalan

# 2. input di-reject saat busy: buka live control device tsb di Studio saat job jalan → klik layar
#    → toast error device_busy; layar tetap streaming

# 3. cancel running
curl -sX POST localhost:3000/api/jobs/$JOB_ID/cancel | jq .job.status   # → cancelled

# 4. lease expiry (job bandel)
curl -sX POST localhost:3000/api/jobs -H 'content-type: application/json' \
  -d '{"scriptId":"internal:sleep","deviceId":"'$DEV1'","params":{"durationMs":600000,"ignoreCancel":true}}'
curl -sX POST localhost:3000/api/jobs/$JOB_ID/cancel
# tunggu ±75s → GET /api/jobs/$JOB_ID → failed "lease expired"; device idle lagi

# 5. disconnect saat running: enqueue sleep 60s → cabut kabel USB
#    → job failed "device disconnected", device offline; colok lagi → device idle

# 6. core restart recovery: enqueue sleep 60s → kill core saat running → start lagi
#    → job failed "core restarted", antrian lanjut

# 7. race manual vs scheduler: pegang device via "Take control" di Studio, lalu enqueue job
#    → job tetap queued; klik release → job langsung jalan
```

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| `BEGIN IMMEDIATE` di Drizzle/bun:sqlite tidak terekspos rapi | Claim tidak benar-benar single-writer | Verifikasi di Tahap 4 dengan test dua koneksi; kalau perlu turun ke raw SQL `db.run('BEGIN IMMEDIATE')` di sekitar statement Drizzle. Aktifkan `PRAGMA busy_timeout` supaya writer kedua menunggu, bukan error `SQLITE_BUSY`. |
| Cancel in-process tidak bisa "kill paksa" executor bandel (belum subprocess) | Job nyangkut menahan device lebih lama dari perlu | Diterima untuk M3 (didokumentasikan): jalur reaper/lease-expiry menjadi backstop (device tetap bebas ≤ TTL). M4 memindahkan executor ke child process yang bisa di-`kill` (spec §11.2). |
| Status device DB drift dari kenyataan (mis. crash antara dua statement) | Device nyangkut `busy`/`manual` | Semua mutasi CAS + claim device-update satu transaksi; recovery boot mereset non-quarantined ke `offline`; reaper job sebagai jaring ketiga. |
| Scheduler loop dan reaper saling menyalip (job expired persis saat finish normal) | Double-transition | Semua transisi job & device CAS — pihak yang kalah dapat 0 row dan no-op; test race di 7.1. |
| Heartbeat berbagi event-loop dengan operasi berat core → telat > TTL | Job sehat dianggap mati | TTL 60s vs heartbeat 15s = margin 4×; heartbeat tidak lewat adb (§3.8). Kalau ternyata masih kejadian, naikkan TTL via env tanpa ubah kode. |
| Fallback interval scheduler 2s membangunkan CPU terus di farm idle | Boros kecil di SBC | Interval hanya menjalankan satu query claim ringan ber-index; bisa diperbesar via env. Event-driven tetap jalur utama. |
| Studio Plan 03 belum punya konsep lease → regresi UX ("kok harus Take control?") | Kebingungan user awal | Studio auto-acquire saat membuka live control + auto-release saat menutup; tombol eksplisit hanya fallback. |

## 9. Open questions

1. **`scriptId` dummy `internal:sleep`** — spec §12 mewajibkan `script_id NOT NULL` dan M4 akan menautkannya ke tabel `scripts`. Apakah nanti (Plan 05) job internal tetap boleh ber-`scriptId` prefix `internal:` tanpa row di `scripts` (perlu pengecualian FK/validasi), atau dummy executor dihapus setelah M4? Rekomendasi: pertahankan `internal:sleep` selamanya sebagai alat diagnosa farm; keputusan final di Plan 05.
2. **Recovery job yatim: `failed` vs re-queue** — plan ini memilih mark `failed` + error `core restarted` (aman, tidak mengasumsikan idempotensi). Spec tidak menentukan. Kalau kelak mayoritas script idempotent, apakah perlu opsi per-job `requeueOnRestart`? (Jangan diputuskan sekarang; kandidat Plan 05 bersama `retries`.)
3. **Idle-timeout manual lease saat user "menonton" tanpa input** — 5 menit tanpa input men-release lease padahal user mungkin masih menonton. Apakah "sedang menonton stream" dihitung aktivitas (touch lease dari frame-ack), atau hanya input? Plan ini memilih **hanya input** (paling sederhana & aman); UX-nya bisa direvisi di Plan 07.
4. **Lease manual untuk job masa depan berjenis "interactive"** (mis. rekaman aksi manual → script, spec §22) akan butuh holder campuran user+job — di luar scope; dicatat supaya desain `Lease.type` tidak dibeton berlebihan.
5. **API admin quarantine manual** (`POST /api/devices/:id/quarantine`) — state machine M3 sudah mendukung, tapi trigger resmi (thermal) baru Plan 07. Bolehkah endpoint admin manual dirilis sejak M3 untuk operasional (mengeluarkan device rusak dari pool)? Rekomendasi: ya, sebagai endpoint sederhana tanpa UI; menunggu konfirmasi.
6. **Prioritas antar-device saat banyak device idle** — SQL spec memilih job global tertinggi lebih dulu; dengan loop berulang semua device idle tetap terisi dalam satu kick, jadi tidak ada starvation device. Tidak perlu keputusan sekarang; dicatat kalau kelak ada kebutuhan fairness per-user (M7 ACL).
