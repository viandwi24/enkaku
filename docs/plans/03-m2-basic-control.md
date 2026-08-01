# Plan 03 — M2 : Kontrol dasar (screencap-loop, adb-input, Studio live view, enrollment wizard)

> **Status:** draft, siap dikerjakan setelah Plan 01–02 selesai.
> **Depends on:** Plan 01 (`packages/adb` client + track-devices, device registry + stableId probe, SQLite, WS `/ws` + broadcast device events, per-device queue + semaphore) dan Plan 02 (Toolchain Manager: adb ter-provision, path binary di-resolve dari toolchain — bukan PATH sistem).
> **Referensi spec:** §20 baris M2, §7 (interface 4 lapisan), §7.1 (tabel engine), §8 (registry), §13 (protokol), §15.1 (enrollment), §19 (Dashboard, Enrollment wizard, Device detail — versi minimal).

---

## 1. Goals

Setelah plan ini selesai, semua poin berikut TRUE dan bisa didemonstrasikan dengan device fisik:

- `packages/drivers` ada dan berisi implementasi pertama tiga lapisan driver:
  - Transport `adb-usb` dan `adb-tcp` (wrapper tipis di atas `@enkaku/adb`).
  - DisplaySource `screencap-loop` (~2–3 fps, frame PNG).
  - InputSink `adb-input` (`input tap|swipe|keyevent|text`, mode `sdk`).
- Core punya **registry engine minimal** dan `GET /api/registry` mengembalikan daftar engine (`id`, `displayName`, `capabilities`, `locks`, `configSchema` placeholder) sesuai bentuk spec §8.
- Core punya `createSession(...)` versi awal yang merakit transport + display + input untuk satu device (`inspector: null` — Plan 05).
- Protokol WS diperluas: message `input.tap|swipe|key|text`, `stream.start|started|stop`, enrollment (`device.unauthorized`, `device.pairing.request`, `device.pairing.code`) — semuanya Zod di `packages/protocol`.
- **Format binary frame dengan 1-byte channel prefix + 1-byte streamId** terdefinisi di `packages/protocol` dan dipakai untuk stream PNG; format ini forward-compatible dengan multiplexing scrcpy di Plan 08 (tidak breaking saat codec ganti H.264).
- **Coordinate mapping end-to-end tervalidasi**: klik di browser (elemen video yang di-scale CSS) → normalisasi 0..1 → core map ke pixel device → `input tap` mendarat di titik yang benar, termasuk setelah device dirotasi (probe ulang saat dimensi frame berubah).
- `packages/studio` (Next.js) versi pertama jalan: halaman **Dashboard** (grid device, status realtime via WS) dan **Device detail** (live view PNG di `<canvas>`, klik/swipe/keyboard), dengan WS client + auto-reconnect.
- **Enrollment wizard** minimal: state `unauthorized` terdeteksi → instruksi "cek layar HP, tap Allow"; wireless ADB Android 11+ pairing flow (`adb pair host:port` + 6-digit code) bisa dilakukan dari form di Studio; setelah authorized, pipeline probe stableId dari Plan 01 mendaftarkan device otomatis.
- Core bisa **serve Studio build statis** (mode prod) dan ada alur dev yang terdokumentasi (mode dev: Next dev server terpisah).

## 2. Non-goals

Sengaja TIDAK dikerjakan di plan ini:

- **scrcpy display / UHID / H.264 / WebCodecs** → Plan 08. `screencap-loop` + `adb-input` di sini adalah MVP/fallback yang secara eksplisit akan digantikan sebagai default oleh scrcpy (spec §7.1). Yang wajib dari sekarang hanyalah *format channel prefix* yang tidak breaking.
- **Inspector** (`uiautomator dump` maupun `ui-server`) → Plan 05 & 06. `createSession` mengembalikan `inspector: null`.
- **Lease/state machine `manual|busy`, reject input saat `busy`** → Plan 04. Di M2, input diterima selama device `idle`/terhubung; penegakan lease server-authoritative datang di Plan 04.
- **Schema-driven form renderer** untuk `configSchema` → Plan 07. Di M2 `configSchema` hanya placeholder yang di-serve API, tidak dirender.
- **Battery/thermal badge, quarantined** → Plan 07 (spec §15.2).
- **Auth/TLS** → Plan 09. M2 mengikuti mode local single-user bind `localhost` (spec §14).
- **Capability locks enforcement penuh** (tolak kombinasi engine bentrok) → baru relevan saat ada >1 engine per lapisan yang bisa bentrok (Plan 08); di M2 field `locks` sudah ada di descriptor tapi validasinya trivial.
- Thumbnail live di grid Dashboard (spec §19 menandainya opsional) → tidak dikerjakan; lihat Open questions.

## 3. Konteks & keputusan desain

