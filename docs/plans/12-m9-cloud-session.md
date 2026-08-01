# Plan 12 — M9a : Mode cloud yang benar-benar berfungsi (session & job di agent)

> **Status:** siap dikerjakan. **Prioritas tertinggi** di antara plan 12–14.
> **Depends on:** Plan 11 (M8a — tunnel, registry agent, mode orchestrator).
> **Referensi spec:** §5.3 (cloud split control plane), §10 (lease/queue), §11 (script framework), §13 (protokol).

---

## 1. Goals

Setelah plan ini selesai, **mode cloud setara dengan mode lokal** untuk operasi harian:

- Buka device milik agent dari Studio cloud → **layar tampil** dan **bisa disentuh**, dengan latensi yang wajar untuk LAN agent.
- Jalankan script di device milik agent → job berjalan **di sisi agent** (dekat device), log & artifact mengalir balik ke control plane secara realtime.
- Lease, antrian, dan penolakan input saat `busy` tetap **diputuskan control plane** — agent tidak boleh punya kebijakan sendiri.
- Tidak ada lagi permintaan yang **diabaikan diam-diam**: setiap operasi yang belum didukung menjawab error ber-kode yang jelas.
- Logika session dipakai bersama core dan agent **tanpa duplikasi kode** (satu implementasi, dua pemakai).

Demo akhir: satu mesin menjalankan control plane, mesin lain (jaringan berbeda) menjalankan agent + HP. Dari browser yang menghubungi control plane, layar HP tampil, tap mendarat tepat, dan job `open-settings` selesai dengan screenshot tersimpan.

## 2. Non-goals

- **Video WebRTC** → Plan 13. Plan ini memakai jalur yang sudah ada (frame lewat tunnel WS). Untuk agent di LAN yang sama dengan control plane ini sudah memadai; kelemahannya di internet publik ditangani Plan 13.
- **Isolasi container per job** → sudah tersedia sebagai `IsolationProvider` (M8c); plan ini hanya memastikan agent memakainya, bukan merancang ulang.
- **Multi-tenant penuh** (pemisahan data antar-customer, kuota, penagihan) → kolom `tenantId` sudah ada tapi belum ditegakkan; di luar lingkup.
- **Auto-update agent** → Plan 14 menangani auto-update desktop; agent menyusul.

## 3. Konteks & keputusan desain

### 3.1 Masalah yang diperbaiki

Diverifikasi langsung pada mode `orchestrator`:

| Operasi | Perilaku sekarang | Seharusnya |
|---|---|---|
| `GET /api/devices` | ✅ device dari agent tampil | tetap |
| `stream.start` | ❌ **tidak dijawab sama sekali** | frame video mengalir |
| `input.tap` | ❌ tidak ada sesi → error menyesatkan | tap sampai ke device |
| `POST /api/jobs` | ❌ ditolak `unknown_script` padahal script ada | job jalan di agent |

Akar masalahnya satu: **control plane tidak punya adb**, sehingga semua operasi device harus dititipkan ke agent — dan agent belum punya penanganannya.

### 3.2 Keputusan: ekstrak `@enkaku/session`, jangan duplikasi

Logika merakit `DeviceSession` (transport + display + input + inspector), menjalankan runner job, dan menulis artifact **sudah ada di `packages/core`**, tapi terikat pada Drizzle/SQLite yang tidak dimiliki agent.

Keputusan (sejalan dengan Plan 11 §4.1): **ekstrak ke package baru `@enkaku/session`** yang tidak mengenal database sama sekali. Core dan agent sama-sama memakainya, masing-masing menyuntikkan sumber datanya sendiri.

```
Sebelum                          Sesudah
core/session/session.ts          @enkaku/session ← dipakai core & agent
core/session/manager.ts            createSession(spec, deps)
core/runner/job-runner.ts          SessionManager
core/runner/device-executor.ts     JobRunner
core/runner/artifact-store.ts      DeviceExecutor
                                   ArtifactSink (interface)
```