1. **Kenapa `screencap-loop` dulu, bukan langsung scrcpy?** Sesuai urutan milestone spec §20: M2 memvalidasi *jalur end-to-end* (driver → session → WS → browser → klik → device) dengan teknologi paling sederhana. `adb exec-out screencap -p` tidak butuh push server ke device, tidak butuh decoder di browser (PNG langsung bisa dirender), dan bekerja di semua versi Android. Trade-off yang diterima sadar: latency tinggi (0,3–1,5 dtk per frame), fps rendah (~2–3), bandwidth boros (PNG ratusan KB–beberapa MB per frame), beban CPU di device tiap capture. Ini **fallback/MVP** — Plan 08 mengganti default ke scrcpy; `screencap-loop` tetap dipertahankan sebagai engine fallback (spec §7.1).
2. **`exec-out`, bukan `shell`**: `adb shell screencap -p` di Android lama merusak binary (mangling `\n`→`\r\n`); `exec-out` memberi stdout mentah. Keputusan: selalu `exec-out` untuk data binary.
3. **`adb-input` = mode `sdk`** (spec §9.1): inject via `input` command → lambat, timing kaku, terdeteksi sebagai injeksi. Diterima untuk M2 karena tujuannya remote manual kasar. Keterbatasan didokumentasikan (lihat §4.4), terutama `input text`: hanya ASCII aman, butuh escaping ketat.
4. **Channel prefix binary dirancang SEKARANG** supaya Plan 08 tinggal menambah codec/channel tanpa mengubah framing: byte-0 = channel (video/audio/control), byte-1 = streamId (dialokasikan server per `stream.start`) — searah dengan pola multiplexing 1-byte prefix ws-scrcpy (spec §6.2). Payload *di dalam* channel boleh berevolusi per-codec; prefix tidak.
5. **Koordinat dinormalisasi 0..1 di client, dipetakan ke pixel di core** (server-authoritative, spec §2): browser tidak pernah tahu/berhitung pixel device. Sumber dimensi = ukuran frame PNG terakhir yang dilihat core (di-parse dari header IHDR), bukan `screenW/screenH` statis dari DB — karena rotasi mengubah efektif W×H. `screenW/screenH` hasil probe Plan 01 tetap dipakai sebagai nilai awal sebelum frame pertama datang.
6. **Enrollment = fitur, bukan afterthought** (spec §15.1). Dua jalur: (a) USB → dialog RSA `unauthorized` → wizard instruksi; (b) wireless Android 11+ → `adb pair` dengan 6-digit code, lalu `adb connect` ke port wireless-debugging. Setelah authorized, tidak ada kode baru untuk registrasi — pipeline track-devices → probe stableId dari Plan 01 yang bekerja.
7. **Registry engine minimal**: cukup agar Studio bisa menampilkan engine yang tersedia & core punya satu sumber kebenaran untuk resolusi `id engine → implementasi`. `configSchema` diisi placeholder (`{}`) karena renderer schema-driven baru di Plan 07; bentuk respons API sudah final sesuai spec §8 supaya Plan 07 tidak mengubah kontrak.
8. **Interface 4 lapisan ditaruh di `packages/protocol`** (`src/driver.ts`): dibutuhkan oleh `drivers` (implementasi), `core` (session), dan nanti `sdk` (Plan 05). Protocol sudah menjadi tempat shared types (spec §4). Jika Plan 01 ternyata sudah meletakkannya di tempat lain, ikuti lokasi Plan 01 dan sesuaikan import — jangan duplikasi definisi.
9. **Satu loop capture per device, banyak viewer**: DisplaySource per device di-share; frame di-broadcast ke semua subscriber WS. Loop hidup hanya saat subscriber > 0 (hemat baterai device).
10. **Dev vs prod serving Studio**: prod = Next.js static export di-serve core (satu origin, zero-config); dev = `next dev` terpisah menunjuk ke core via env. Detail §4.9.

## 4. Desain teknis

### 4.1 Struktur file baru/berubah

```
packages/
  protocol/src/
    driver.ts                 # BARU: interface Transport/DisplaySource/InputSink/Inspector, FrameMeta, Point
    registry.ts               # BARU: EngineDescriptor + RegistryResponse (Zod)
    messages/input.ts         # BARU: input.tap|swipe|key|text (Zod)
    messages/stream.ts        # BARU: stream.start|started|stop|meta (Zod)
    messages/enroll.ts        # BARU: device.unauthorized|device.pairing.* (Zod)
    binary.ts                 # BARU: channel constants + encode/decodeVideoFrame
    index.ts                  # export semua di atas, merge ke discriminated union message
  drivers/
    package.json              # BARU: @enkaku/drivers, private
    src/
      index.ts                # export engine impl + descriptors
      transport/adb-usb.ts    # BARU
      transport/adb-tcp.ts    # BARU
      display/screencap-loop.ts  # BARU
      display/png.ts          # BARU: parse IHDR width/height
      input/adb-input.ts      # BARU
      input/escape.ts         # BARU: escapeInputText
      descriptors.ts          # BARU: EngineDescriptor tiap engine
  core/src/
    registry/engines.ts       # BARU: registry engine (map id→factory, agregasi descriptor)
    http/registry.ts          # BARU: GET /api/registry
    http/studio.ts            # BARU: serve static Studio (prod mode)
    session/session.ts        # BARU: tipe DeviceSession + createSession
    session/manager.ts        # BARU: SessionManager (satu sesi per device, refcount viewer)
    ws/stream.ts              # BARU: handler stream.start/stop + push binary frame
    ws/input.ts               # BARU: handler input.* + coordinate mapping
    enroll/pairing.ts         # BARU: adb pair/connect flow
  studio/                     # BARU: seluruh package (Next.js)
    next.config.ts            # output: 'export'
    src/lib/ws.ts             # WS client + reconnect + typed send/subscribe
    src/lib/binary.ts         # decode frame binary (re-use @enkaku/protocol)
    src/app/page.tsx          # Dashboard grid
    src/app/device/page.tsx   # Device detail (?id=..., lihat §4.9)
    src/components/DeviceCard.tsx
    src/components/LiveView.tsx
    src/components/EnrollmentWizard.tsx
```

### 4.2 Interface driver (protocol/src/driver.ts) — persis spec §7

```ts
export interface Point { x: number; y: number }
export interface FrameMeta { width: number; height: number; codec: 'png' | 'h264'; seq: number; capturedAt: number }

export interface Transport {
  id: string
  serial: string                 // alamat transport adb (bisa berubah)
  stableId: string               // identitas device (spec §7.5)
  connect(): Promise<void>
  disconnect(): Promise<void>
  exec(cmd: string): Promise<string>            // shell text
  execOut(cmd: string): Promise<Uint8Array>     // TAMBAHAN M2: stdout binary (screencap)
}

export interface DisplaySource {
  id: string
  start(): Promise<void>
  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): void
  stop(): Promise<void>
}

export interface InputSink {
  id: string
  mode: 'sdk' | 'uhid' | 'aoa'
  tap(p: Point): Promise<void>
  swipe(from: Point, to: Point, ms: number): Promise<void>
  key(code: number): Promise<void>
  text(s: string): Promise<void>
}

export interface Inspector {      // implementasi: Plan 05/06 — M2 hanya deklarasi tipe
  id: string
  dump(): Promise<unknown>
  find(sel: unknown): Promise<unknown | null>
  screenshot(): Promise<Uint8Array>
}
```

Catatan: `execOut` adalah ekstensi kecil terhadap spec §7 (spec hanya punya `exec`) — dibutuhkan untuk data binary. Kalau `@enkaku/adb` Plan 01 sudah punya API setara, delegasikan ke sana.