Alasan menolak alternatif:
- *Agent import `@enkaku/core`*: menyeret Hono, Drizzle, auth, scheduler ke agent — melawan tujuan "mini-core ringan" (spec §5.3).
- *Salin-tempel kode ke agent*: dua implementasi yang pasti menyimpang; bug diperbaiki di satu tempat saja.

### 3.3 Siapa memutuskan apa

Pembagian ini **tidak boleh kabur**, karena di situlah letak jaminan keamanan spec §2 (server-authoritative):

| Keputusan | Tempat | Alasan |
|---|---|---|
| Boleh/tidaknya input (lease, status `busy`) | **Control plane** | Satu sumber kebenaran; agent bisa saja versi lama atau dimodifikasi |
| Job mana yang di-claim, prioritas, antrian | **Control plane** | Transaksi `BEGIN IMMEDIATE` butuh satu penulis |
| Engine mana yang dirakit | **Control plane** memutuskan, agent mengeksekusi | Validasi capability+locks sudah ada di CP |
| Bagaimana frame di-capture, bagaimana tap dikirim | **Agent** | Dia yang memegang device |
| Mengeksekusi bundle script | **Agent** | Dekat device = query inspector cepat (spec §7.4) |

Agent **memvalidasi ulang** locks secara lokal sebagai lapis kedua, tapi kalau CP dan agent tidak sepakat, **CP yang menang** dan ketidaksepakatan itu dicatat sebagai anomali.

### 3.4 Kenapa job dieksekusi di agent, bukan di control plane

Alternatifnya: control plane menjalankan runner dan mengirim setiap `device.call` lewat tunnel. Ditolak karena satu `waitFor` bisa melakukan puluhan query inspector; tiap query jadi round-trip lintas internet. Dengan runner di agent, hanya hasil akhir dan log yang melintasi tunnel. Ini juga alasan yang sama kenapa spec §7.4 mengutamakan inspector cepat.

### 3.5 Diam bukan jawaban

Setiap message yang tidak bisa dilayani **wajib** menjawab error ber-kode. `stream.start` yang diabaikan diam-diam adalah bug perilaku, terlepas dari fitur cloud-nya — Studio jadi menggantung tanpa penjelasan. Kode error baru: `agent_offline`, `not_supported_in_mode`, `device_not_reachable`.

## 4. Desain teknis

### 4.1 Struktur file

```
packages/session/                        # BARU — dipakai core & agent
  package.json                           # @enkaku/session
  src/
    index.ts
    types.ts                             # SessionSpec, SessionDeps, DeviceSnapshot
    session.ts                           # createSession() — pindahan dari core
    manager.ts                           # SessionManager (refcount, grace close)
    inspector-factory.ts                 # pindahan dari core
    executor.ts                          # DeviceExecutor (device.call → engine)
    artifact.ts                          # interface ArtifactSink (implementasi beda per host)
    runner/                              # pindahan core/src/runner/*
      job-runner.ts  child-entry.ts  ipc.ts  job-logger.ts

packages/agent/src/
  session-host.ts                        # BARU — tangani session.start/stop, alirkan frame
  input-host.ts                          # BARU — tangani input.* dari CP
  job-host.ts                            # BARU — tangani job.dispatch, kirim log/artifact
  artifact-uploader.ts                   # BARU — artifact → CP (chunked)
  index.ts                               # UBAH — wiring ketiga host di atas

packages/core/src/
  tunnel/device-proxy.ts                 # BARU — DeviceSession "palsu" yg meneruskan ke agent
  tunnel/router.ts                       # UBAH — rute input/job + balasan error jelas
  server/ws-handlers.ts                  # UBAH — pilih jalur lokal vs agent
  jobs/executors/remote.ts               # BARU — executor yang mendelegasikan ke agent
  session/*, runner/*                    # DIHAPUS — pindah ke @enkaku/session (re-export sementara)

packages/protocol/src/tunnel.ts          # UBAH — message job.* & session.* dua arah
```