### 4.3 Transport `adb-usb` / `adb-tcp` (drivers/src/transport/)

Keduanya wrapper tipis di atas `@enkaku/adb` (Plan 01) — semua perintah lewat per-device queue + semaphore Plan 01, path adb dari Toolchain Plan 02:

- `adb-usb`: `connect()` = no-op verifikasi device ada di daftar `track-devices` dengan serial tsb & state `device`; `exec` = `adb -s <serial> shell ...`; `execOut` = `adb -s <serial> exec-out ...`.
- `adb-tcp`: sama, plus `connect()` menjalankan `adb connect <host:port>` bila serial belum ter-attach, dan `disconnect()` = `adb disconnect <host:port>`.
- Keduanya TIDAK memanggil `adb kill-server` (spec §10.4).
- `stableId` diambil dari record device di DB (hasil probe Plan 01), bukan di-probe ulang di sini.

### 4.4 DisplaySource `screencap-loop` (drivers/src/display/screencap-loop.ts)

```ts
interface ScreencapLoopConfig { intervalMs: number /* default 400 → ~2,5 fps */ }
```

Perilaku:

- Loop `while (running)`: `t0 = now` → `png = await transport.execOut('screencap -p')` → validasi signature PNG (8 byte pertama `89 50 4E 47 0D 0A 1A 0A`; kalau korup, skip frame + log warn) → parse IHDR (`png.ts`: width = u32BE offset 16, height = u32BE offset 20) → emit `onFrame(png, { width, height, codec: 'png', seq: n++, capturedAt })` → sleep `max(0, intervalMs - (now - t0))`.
- **Deteksi rotasi**: bila `width×height` berbeda dari frame sebelumnya, tetap emit seperti biasa — meta frame adalah satu-satunya sumber kebenaran dimensi; konsumen (SessionManager) yang memutakhirkan state (lihat §4.7).
- Loop serial per device: capture berikutnya tidak dimulai sebelum yang sebelumnya selesai (tidak menumpuk perintah di adb queue).
- `stop()` menghentikan loop & menunggu iterasi berjalan selesai (tidak memutus exec di tengah).
- Error `execOut` (device cabut, unauthorized): retry dengan backoff 1s/2s/5s; setelah 3 gagal beruntun → emit error ke SessionManager → sesi ditutup, status device mengikuti track-devices.

Trade-off (dokumentasikan juga di README drivers): fps rendah, latency tinggi, PNG besar, CPU device per capture, tanpa audio. Ini **fallback/MVP** — digantikan scrcpy (H.264, ≥24 fps, <150 ms) di Plan 08.

### 4.5 InputSink `adb-input` (drivers/src/input/adb-input.ts)

- `mode: 'sdk'` (spec §9.1 — injeksi `InputManager`, terdeteksi sebagai non-hardware; fallback kasar sesuai spec §7.1).
- `tap({x,y})` → `input tap <x> <y>` (pixel device, integer).
- `swipe(from,to,ms)` → `input swipe x1 y1 x2 y2 <ms>`; clamp `ms` ke [50..10000].
- `key(code)` → `input keyevent <code>` (validasi integer 0..320).
- `text(s)` → `input text '<escaped>'` dengan `escapeInputText` (`input/escape.ts`):
  - Tolak string non-ASCII-printable (`/[^\x20-\x7E]/`) dengan `EnkakuError('INPUT_TEXT_UNSUPPORTED')` — `input text` tidak andal untuk unicode/IME; teks penuh datang bersama scrcpy/UHID (Plan 08) atau `ui-server.set_text` (Plan 06).
  - Ganti spasi → `%s` (kontrak `input text`), escape `%` literal → `\%`.
  - Bungkus single-quote shell, escape `'` → `'\''`; karakter shell-berbahaya lain aman karena quoting.
  - Batasi panjang ≤ 1000 char per panggilan.
- Semua perintah lewat `transport.exec` → otomatis antre di per-device queue Plan 01 (input tidak balapan dengan screencap).
- Keterbatasan yang dicatat: lambat (~50–200 ms per perintah), timing kaku/berpola, tidak ada multi-touch, tidak ada drag dengan kecepatan variabel.

### 4.6 Registry engine minimal (core/src/registry/engines.ts + GET /api/registry)

```ts
// protocol/src/registry.ts
export const EngineDescriptor = z.object({
  id: z.string(),
  displayName: z.string(),
  kind: z.enum(['transport', 'display', 'input', 'inspector']),
  capabilities: z.array(z.string()).default([]),
  locks: z.array(z.string()).default([]),
  configSchema: z.record(z.string(), z.unknown()).default({}),   // JSON Schema; M2: {} placeholder
})
export const RegistryResponse = z.object({
  transports: z.array(EngineDescriptor),
  displays: z.array(EngineDescriptor),
  inputs: z.array(EngineDescriptor),
  inspectors: z.array(EngineDescriptor),
  tools: z.array(z.object({ id: z.string(), displayName: z.string(), swappable: z.boolean() })),
})
```

- Descriptor konkret di `drivers/src/descriptors.ts`: `adb-usb`, `adb-tcp` (kind transport), `screencap-loop` (display, `capabilities: ['png']`), `adb-input` (input, `locks: ['input-injection']` — sesuai pola spec §9.5).
- `core/src/registry/engines.ts` menyimpan map `id → factory(deviceRecord, transport) → engine` + agregasi descriptor; `GET /api/registry` (core/src/http/registry.ts) mengembalikan `RegistryResponse` (bagian `tools` diambil dari Toolchain Plan 02).
- **Bentuk respons sudah final sesuai spec §8**; Plan 07 hanya mengisi `configSchema` sungguhan + form renderer, tanpa mengubah kontrak.

### 4.7 DeviceSession factory awal (core/src/session/)

```ts
export interface CreateSessionOpts {
  deviceId: string
  transport?: string   // default dari kolom devices.transport
  display?: string     // default devices.display → M2: paksa 'screencap-loop' bila 'scrcpy' belum ada
  input?: string       // idem → 'adb-input'
  inspection?: string  // diabaikan di M2
}
export interface DeviceSession {
  deviceId: string
  transport: Transport
  display: DisplaySource
  input: InputSink
  inspector: null                       // Plan 05
  frameSize: { width: number; height: number }   // dimutakhirkan dari FrameMeta
  close(): Promise<void>
}
export async function createSession(opts: CreateSessionOpts): Promise<DeviceSession>
```

- `createSession` me-resolve id engine lewat registry; id tak dikenal → `EnkakuError('ENGINE_NOT_FOUND')`.
- Default kolom DB (`scrcpy`, `scrcpy-uhid`, `ui-server` — spec §12) belum punya implementasi → resolusi memakai **fallback chain eksplisit**: display `scrcpy → screencap-loop`, input `scrcpy-uhid → adb-input`, dicatat di log level info. Nilai kolom DB TIDAK ditulis ulang.
- `frameSize` diinisialisasi dari `devices.screenW/screenH` (probe Plan 01), lalu **selalu di-overwrite oleh meta frame terbaru** — inilah mekanisme "probe ulang saat ukuran frame berubah" untuk rotasi.
- `SessionManager` (session/manager.ts): `acquire(deviceId)` membuat/mengembalikan sesi tunggal per device + refcount subscriber; `release(deviceId)` menurunkan refcount; 0 subscriber → `display.stop()` + close sesi setelah grace 5 detik. Device hilang dari track-devices → sesi ditutup paksa.

### 4.8 Protokol WS: message & binary framing

**Message JSON** (envelope Plan 01: `{ type, id?, payload }`; reply memakai korelasi `id` dengan type `<request>.result`, mengikuti pola Plan 01):

```ts
// protocol/src/messages/input.ts
export const NormPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export const InputTap   = z.object({ type: z.literal('input.tap'),
  payload: z.object({ deviceId: z.string(), pos: NormPoint }) })
export const InputSwipe = z.object({ type: z.literal('input.swipe'),
  payload: z.object({ deviceId: z.string(), from: NormPoint, to: NormPoint,
                      durationMs: z.number().int().min(50).max(10_000).default(300) }) })
export const InputKey   = z.object({ type: z.literal('input.key'),
  payload: z.object({ deviceId: z.string(), keycode: z.number().int().min(0).max(320) }) })
export const InputText  = z.object({ type: z.literal('input.text'),
  payload: z.object({ deviceId: z.string(), text: z.string().min(1).max(1000) }) })

// protocol/src/messages/stream.ts
export const StreamStart   = z.object({ type: z.literal('stream.start'),  id: z.string(),
  payload: z.object({ deviceId: z.string() }) })
export const StreamStarted = z.object({ type: z.literal('stream.started'), id: z.string(),
  payload: z.object({ deviceId: z.string(), streamId: z.number().int().min(0).max(255),
                      codec: z.enum(['png', 'h264']), width: z.number(), height: z.number() }) })
export const StreamStop    = z.object({ type: z.literal('stream.stop'),
  payload: z.object({ streamId: z.number().int() }) })
export const StreamMeta    = z.object({ type: z.literal('stream.meta'),     // rotasi/resize
  payload: z.object({ streamId: z.number().int(), width: z.number(), height: z.number() }) })
```

**Binary framing** (`protocol/src/binary.ts`) — berlaku untuk SEMUA stream binary sejak M2, termasuk scrcpy Plan 08:

```
byte 0        : u8  channel   — 0x01 VIDEO, 0x02 AUDIO (reserved P08), 0x03 CONTROL (reserved P08)
byte 1        : u8  streamId  — dialokasikan core saat stream.started (per koneksi WS)
byte 2..N     : payload, format ditentukan (channel, codec yang dinegosiasikan di stream.started)

Payload VIDEO codec 'png' (M2):
  byte 2      : u8  codec     — 0x01 PNG (0x02 H264 dipakai Plan 08)
  byte 3..4   : u16BE width   — dimensi frame (deteksi rotasi di client tanpa decode)
  byte 5..6   : u16BE height
  byte 7..10  : u32BE seq
  byte 11..   : data PNG utuh
```

```ts
export const CHANNEL = { VIDEO: 0x01, AUDIO: 0x02, CONTROL: 0x03 } as const
export const VIDEO_CODEC = { PNG: 0x01, H264: 0x02 } as const
export function encodeVideoFrame(streamId: number, meta: FrameMeta, data: Uint8Array): Uint8Array
export function decodeVideoFrame(buf: Uint8Array):
  { channel: number; streamId: number; codec: number; width: number; height: number; seq: number; data: Uint8Array }
```

Aturan forward-compat: byte 0–1 **tidak pernah berubah artinya**; codec baru = nilai `codec` baru + payload sendiri; channel baru = nilai `channel` baru. Plan 08 menambah `H264`/AUDIO/CONTROL tanpa menyentuh parser M2.

**Alur stream & input di core (ws/stream.ts, ws/input.ts):**

```
Studio                          Core                                  Device
  |-- stream.start{deviceId} --->| SessionManager.acquire → loop start  |
  |<- stream.started{streamId,   |                                      |
  |     codec:'png', w, h}       |                                      |
  |                              |-- exec-out screencap -p ------------>|
  |<== binary VIDEO frame =======|<------------------------- PNG ------|
  |   (skip bila bufferedAmount  |  (meta.w/h ≠ frameSize → update      |
  |    > 4 MB — backpressure)    |   frameSize + kirim stream.meta)     |
  |-- input.tap{deviceId,pos} -->| map 0..1 → pixel (frameSize) ------->| input tap x y
  |-- stream.stop{streamId} ---->| SessionManager.release               |
```

- Core validasi semua message dengan Zod `safeParse`; gagal → `{ error: { code: 'BAD_MESSAGE', ... } }`.
- Input untuk device `offline`/`unauthorized` → error `DEVICE_NOT_READY`. (Reject saat `busy` menyusul Plan 04.)
- Koneksi WS putus → semua stream milik koneksi itu auto-release.

**Coordinate mapping (ws/input.ts):**

```ts
export function mapNormToDevice(pos: { x: number; y: number }, frame: { width: number; height: number }): Point {
  return {
    x: Math.min(frame.width - 1, Math.max(0, Math.round(pos.x * frame.width))),
    y: Math.min(frame.height - 1, Math.max(0, Math.round(pos.y * frame.height))),
  }
}
```