### 4.2 Message tunnel yang ditambah

```ts
// CP → agent
export const InputForwardMessage = z.object({
  type: z.literal('input.forward'),
  payload: z.object({
    deviceId: z.string(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('tap'), x: z.number(), y: z.number() }),
      z.object({ kind: z.literal('swipe'), from: PointSchema, to: PointSchema, durationMs: z.number() }),
      z.object({ kind: z.literal('key'), keycode: z.number() }),
      z.object({ kind: z.literal('text'), text: z.string() }),
    ]),
  }),
})
// Catatan: CP mengirim koordinat PIXEL (sudah dipetakan dari 0..1 memakai
// dimensi frame terakhir), supaya agent tidak perlu tahu ukuran tampilan browser.

// agent → CP
export const SessionStartedMessage = z.object({
  type: z.literal('session.started'),
  payload: z.object({
    deviceId: z.string(),
    codec: z.enum(['png', 'h264']),
    width: z.number(), height: z.number(),
    displayEngine: z.string(), inputEngine: z.string(), inspectorEngine: z.string(),
    degradedReason: z.string().optional(),      // mis. "UHID butuh API ≥ 29"
  }),
})
export const SessionFailedMessage = z.object({
  type: z.literal('session.failed'),
  payload: z.object({ deviceId: z.string(), code: z.string(), message: z.string() }),
})
export const JobProgressMessage = z.object({
  type: z.literal('job.progress'),
  payload: z.object({
    jobId: z.string(),
    kind: z.enum(['phase', 'log', 'artifact', 'result']),
    phase: z.enum(['prepare','run','finish']).optional(),
    log: z.object({ level: z.string(), source: z.string(), msg: z.string(), ts: z.number() }).optional(),
    artifact: z.object({ label: z.string(), kind: z.string(), ext: z.string(), dataBase64: z.string() }).optional(),
    result: z.object({ ok: z.boolean(), value: z.unknown().optional(),
                       error: z.object({ code: z.string(), message: z.string() }).optional() }).optional(),
  }),
})
```

Artifact besar (screenshot > 1 MB) dikirim **berpotong** lewat channel binary tunnel, bukan base64 di JSON — lihat §4.6.

### 4.3 Alur stream video (browser → CP → agent → device)

```
Browser            Control plane                         Agent                  Device
  |-- stream.start ->|                                     |                      |
  |                  |-- cek: device milik agent? ---------|                      |
  |                  |-- lease/status divalidasi di sini   |                      |
  |                  |-- session.start{deviceId,engines} ->|                      |
  |                  |                                     |- createSession() --->|
  |                  |<- session.started{codec,w,h} -------|                      |
  |<- stream.started |                                     |                      |
  |                  |-- tunnel.channel.open{video} ------>|                      |
  |<== frame biner ==|<===== tunnel frame (channel) =======|<== onFrame ==========|
  |-- input.tap ---->| map 0..1 → pixel (frameSize)        |                      |
  |                  |-- input.forward{pixel} ------------>|- InputSink.tap() --->|
  |-- stream.stop -->|-- session.stop -------------------->|- session.close()     |
```

Poin penting: **pemetaan koordinat tetap di control plane**, memakai dimensi frame terakhir yang dilihat CP. Agent tidak pernah tahu ukuran elemen di browser (prinsip sama seperti Plan 03 §4.8).

### 4.4 `DeviceProxy` di control plane

Agar `ws-handlers.ts` tidak penuh percabangan "lokal atau remote", CP membungkus device milik agent dalam objek yang bentuknya sama dengan `DeviceSession`:

```ts
// packages/core/src/tunnel/device-proxy.ts
export function createDeviceProxy(deps: { router: TunnelRouter; deviceId: string }): RemoteSession {
  return {
    deviceId: deps.deviceId,
    frameSize: { width: 0, height: 0 },        // dimutakhirkan dari session.started & frame meta
    input: {
      tap: (p) => deps.router.sendToDevice(deps.deviceId, inputForward('tap', p)),
      // swipe/key/text idem — fire-and-forget, error dilaporkan lewat session.failed
    },
    close: () => deps.router.sendToDevice(deps.deviceId, { type: 'session.stop', ... }),
  }
}
```

`SessionManager` di CP memilih: device dengan `agentId === null` → sesi lokal (kode lama); ada `agentId` → `DeviceProxy`. Handler WS tidak berubah.

### 4.5 Job jarak jauh

`RemoteScriptExecutor` (`core/src/jobs/executors/remote.ts`) menggantikan runner lokal untuk device milik agent:

1. CP meng-claim job seperti biasa (transaksi Plan 04 tidak berubah).
2. CP mengirim `job.dispatch` + bundle (inline bila < 2 MB; selain itu URL bertanda tangan berbatas waktu).
3. Agent menjalankan `JobRunner` dari `@enkaku/session` — **kode yang sama persis dengan mode lokal**, termasuk timeout, retries, dan jaminan `finish` selalu jalan.
4. Agent mengalirkan `job.progress` (fase, log, artifact, hasil).
5. CP menuliskannya ke DB & broadcast ke Studio — Studio tidak bisa membedakan job lokal dan remote.
6. Heartbeat lease: setiap `job.progress` memperpanjang lease. Tunnel putus → tidak ada progress → lease kedaluwarsa → job `failed` lewat mekanisme Plan 04. **Tidak ada jalur khusus** yang bisa jadi sumber bug baru.

### 4.6 Artifact dari agent

Screenshot PNG bisa 1–3 MB; base64 di JSON boros dan membekukan parsing. Aturan:

- Artifact ≤ 256 KB → inline base64 di `job.progress` (sederhana, cukup untuk log/JSON kecil).
- Artifact > 256 KB → agent membuka channel binary `artifact`, mengirim `artifact.begin{jobId,label,ext,totalBytes}`, lalu potongan biner, ditutup `artifact.end`. CP merakit dan menyimpannya seperti artifact lokal.
- Batas tetap 8 MB per artifact (sama dengan Plan 05); melebihi → `ARTIFACT_TOO_LARGE` dari agent.

### 4.7 Error yang jelas menggantikan diam

| Kondisi | Kode | Pesan ke user |
|---|---|---|
| Device milik agent yang sedang offline | `agent_offline` | "Agent <nama> sedang tidak terhubung" |
| Agent tersambung tapi sesi gagal dibuat | `session_failed` | pesan asli dari agent diteruskan |
| Operasi belum didukung di mode ini | `not_supported_in_mode` | menyebut mode & operasinya |
| Tunnel putus di tengah stream | `device_not_reachable` | Studio menampilkan banner + retry otomatis |

## 5. Langkah implementasi

### Tahap 1 — Ekstrak `@enkaku/session`

- [ ] Buat `packages/session` (deps: `@enkaku/protocol`, `@enkaku/drivers`, `@enkaku/adb`, `@enkaku/scrcpy`).
- [ ] Pindahkan `session.ts`, `manager.ts`, `inspector-factory.ts`, `runner/*`, `device-executor.ts` dari core. Ganti ketergantungan DB dengan interface:
  ```ts
  export interface DeviceSnapshotSource { get(deviceId: string): DeviceSnapshot | null }
  export interface ArtifactSink { save(a: { kind; label; data; ext? }): Promise<{ path: string; sizeBytes: number }> }
  ```