Client (LiveView) menormalisasi terhadap ukuran *tampilan* elemen: `x = (e.clientX - rect.left) / rect.width` — jadi scaling CSS/devicePixelRatio tidak pernah bocor ke server. Rotasi: frame baru → `frameSize` di core berubah → tap berikutnya sudah memakai dimensi baru; client juga menerima `stream.meta` dan menyesuaikan aspect-ratio canvas.

### 4.9 Studio (packages/studio)

- Next.js App Router, TypeScript strict, `output: 'export'` di `next.config.ts` (build → `out/`).
- **Halaman device detail memakai query param** `/device?id=<deviceId>` (bukan route dinamis `[id]`) karena static export tidak bisa pre-render id dinamis. Konsekuensi kecil ini dicatat di README studio; boleh direfaktor saat Plan 07/09 jika mode serving berubah.
- `src/lib/ws.ts`: WS client tunggal (module singleton): connect ke `<coreBase>/ws`, `binaryType: 'arraybuffer'`; auto-reconnect exponential backoff (0,5s → maks 10s) + resubscribe stream yang aktif; API `send(msg)`, `request(msg)` (menunggu `<type>.result` dengan `id` sama), `on(type, cb)`, `onBinary(cb)`. Semua message masuk di-`safeParse` terhadap union `@enkaku/protocol`.
- Resolusi `coreBase`: prod (di-serve core) → `location.origin`; dev → `NEXT_PUBLIC_ENKAKU_CORE_URL` (mis. `http://localhost:4700` — samakan dengan port core dari Plan 01).
- **Dashboard (`app/page.tsx`)**: fetch awal `GET /api/devices` (Plan 01) → render grid `DeviceCard` (label, serial, stableId, status badge offline/idle/unauthorized); update realtime dari event WS `device.added|removed|status`; card `unauthorized` menampilkan tombol "Enroll" → buka `EnrollmentWizard`; tombol "Pair wireless device" global di header; klik card `idle` → `/device?id=...`.
- **Device detail (`app/device/page.tsx` + `LiveView.tsx`)**:
  - Mount → `request(stream.start)` → simpan `streamId`; unmount → `stream.stop`.
  - `onBinary`: `decodeVideoFrame` → filter `streamId` → `createImageBitmap(new Blob([data]))` → gambar ke `<canvas>` (ukuran internal = width×height frame; CSS `max-width:100%`). Frame out-of-order dibuang pakai `seq`.
  - Mouse: click → `input.tap`; drag (pointerdown→pointerup, jarak > 10 px, kirim `durationMs` = durasi drag di-clamp) → `input.swipe`.
  - Keyboard: saat canvas fokus — karakter printable di-buffer & dikirim `input.text` (debounce 500 ms), Enter/Backspace/tombol nav → `input.key` (map ke `AKEYCODE`: Enter 66, Del 67, Home 3, Back 4, App-switch 187; sediakan juga tombol UI Back/Home/Recents).
  - Indikator: status koneksi WS, fps aktual, dimensi frame, badge "fallback display: screencap-loop (~2–3 fps)".
- **EnrollmentWizard.tsx** — dua alur (spec §15.1):
  1. **USB unauthorized**: langkah bergambar-teks "Cek layar HP → dialog 'Allow USB debugging' → centang Always allow → tap Allow"; wizard mendengarkan `device.status`; saat serial tsb berubah `unauthorized → device` (probe Plan 01 jalan otomatis) tampilkan sukses + tombol ke device detail.
  2. **Wireless pairing (Android 11+)**: form `host`, `pairing port`, `6-digit code` (dari layar Wireless debugging → "Pair device with pairing code") → kirim `device.pairing.request` lalu `device.pairing.code`; sukses pair → form langkah 2: `connect port` (port di layar utama Wireless debugging, berbeda dari pairing port) → core `adb connect` → device muncul via track-devices → probe → selesai.

### 4.10 Enrollment di core (enroll/pairing.ts + messages/enroll.ts)

```ts
export const DeviceUnauthorized = z.object({ type: z.literal('device.unauthorized'),
  payload: z.object({ serial: z.string() }) })                          // core → studio (event)
export const DevicePairingRequest = z.object({ type: z.literal('device.pairing.request'), id: z.string(),
  payload: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }) })  // studio → core
export const DevicePairingCode = z.object({ type: z.literal('device.pairing.code'), id: z.string(),
  payload: z.object({ pairingId: z.string(), code: z.string().regex(/^\d{6}$/),
                      connectPort: z.number().int().min(1).max(65535).optional() }) })   // studio → core
```

- `device.pairing.request` → core validasi host:port reachable (TCP dial, timeout 3s), buat `pairingId`, reply `{ pairingId }`.
- `device.pairing.code` → core jalankan `adb pair <host>:<port> <code>` (binary adb dari Toolchain; timeout 20s; stdout di-parse: sukses = mengandung `Successfully paired`); bila `connectPort` dikirim → lanjut `adb connect <host>:<connectPort>`. Reply `{ success, message }` (pesan kegagalan adb diteruskan apa adanya untuk ditampilkan wizard).
- Event `device.unauthorized` dipancarkan dari handler track-devices Plan 01 saat state `unauthorized` terlihat (tambahkan mapping state ini bila Plan 01 belum memancarkannya).
- Butuh adb ≥ 30 (mendukung `adb pair`) — sudah dijamin manifest Toolchain Plan 02.

### 4.11 Serving Studio: dev vs prod

| Mode | Cara jalan | URL user | Catatan |
|---|---|---|---|
| **Dev** | Terminal 1: `bun run --cwd packages/core dev`; Terminal 2: `bun run --cwd packages/studio dev` (port 3001) dengan `NEXT_PUBLIC_ENKAKU_CORE_URL=http://localhost:4700` | `http://localhost:3001` | Hot-reload Next. Core mengizinkan CORS + origin WS dari `localhost:3001` **hanya** saat `NODE_ENV !== 'production'`. |
| **Prod / zero-config** | `bun run --cwd packages/studio build` → `out/`; core serve `out/` di `/` (Hono `serveStatic`), fallback 404 → `index.html` (client-side routing); `/api/*` & `/ws` tetap milik core | `http://localhost:4700` | Satu origin → WS/HTTP relative, tanpa CORS. Ini jalur single-binary Plan 09. |

Lokasi `out/` di-resolve: env `ENKAKU_STUDIO_DIST` → default `packages/studio/out` relatif repo. Bila folder tidak ada, core log warn "Studio build tidak ditemukan — jalankan mode dev" dan `/` mengembalikan halaman petunjuk singkat.

## 5. Langkah implementasi

### 5.1 Interface driver + protokol message & binary (packages/protocol)

- [ ] Buat `packages/protocol/src/driver.ts` (interface §4.2) — atau, bila Plan 01 sudah punya lokasi interface, pakai itu dan tambahkan `execOut`/`FrameMeta` di sana.
- [ ] Buat `packages/protocol/src/messages/input.ts`, `messages/stream.ts`, `messages/enroll.ts` (schema §4.8/§4.10); merge ke discriminated union message + export di `src/index.ts`.
- [ ] Buat `packages/protocol/src/binary.ts`: `CHANNEL`, `VIDEO_CODEC`, `encodeVideoFrame`, `decodeVideoFrame` (validasi panjang minimal, channel/codec dikenal; error ber-kode).
- [ ] Buat `packages/protocol/src/registry.ts`: `EngineDescriptor`, `RegistryResponse`.
- [ ] Unit test `binary.test.ts` (roundtrip encode→decode, buffer korup ditolak) dan `messages.test.ts` (parse valid/invalid tiap message).
- **Verifikasi:** `bun test packages/protocol` hijau; `bunx tsc -b` (atau typecheck workspace) bersih.

### 5.2 packages/drivers: scaffold + Transport

- [ ] Buat `packages/drivers/package.json` (`@enkaku/drivers`, private, deps: `@enkaku/protocol`, `@enkaku/adb`), `tsconfig.json` extends base, daftarkan di workspaces bila perlu.
- [ ] Implement `src/transport/adb-usb.ts` dan `src/transport/adb-tcp.ts` (§4.3) di atas `@enkaku/adb`.
- [ ] `src/descriptors.ts`: descriptor `adb-usb`, `adb-tcp` (configSchema `{}`).
- [ ] Unit test transport dengan mock `@enkaku/adb` (perintah yang dibentuk benar: `-s <serial>`, `exec-out`, `connect/disconnect` untuk tcp).
- **Verifikasi:** `bun test packages/drivers` hijau (tanpa device).

### 5.3 DisplaySource screencap-loop

- [ ] `src/display/png.ts`: `parsePngSize(buf): { width, height }` + validasi signature.
- [ ] `src/display/screencap-loop.ts` sesuai §4.4 (interval, serial loop, backoff, stop bersih).
- [ ] Tambah descriptor `screencap-loop` di `descriptors.ts`.
- [ ] Unit test: `png.test.ts` (fixture PNG kecil 2×3 px sebagai byte literal; buffer korup → error); `screencap-loop.test.ts` dengan transport mock (emit ≥ 3 frame, seq naik, meta benar; `stop()` menghentikan; execOut gagal → retry backoff).
- [ ] Device test `screencap-loop.device.test.ts` — hanya jalan bila `ENKAKU_TEST_DEVICE=1`: start loop pada device fisik nyata, tunggu 3 frame ≤ 10 detik, assert signature PNG + dimensi > 0.
- **Verifikasi:** `bun test packages/drivers` hijau; `ENKAKU_TEST_DEVICE=1 bun test packages/drivers` hijau dengan HP tercolok.

### 5.4 InputSink adb-input

- [ ] `src/input/escape.ts`: `escapeInputText` sesuai §4.5.
- [ ] `src/input/adb-input.ts`: tap/swipe/key/text; descriptor `adb-input` (`locks: ['input-injection']`).
- [ ] Unit test `escape.test.ts` (spasi→`%s`, quote, `%`, penolakan non-ASCII & string > 1000) dan `adb-input.test.ts` (mock transport, perintah persis: `input tap 100 200`, clamp swipe ms, keycode invalid ditolak).
- [ ] Device test `adb-input.device.test.ts` (`ENKAKU_TEST_DEVICE=1`): `key(224)` (WAKEUP) lalu `tap` tengah layar — assert tidak throw.
- **Verifikasi:** kedua mode test hijau.

### 5.5 Registry engine + GET /api/registry (core)

- [ ] `core/src/registry/engines.ts`: map factory (`adb-usb|adb-tcp|screencap-loop|adb-input`) + agregasi descriptor dari `@enkaku/drivers`.
- [ ] `core/src/http/registry.ts`: `GET /api/registry` → `RegistryResponse` (tools dari Toolchain Plan 02); mount di app Hono.
- [ ] Unit test: respons lolos `RegistryResponse.parse`, berisi 4 engine di kind yang benar.
- **Verifikasi:** `curl -s localhost:4700/api/registry | bunx json` menampilkan transports(2)/displays(1)/inputs(1)/inspectors(0)/tools.

### 5.6 DeviceSession factory + SessionManager (core)

- [ ] `core/src/session/session.ts`: `createSession` + fallback chain (§4.7), `inspector: null`.
- [ ] `core/src/session/manager.ts`: acquire/release + refcount, grace 5s, close saat device hilang (subscribe event track-devices Plan 01).
- [ ] Unit test dengan engine mock: acquire dua kali → satu sesi; release ke 0 → display.stop terpanggil setelah grace; engine tak dikenal → `ENGINE_NOT_FOUND`; frameSize ter-update dari meta frame.
- **Verifikasi:** `bun test packages/core` hijau.

### 5.7 WS: stream + input + coordinate mapping (core)

- [ ] `core/src/ws/stream.ts`: handle `stream.start|stop`, alokasi `streamId` per koneksi (0–255, reuse setelah stop), push `encodeVideoFrame`, backpressure skip (`bufferedAmount > 4 MB`), `stream.meta` saat dimensi berubah, auto-release saat WS close.
- [ ] `core/src/ws/input.ts`: handle `input.*` → `mapNormToDevice(pos, session.frameSize)` → InputSink; validasi Zod + `DEVICE_NOT_READY`.
- [ ] Unit test: `mapNormToDevice` (0/1 di-clamp, pembulatan, frame 1080×2400 vs 2400×1080 setelah "rotasi"); handler input dengan session mock (tap 0.5,0.5 pada frame 1080×2400 → `input tap 540 1200`).
- **Verifikasi:** unit hijau; smoke WS manual (lihat §7) mengalirkan frame binary.