- [ ] Core menyediakan implementasi berbasis Drizzle; agent menyediakan versi in-memory + pengunggah tunnel.
- [ ] Sementara, `core/src/session/index.ts` me-*re-export* dari `@enkaku/session` supaya import lama tidak putus; bersihkan di akhir tahap.
- **Verifikasi:** mode lokal berperilaku **persis sama** seperti sebelumnya — stream, input, job, artifact diuji ulang dengan skenario Plan 03–05.

### Tahap 2 — Message protokol

- [ ] Tambah `input.forward`, `session.started`, `session.failed`, `job.progress`, `artifact.begin/end` di `protocol/src/tunnel.ts`.
- [ ] Masukkan ke `AgentToControlSchema` / `ControlToAgentSchema`.
- **Verifikasi:** round-trip parse tiap message; message tak dikenal tetap diabaikan (forward-compat).

### Tahap 3 — Agent: session host

- [ ] `session-host.ts`: tangani `session.start` → `SessionManager.acquire` → balas `session.started` (termasuk `degradedReason` bila engine turun kelas) → alirkan frame ke channel video tunnel.
- [ ] Backpressure: pantau `bufferedAmount` tunnel; lewat ambang, **buang frame** (video boleh hilang, JSON tidak pernah).
- [ ] `session.stop` → release + tutup channel.
- [ ] Device hilang dari `track-devices` saat sesi hidup → `session.failed{device_not_reachable}`.
- **Verifikasi:** dengan device fisik di agent, frame sampai ke CP (hitung fps di CP).

### Tahap 4 — Agent: input host

- [ ] `input-host.ts`: `input.forward` → `session.input.*`. Validasi ulang: device punya sesi hidup, koordinat di dalam batas layar.
- [ ] Gagal → `session.failed` dengan sebab, bukan diam.
- **Verifikasi:** tap dari browser mendarat tepat di device lintas jaringan.

### Tahap 5 — Control plane: DeviceProxy & routing

- [ ] `tunnel/device-proxy.ts` (§4.4); `SessionManager` memilih lokal vs proxy berdasar `devices.agentId`.
- [ ] `ws-handlers.ts`: `stream.start`/`input.*` untuk device remote lewat proxy; semua kegagalan menjawab error §4.7.
- [ ] Hapus jalur "router belum siap → diam"; ganti dengan error eksplisit.
- **Verifikasi:** `stream.start` ke device agent yang offline menjawab `agent_offline` (bukan menggantung).

### Tahap 6 — Job jarak jauh

- [ ] `jobs/executors/remote.ts` (§4.5) + pemilihan executor berdasar `devices.agentId`.
- [ ] Agent `job-host.ts`: jalankan `JobRunner`, alirkan `job.progress`.
- [ ] `artifact-uploader.ts` (§4.6) + perakit di CP.
- [ ] Cancel: CP mengirim `job.cancel` lewat tunnel → agent `runner.abort()`.
- **Verifikasi:** job `open-settings` di device agent → status, log realtime, dan screenshot muncul di Studio sama seperti job lokal.

### Tahap 7 — Ketahanan

- [ ] Tunnel putus saat stream → CP tandai device offline, Studio menampilkan banner, sesi dibersihkan di kedua sisi.
- [ ] Tunnel putus saat job → lease kedaluwarsa → job `failed` ("agent disconnected").
- [ ] Agent restart saat job jalan → job yatim di CP diselesaikan reaper; agent tidak melanjutkan job lama.
- [ ] Dua control plane / dua agent dengan id sama → koneksi lama diputus (sudah ada di registry M8a), pastikan sesi ikut bersih.
- **Verifikasi:** matikan agent di tengah stream & job; tidak ada device yang tersangkut `busy` selamanya.

### Tahap 8 — Dokumentasi

- [ ] `docs/guide/cloud.md`: topologi, cara enroll agent, port yang dibutuhkan (hanya keluar), batasan yang tersisa.
- [ ] Perbarui `packages/agent/README.md` (status per sub-fase).
- **Verifikasi:** orang lain bisa mengikuti panduan dari nol sampai layar HP tampil di browser lintas jaringan.