### 5.8 Studio: scaffold + WS client + Dashboard

- [ ] Scaffold `packages/studio` (Next.js, App Router, strict TS, `output: 'export'`); script `dev`/`build` di package.json.
- [ ] `src/lib/ws.ts` (§4.9: reconnect, request/reply, subscribe, binary) + `src/lib/binary.ts` (pakai `decodeVideoFrame` dari protocol).
- [ ] `app/page.tsx` + `components/DeviceCard.tsx`: grid device realtime (fetch awal + event WS), badge status, tombol Enroll/Pair.
- [ ] Core: izinkan CORS/origin dev (`localhost:3001`) hanya non-production.
- **Verifikasi:** dua terminal (core + `next dev`), buka `http://localhost:3001` → device tercolok muncul; cabut USB → card jadi offline tanpa refresh; matikan core → reconnect indicator, nyalakan lagi → pulih otomatis.

### 5.9 Studio: Device detail + live view + input

- [ ] `app/device/page.tsx` + `components/LiveView.tsx` (§4.9): stream.start/stop, canvas render (`createImageBitmap`), drop out-of-order via seq, klik→tap, drag→swipe, keyboard→text/key, tombol Back/Home/Recents, indikator fps/dimensi/status.
- [ ] Tangani `stream.meta`: ubah ukuran canvas (aspect ratio) saat rotasi.
- **Verifikasi (device fisik):** buka halaman device → layar HP tampil & bergerak ~2–3 fps; klik ikon kecil di HP (mis. app drawer) → yang tertekan tepat ikon itu; drag → scroll; ketik di kolom pencarian → teks muncul; **rotasi HP** → canvas mengikuti ≤ 2 frame dan klik tetap akurat di orientasi baru.

### 5.10 Enrollment wizard (core + studio)

- [ ] Core: pancarkan `device.unauthorized` dari track-devices (bila belum); `core/src/enroll/pairing.ts` + handler WS `device.pairing.request|code` (§4.10).
- [ ] Studio: `components/EnrollmentWizard.tsx` dua alur (§4.9), terpasang di Dashboard.
- [ ] Unit test pairing dengan mock adb runner (parse output sukses/gagal `adb pair`, timeout, format code divalidasi Zod).
- **Verifikasi (device fisik):** (a) revoke USB debugging authorization di HP → colok → card `unauthorized` + wizard tampil → tap Allow di HP → card jadi idle otomatis; (b) HP Android 11+: aktifkan Wireless debugging → jalankan wizard pairing dengan code 6 digit + connect port → device terdaftar via WiFi dengan stableId sama seperti saat USB (tidak ada record duplikat — validasi spec §7.5).

### 5.11 Serve Studio statis (prod mode) + dokumentasi

- [ ] `core/src/http/studio.ts`: serve `ENKAKU_STUDIO_DIST`/default `packages/studio/out` di `/`, fallback `index.html`, halaman petunjuk bila build tak ada; pastikan `/api/*` & `/ws` tetap diprioritaskan.
- [ ] Tambah script root: `bun run build:studio` lalu jalankan core → satu origin.
- [ ] README `packages/drivers` (engine + trade-off + keterbatasan adb-input) dan README `packages/studio` (mode dev vs prod, env) diperbarui.
- **Verifikasi:** build studio → jalankan HANYA core → buka `http://localhost:4700` → Dashboard & device detail berfungsi penuh (tanpa `next dev`).

## 6. Acceptance criteria

Semua harus lulus:

1. `bun test` hijau di seluruh workspace (tanpa device); `ENKAKU_TEST_DEVICE=1 bun test` hijau dengan ≥ 1 device fisik tercolok.
2. `GET /api/registry` mengembalikan bentuk spec §8 dan lolos `RegistryResponse.parse`, memuat `adb-usb`, `adb-tcp`, `screencap-loop`, `adb-input` + daftar tools.
3. Dari browser (mode prod satu-origin): Dashboard menampilkan device realtime (colok/cabut USB terlihat tanpa refresh).
4. Live view device fisik tampil di canvas dengan ~2–3 fps (ukur: indikator fps di UI menunjukkan ≥ 1,5 fps pada device kelas menengah).
5. Klik pada elemen kecil (ikon ±48 dp) di live view menekan elemen yang benar di device — di orientasi portrait DAN setelah rotasi ke landscape (mapping memakai dimensi frame terbaru).
6. Drag di live view menghasilkan swipe/scroll di device; ketikan ASCII muncul di field teks device; Back/Home/Recents berfungsi.
7. Enrollment USB: device `unauthorized` memunculkan wizard; setelah Allow di HP, device terdaftar otomatis (probe Plan 01) tanpa aksi tambahan.
8. Enrollment wireless: `adb pair` + code 6-digit dari form Studio berhasil, `adb connect` menyusul, device WiFi terdaftar dengan `stableId` sama dengan record USB-nya (tidak duplikat).
9. Format binary frame sesuai §4.8 (dibuktikan unit test roundtrip + smoke decode di Studio); konstanta channel/codec terdefinisi untuk kebutuhan Plan 08.
10. WS client Studio reconnect otomatis setelah core di-restart, dan stream yang sedang aktif dilanjutkan tanpa reload halaman.
11. Tidak ada panggilan `adb kill-server` baru; semua exec adb lewat queue/semaphore Plan 01 dan binary adb dari Toolchain Plan 02.
12. README `packages/drivers` & `packages/studio` terbarui (DoD global #4).

## 7. Test plan

### Unit test (tanpa device — `bun test`)

| Area | File | Cakupan |
|---|---|---|
| Binary framing | `protocol/src/binary.test.ts` | roundtrip encode/decode, channel/codec tak dikenal, buffer pendek |
| Message schema | `protocol/src/messages/*.test.ts` | parse valid/invalid `input.*`, `stream.*`, `device.pairing.*` (code bukan 6 digit ditolak) |
| PNG parser | `drivers/src/display/png.test.ts` | fixture PNG byte-literal, signature korup |
| Screencap loop | `drivers/src/display/screencap-loop.test.ts` | mock transport: frame+seq+meta, stop, retry backoff |
| Escaping | `drivers/src/input/escape.test.ts` | `%s`, quote, `%`, non-ASCII ditolak |
| adb-input | `drivers/src/input/adb-input.test.ts` | perintah shell persis, clamp, validasi keycode |
| Transport | `drivers/src/transport/*.test.ts` | bentuk perintah `-s`, connect/disconnect tcp |
| Mapping | `core/src/ws/input.test.ts` | `mapNormToDevice` clamp/rounding/rotasi; tap → perintah pixel benar |
| Session | `core/src/session/*.test.ts` | refcount, grace close, fallback chain, ENGINE_NOT_FOUND |
| Registry | `core/src/http/registry.test.ts` | bentuk respons §8 |
| Pairing | `core/src/enroll/pairing.test.ts` | mock adb: sukses/gagal/timeout |

### Device test (`ENKAKU_TEST_DEVICE=1`, HP fisik tercolok, di-skip tanpa env)

```bash
ENKAKU_TEST_DEVICE=1 bun test packages/drivers   # screencap-loop.device.test.ts, adb-input.device.test.ts
```

### Smoke test manual berskrip (device fisik)

```bash
# 1. Prod mode satu-origin
bun run --cwd packages/studio build
bun run --cwd packages/core start          # asumsi port 4700 (samakan dengan Plan 01)
open http://localhost:4700

# 2. Registry
curl -s http://localhost:4700/api/registry | bunx json

# 3. Alur UI (checklist manual):
#    [ ] Dashboard: device muncul; cabut-colok USB → status berubah realtime
#    [ ] Device detail: live view jalan; klik ikon kecil tepat sasaran
#    [ ] Rotasi HP → canvas & klik tetap benar
#    [ ] Ketik "hello world 123" di field pencarian device → muncul benar (spasi ok)
#    [ ] Restart core → Studio reconnect + stream lanjut
# 4. Enrollment USB: Developer options → Revoke USB debugging authorizations → cabut-colok
#    [ ] wizard muncul → Allow di HP → device idle otomatis
# 5. Enrollment wireless (Android 11+): Wireless debugging → Pair with code
#    [ ] isi host/pair-port/code + connect-port di wizard → device WiFi terdaftar, stableId tidak duplikat
```

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| `screencap` lambat/bervariasi antar device (0,3–1,5 s) | fps di bawah target ~2–3 | Interval adaptif (loop serial by design); dokumentasikan sebagai batas MVP; jalur nyata = scrcpy Plan 08 |
| Frame PNG besar (layar 1440p bisa > 3 MB) membanjiri WS | UI lag, memory naik | Backpressure skip frame (`bufferedAmount > 4 MB`); hanya frame terbaru yang dikirim; open question soal downscale |
| Klik meleset saat rotasi (race: tap dikirim sebelum frame orientasi baru sampai) | salah tekan sesaat | Mapping selalu pakai `frameSize` terbaru di core (bukan milik client); jendela race maks 1 frame ~0,4 s — diterima untuk MVP, hilang di Plan 08 (scrcpy kirim orientasi eksplisit) |
| `input text` gagal untuk unicode/karakter aneh | UX ketik terbatas | Tolak dini dengan error jelas di UI ("hanya ASCII di mode fallback"); solusi penuh Plan 06 (`set_text`) & Plan 08 |
| `adb pair` berbeda perilaku antar vendor / pairing port berubah cepat (layar HP timeout) | wizard gagal misterius | Teruskan stderr/stdout adb apa adanya ke wizard; instruksi "biarkan layar pairing tetap terbuka"; timeout 20s dengan pesan retry |
| Desain channel prefix ternyata kurang untuk scrcpy (butuh field tambahan) | breaking change Plan 08 | Prefix hanya 2 byte tetap (channel+streamId); semua evolusi ada di payload per-codec; Plan 08 review desain ini SEBELUM implementasi |
| Static export Next.js membatasi route dinamis | halaman device pakai query param | Diterima & didokumentasikan; revisit di Plan 07/09 |
| Loop screencap menahan perintah input di per-device queue | input terasa lambat | Ukur dulu: satu screencap ≈ ratusan ms; bila mengganggu, prioritas queue (input di depan capture) — catat sebagai tuning, jangan bypass queue |

## 9. Open questions

1. **Lokasi kanonik interface driver**: plan ini menaruh `Transport/DisplaySource/InputSink/Inspector` di `packages/protocol/src/driver.ts`. Jika Plan 01 sudah menetapkan lokasi lain (mis. di `packages/adb` atau package terpisah), mana yang jadi kanonik? (Jangan sampai dua definisi.)
2. **Nama & arah message pairing**: spec §13 menyebut `device.pairing.request` dan `device.pairing.code` tanpa mendefinisikan arah/payload. Plan ini menginterpretasikan keduanya sebagai studio→core (request = mulai, code = submit 6-digit + connectPort). Konfirmasi manusia diperlukan bila interpretasi lain (mis. `code` = event core→studio).
3. **Connect port wireless**: haruskah Studio meminta user mengetik connect port manual (pilihan plan ini), atau core mencoba auto-discover via mDNS (`adb mdns services`)? mDNS scan ada di prior-art ws-scrcpy-web (spec §6.2) tapi tidak eksplisit diminta spec — butuh keputusan sebelum dianggap scope.
4. **Downscale frame screencap**: bolehkah core mengecilkan PNG (mis. lebar maks 720 px) demi bandwidth, dengan konsekuensi butuh decoder/encoder image di core? Plan ini TIDAK melakukannya (kirim PNG asli); keputusan kalau ternyata WS kewalahan di device 1440p.
5. **Thumbnail live di Dashboard**: spec §19 menandai "thumbnail live opsional". Di-skip di M2; masuk Plan 07 atau dibuang?
6. **Interval default screencap**: 400 ms (~2,5 fps) dipilih di tengah rentang "~2–3 fps" spec §7.1. Perlukah bisa diubah per-device sebelum ada schema-driven config (Plan 07), atau cukup konstanta?
7. **Reject input saat status selain `idle`**: Plan 04 yang memformalkan `manual|busy`. Di M2, apakah input boleh dikirim saat dua tab/viewer membuka device yang sama (keduanya bisa klik)? Plan ini membiarkannya (single-user local), tapi perlu ditegaskan sebelum Plan 04.