## 6. Acceptance criteria

1. [ ] Mode lokal tidak mengalami regresi apa pun setelah ekstraksi `@enkaku/session`.
2. [ ] Stream video device agent tampil di Studio cloud; fps tercatat di overlay.
3. [ ] Tap/swipe/ketik dari browser mendarat benar di device agent, termasuk setelah rotasi.
4. [ ] Job berjalan di agent: status, log realtime, artifact, dan hasil identik dengan job lokal.
5. [ ] Cancel job remote berfungsi; `finish` script tetap dijalankan.
6. [ ] Semua kegagalan menjawab error ber-kode — **tidak ada permintaan yang diabaikan diam-diam** (diuji: agent offline, device dicabut, tunnel putus).
7. [ ] Input ditolak saat device `busy`, keputusan diambil control plane (agent tidak bisa melewatinya).
8. [ ] Tunnel putus → device offline, job gagal lewat lease-expiry, tidak ada device tersangkut.
9. [ ] Tidak ada duplikasi logika session antara core dan agent (`@enkaku/session` satu-satunya sumber).
10. [ ] `bun run` typecheck bersih di semua package.

## 7. Test plan

**Tanpa device:** stub `DisplaySource`/`InputSink` di agent; uji urutan message session.start→started→frame→stop, pemetaan koordinat, perakitan artifact berpotong, dan tiap kode error §4.7.

**Dengan device, satu mesin:** control plane + agent + HP di mesin yang sama (`ENKAKU_CP_URL=http://localhost:...`). Membuktikan alur benar tanpa variabel jaringan.

**Dengan device, lintas jaringan (uji sesungguhnya):** control plane di VPS, agent + HP di rumah/kantor di balik NAT. Membuktikan klaim "tanpa port-forward" spec §5.3. Ukur: latensi tap→reaksi, fps, dan perilaku saat internet sengaja diganggu (`tc netem` 2% packet loss) — hasilnya menjadi data pembanding untuk Plan 13.

**Chaos:** matikan agent saat stream; matikan control plane saat job; cabut USB saat job; jalankan dua agent dengan credential sama.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Ekstraksi `@enkaku/session` merusak mode lokal | Regresi di jalur yang sudah stabil | Pindahkan tanpa mengubah perilaku dulu (murni relokasi + interface), verifikasi, baru pakai di agent |
| Frame membanjiri tunnel | Latensi kontrol ikut naik | Buang frame video saat buffer penuh; JSON tidak pernah dibuang |
| Artifact besar menyumbat tunnel | Log realtime tersendat | Kirim lewat channel biner terpisah + batas 8 MB |
| Agent versi lama vs CP baru | Perilaku tak terduga | `agent.hello` membawa versi; CP menolak agent yang terlalu tua dengan pesan jelas |
| Bundle script bocor lewat URL | Kekayaan intelektual customer | URL bertanda tangan, berlaku singkat, sekali pakai |
| Latensi inspector lintas jaringan | `waitFor` lambat | Justru alasan runner dijalankan di agent (§3.4) — pastikan tidak ada `device.call` yang menyeberang tunnel |

## 9. Open questions

1. **Batas ukuran bundle inline** (sekarang diusulkan 2 MB) — apakah CP menyediakan penyimpanan bundle atau agent yang men-cache berdasarkan hash?
2. **Cache bundle di agent**: menyimpan bundle antar-job mempercepat start, tapi menaruh kode customer di disk agent. Perlu kebijakan retensi.
3. **Beberapa control plane untuk satu agent** (HA): sekarang satu agent = satu koneksi. Apakah perlu?
4. **Kompresi log** di tunnel untuk job yang sangat cerewet.
5. **Penegakan `tenantId`**: kolomnya ada, tapi query belum menyaring per tenant. Kapan multi-tenant dianggap wajib?
