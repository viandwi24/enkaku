# Plan 08 — M6 : scrcpy Display + UHID Input + WebCodecs

> Status: implemented — `@enkaku/scrcpy` protocol client (server launch, video demux, UHID/SDK control, clipboard) shipped
> Ships: packages/scrcpy/src/session.ts
> **Depends on:** Plan 01–07 (semua acceptance criteria lulus). Secara khusus: `screencap-loop` + `adb-input` sudah jalan sebagai fallback (Plan 03), lease/busy enforcement sudah ada (Plan 04), `scrcpy-server.jar` sudah di-manage Toolchain Manager dengan `swappable: false` (Plan 02), format binary channel-prefix WS sudah didesain (Plan 03), registry + capability locks + schema-driven form sudah ada (Plan 07).
> **Referensi spec:** §20 baris M6, §4 (catatan arsitektur vanilla scrcpy-server), §6.2 (pelajaran ws-scrcpy), §7.6 (versi-lock scrcpy-server), §9 (input injection modes, §9.5 capability locks), §13 (protokol video), §16 NFR (glass-to-glass < 150 ms LAN, ≥ 24 fps), §12 (`devices.apiLevel`, `DeviceSettings.input.preferredMode`).

---

## 1. Goals

Setelah plan ini selesai, semua pernyataan berikut TRUE dan terukur:

- `packages/scrcpy` (`@enkaku/scrcpy`) ada dan berfungsi sebagai **protocol client scrcpy sisi host**: push jar → tunnel adb → spawn `app_process` → terima socket video+control → parse metadata → demux frame H.264 → emit ke pipeline. Package ini **versi-locked**: konstanta `SCRCPY_VERSION` satu-satunya sumber versi, dan manifest tool `scrcpy-server` memakai `compatibleCoreRange` (Plan 02) sehingga jar yang aktif selalu versi yang sama dengan yang client ini ditulis untuknya.
- Engine `DisplaySource` baru `scrcpy` terdaftar di `packages/drivers` dan menjadi **default** kolom `devices.display` (spec §12 sudah men-default `'scrcpy'`); `screencap-loop` tetap terdaftar dan bisa dipilih sebagai fallback dari Studio.
- Engine `InputSink` baru `scrcpy-uhid` (default, spec §9) dan `scrcpy-sdk` (fallback) terdaftar; pemilihan mode runtime mengikuti `DeviceSettings.input.preferredMode` + gating `devices.apiLevel`; `adb-input` tetap tersedia sebagai fallback terakhir.
- Capability locks aktif: `scrcpyDisplay.locks = ['video-encoder']`, `scrcpyUhidInput.locks = ['input-injection']`, `scrcpySdkInput.locks = ['input-injection']` (spec §9.5) — session manager menolak kombinasi yang tabrakan.
- Studio men-decode H.264 via WebCodecs `VideoDecoder` (Chromium) dan me-render ke `<canvas>`; browser non-Chromium jatuh ke fallback decoder (TinyH264 wasm, lihat §3.6).
- Satu WS per device-view session; video dikirim sebagai binary message ber-channel-prefix (format Plan 03); input manual tetap JSON envelope (`input.tap` dst) dan tetap di-reject core saat device `busy` (Plan 04) sementara video terus jalan.
- Lifecycle benar: device disconnect → proses server di device bersih; rotasi layar → decoder re-init + coordinate mapping ter-update; reconnect otomatis mengikuti `DeviceSettings.autoReconnect`.
- **NFR terverifikasi dengan prosedur terdokumentasi** (§7.3): glass-to-glass < 150 ms di LAN, ≥ 24 fps saat konten bergerak (spec §16).
- Kebijakan **single-viewer per device** ter-enforce (viewer kedua ditolak dengan error code jelas); multi-viewer masuk Open questions (§9).

## 2. Non-goals

Sengaja TIDAK dikerjakan di plan ini:

- **Audio forwarding.** scrcpy mendukung audio socket, tapi M6 menjalankan server dengan `audio=false`. Audio tidak ada di spec §20 M6; kalau nanti dibutuhkan, jadi plan tersendiri (dicatat di Open questions).
- **`scrcpy-aoa` (OTG/HID fisik)** — Plan 11 (M8), spec §20.
- **WebRTC / transport cloud** — Plan 11 (M8), spec §5.3. Plan ini LAN-only: WS + WebCodecs.
- **Video recording per-session sebagai artifact** — spec §22 (future), bukan M6.
- **H.265/AV1.** M6 = H.264 saja (paling luas dukungan WebCodecs + fallback decoder). Codec lain dicatat di Open questions.
- **Multi-viewer satu device** — lihat §3.7 dan Open questions.
- **Fork/patch scrcpy-server.** Dilarang oleh spec §7.6 + overview §3: vanilla jar resmi Genymobile, titik.

## 3. Konteks & keputusan desain

### 3.1 Mazhab vanilla scrcpy-server (spec §4, §6.2)

Kita memakai `.jar` resmi Genymobile apa adanya (sudah di-download + sha256-verified oleh Toolchain Manager sejak Plan 02). Konsekuensi: **seluruh kompleksitas protokol ada di sisi kita** — `@enkaku/scrcpy` harus bicara protokol internal scrcpy dengan benar. Pola ini terbukti di ws-scrcpy-web (spec §6.2): host me-multiplex socket TCP scrcpy jadi satu WebSocket ber-prefix channel, browser demux + decode WebCodecs.

### 3.2 Versi-lock adalah aturan nomor satu (spec §7.6)

Protokol scrcpy **internal dan berubah antar versi tanpa kompatibilitas**. Karena itu:

- Implementasi ditulis terhadap **SATU versi scrcpy-server yang di-pin**, dinyatakan sebagai konstanta `SCRCPY_VERSION` di `packages/scrcpy/src/version.ts`. Versi yang dipilih untuk M6: **`3.1`** (rilis stabil dengan UHID keyboard+mouse; keputusan final versi minor dikonfirmasi di langkah 5.1).
- Manifest tool `scrcpy-server` (Plan 02) untuk versi tsb memakai `compatibleCoreRange` yang mencakup versi core rilis M6; `swappable: false` sudah berlaku — UI Tools menampilkan "managed by core".
- **Semua detail bit-level protokol di dokumen ini adalah desain kerja yang WAJIB diverifikasi terhadap source code rilis scrcpy versi yang di-pin saat implementasi** (repo `Genymobile/scrcpy`, tag `v<SCRCPY_VERSION>`, file `app/src/server.c`, `app/src/demuxer.c`, `app/src/control_msg.c`, dan sisi Java `server/src/main/java/com/genymobile/scrcpy/`). Titik-titik yang harus dicek ditandai **`TODO-verify`** di §4. Dilarang mengarang layout byte: kalau source berbeda dari dokumen ini, source menang dan dokumen ini di-update.
- Naik versi scrcpy di masa depan = ubah `SCRCPY_VERSION`, jalankan ulang seluruh test §7 (termasuk fixture regen), rilis bareng core baru. Bukan operasi user.

### 3.3 Alur start server (desain, verifikasi di implementasi)

1. Resolve path jar dari Toolchain Manager (bukan PATH sistem — overview §3).
2. `adb -s <serial> push <jar> /data/local/tmp/scrcpy-server.jar` (lewat per-device queue Plan 01).
3. **Tunnel: pakai `adb forward`** (bukan reverse): `adb forward tcp:<port> localabstract:scrcpy_<scid>` dengan opsi server `tunnel_forward=true`. Alasan: core yang connect (retry-able, deterministik, tidak perlu listener host per device); ws-scrcpy memakai pola serupa. `scid` = random 31-bit hex per session → nama socket unik, memungkinkan restart bersih. `<port>` dialokasikan dari pool port core (mis. 27100–27299) dengan pencatatan agar tidak bentrok antar device.
4. Spawn server di device:
   ```
   adb -s <serial> shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
     app_process / com.genymobile.scrcpy.Server <SCRCPY_VERSION> \
     scid=<scid> log_level=info video=true audio=false control=true \
     video_codec=h264 max_size=<cfg> video_bit_rate=<cfg> max_fps=<cfg> \
     tunnel_forward=true send_device_meta=true send_frame_meta=true \
     send_codec_meta=true cleanup=true
   ```
   Argumen pertama **harus persis** `SCRCPY_VERSION` — server abort kalau mismatch (ini fitur, bukan bug: fail-fast saat jar & client tidak sinkron). Daftar key=value valid **`TODO-verify`** terhadap `Options.java` versi pinned.
5. Core connect TCP ke `localhost:<port>` berurutan: socket **video** dulu, lalu socket **control** (audio dinonaktifkan sehingga tidak ada socket audio — urutan & keberadaan dummy byte `TODO-verify`). Pada mode `tunnel_forward`, socket pertama mengirim **1 dummy byte** untuk deteksi koneksi — harus dibaca & dibuang.
6. Baca metadata (lihat §4.3), lalu loop demux frame.
7. Teardown: close semua socket (server scrcpy exit sendiri saat socket tutup + `cleanup=true` memulihkan setting device), `adb forward --remove tcp:<port>`, lepas port ke pool.

### 3.4 Format video di kabel: Annex-B passthrough

Output MediaCodec yang dikirim scrcpy adalah **H.264 Annex-B** (start code `00 00 00 01`), dengan **config packet** terpisah berisi SPS+PPS (ditandai flag config di header frame). Keputusan M6: **passthrough Annex-B, tanpa transmux ke AVCC**.

- WebCodecs `VideoDecoder`: konfigurasi **tanpa `description`** = mode Annex-B; SPS/PPS harus in-band. Core menjamin ini dengan mengirim config packet sebagai chunk tersendiri sebelum keyframe pertama (dan Studio mem-prepend config ke keyframe pertama bila decoder menuntut — lihat snippet §4.6).
- Keuntungan: zero repackaging di core (relay murni = CPU rendah, sesuai spec §16 "10 device di N100"), fallback TinyH264 juga makan Annex-B langsung.
- Konsekuensi: `codec` string untuk `VideoDecoder.configure` (mis. `'avc1.42C028'`) diturunkan dari parsing 3 byte profile/compat/level di SPS config packet (parser kecil, lihat §4.6).

### 3.5 Multiplex ke browser (format Plan 03)

Satu WS per device-view session (endpoint `/ws/device/:deviceId/view`, autentikasi mengikuti mekanisme session Plan 04/07). Message **binary** memakai channel-prefix 1 byte (desain Plan 03); message **JSON envelope** untuk kontrol/meta. Detail framing di §4.5.

### 3.6 Decoder di Studio: WebCodecs utama, TinyH264 fallback minimum

- **Utama:** WebCodecs `VideoDecoder` (Chromium — Chrome/Edge/Arc/Brave). Hardware-accelerated, latency terendah, jalur yang divalidasi ws-scrcpy-web (spec §6.2).
- **Fallback minimum: TinyH264 (wasm, software).** Trade-off vs MSE:
  - TinyH264: sederhana (makan Annex-B langsung, tanpa remux), deterministik, tidak butuh container; TAPI software decode (CPU browser tinggi), praktis hanya baseline profile & resolusi menengah.
  - MSE: hardware decode & profile luas; TAPI butuh remux Annex-B → fragmented MP4 di client (kompleks, latency buffer MSE lebih tinggi, rawan quirks antar browser).
  - Keputusan M6: **TinyH264** sebagai fallback minimum karena effort terkecil dan cukup untuk "bisa dipakai di Firefox/Safari"; saat fallback aktif, core diminta menurunkan `max_size` (mis. 1024) via restart stream. Prioritas upgrade fallback ke MSE → Open questions.
  - Konsekuensi config: untuk kompatibilitas fallback, opsi server menyertakan `video_codec_options` yang meminta baseline profile bila viewer fallback (`TODO-verify` nama & format opsi di versi pinned; kalau tidak tersedia, fallback menerima profile apapun dan kita terima risiko — catat hasil verifikasi).
- Deteksi: `('VideoDecoder' in window)` + `VideoDecoder.isConfigSupported(...)` saat config frame tiba; gagal → fallback path.

### 3.7 Late-joiner & kebijakan single-viewer

scrcpy mengirim config (SPS/PPS) + keyframe **di awal koneksi socket**; keyframe berikutnya hanya pada interval IDR encoder (bisa jarang). Viewer yang join di tengah stream tidak bisa decode sampai dapat config + keyframe. Opsi:

1. **Restart stream** per join → semua viewer re-init; mahal tapi selalu benar.
2. **Cache config packet terakhir + tunggu keyframe berikutnya** → join delay tak terbatas kalau IDR jarang.
3. **Minta keyframe via control message reset-video** → ideal, tapi keberadaan & semantik message ini di versi pinned harus `TODO-verify`.

Keputusan M6: **kebijakan single-viewer per device** — koneksi view kedua ditolak (`{ error: { code: 'display_busy' } }`) selama viewer pertama aktif. Stream scrcpy di-start saat viewer pertama connect (config+keyframe fresh dari server, tidak ada masalah late-join), di-stop saat viewer disconnect + grace 10 detik (biar refresh browser tidak restart encoder). Core **tetap meng-cache config packet terakhir** (murah, dibutuhkan untuk re-init decoder saat rotasi & menyiapkan jalan ke multi-viewer). Multi-viewer + pilihan opsi 1/2/3 → Open questions.

### 3.8 Input: UHID default, SDK fallback, adb-input terakhir (spec §9)

- **`scrcpy-uhid`**: kirim control message `UHID_CREATE` (registrasi virtual HID device via kernel UHID) lalu `UHID_INPUT` (HID report) — dari sisi Android tampak sebagai input hardware betulan. Dua device HID dibuat per session: **keyboard** (boot keyboard descriptor standar) dan **pointer absolut** (digitizer/touchscreen descriptor buatan kita dengan sumbu X/Y absolut logical 0..32767) — karena mouse UHID bawaan scrcpy bersifat *relatif* (delta), sedangkan farm butuh "tap di (x,y)". `UHID_CREATE` menerima report descriptor arbitrer sehingga descriptor absolut ini sah secara protokol; dukungan aktual di kernel/ROM device di-verify di e2e (`TODO-verify` + risiko §8).
- **`scrcpy-sdk`**: control message inject touch/key (InputManager) — kompatibilitas paling luas, tapi terdeteksi sebagai injeksi (spec §9.1).
- **Seleksi mode runtime** (di factory session, `packages/drivers`):
  1. Baca `DeviceSettings.input.preferredMode` (`'uhid' | 'sdk' | 'aoa'`; `'aoa'` belum ada → degrade ke urutan bawah + warning log).
  2. Gating: `uhid` hanya bila `devices.apiLevel >= UHID_MIN_API` (konstanta di `packages/scrcpy`; nilai awal 29, **`TODO-verify`** terhadap batasan UHID scrcpy versi pinned — kalau source/dok upstream menyebut batas lain, ikuti itu).
  3. Kalau engine scrcpy input gagal init (mis. `UHID_CREATE` gagal) → auto-degrade `uhid → sdk → adb-input`, tercatat di log + status session (Studio menampilkan mode aktif).
- **`text()` di mode uhid**: HID keyboard = keycode (layout-dependent, non-ASCII bermasalah). Keputusan pragmatis M6: `key()` memakai UHID; `text()` memakai control message inject-text (jalur SDK) meski mode uhid — trade-off realism vs correctness dicatat di Open questions.

### 3.9 Interaksi dengan lease/busy (sudah dari Plan 04)

Tidak ada aturan baru: core sudah menolak `input.*` saat device `busy`. Plan ini hanya memastikan **display relay tidak tergantung lease** — video jalan terus saat automation berlangsung (spec §10.1), dan InputSink scrcpy dipakai juga oleh script runner lewat `DeviceSession` yang sama (lock `input-injection` mencegah dua engine input hidup bersamaan).

## 4. Desain teknis

### 4.1 Struktur file

```
packages/scrcpy/
  package.json                      # @enkaku/scrcpy, private
  src/
    version.ts                      # SCRCPY_VERSION, UHID_MIN_API, konstanta protokol
    options.ts                      # Zod schema opsi server + builder argumen key=value
    server.ts                       # ScrcpyServerProcess: push jar, forward, spawn, teardown
    connection.ts                   # ScrcpyConnection: connect socket video+control, handshake meta
    demuxer.ts                      # stream parser: metadata + frame header + packet
    control/
      writer.ts                     # ControlWriter: serialize control message → socket
      messages.ts                   # tipe + encoder tiap control message (inject touch/key/text, UHID)
    hid/
      keyboard.ts                   # descriptor + report builder keyboard
      pointer.ts                    # descriptor + report builder pointer absolut (digitizer)
    sps.ts                          # parser minimal SPS: profile/level (codec string) + width/height
    index.ts                        # API publik package
    *.test.ts                       # unit test colocated (fixture di src/__fixtures__/)
packages/drivers/src/
  display/scrcpy.ts                 # DisplaySource 'scrcpy' (locks: ['video-encoder'])
  input/scrcpy-uhid.ts              # InputSink 'scrcpy-uhid' (locks: ['input-injection'])
  input/scrcpy-sdk.ts               # InputSink 'scrcpy-sdk'  (locks: ['input-injection'])
  input/select.ts                   # resolusi preferredMode + apiLevel gating + degrade chain
packages/core/src/
  display/relay.ts                  # DisplayRelay: DisplaySource → WS binary channel, cache config,
                                    #   single-viewer policy, backpressure drop-to-keyframe
  ws/device-view.ts                 # endpoint /ws/device/:id/view (upgrade + auth + wiring relay)
packages/protocol/src/
  messages/display.ts               # display.configure / display.stats / display.error (Zod)
  binary/channels.ts                # konstanta channel & header binary (shared core+studio, dari Plan 03)
packages/studio/src/features/device-view/
  stream.ts                         # WS client: demux channel, feed decoder
  decoder-webcodecs.ts              # VideoDecoder wrapper (init dari config frame, re-init rotasi)
  decoder-tinyh264.ts               # fallback wasm
  renderer.ts                       # canvas render + resize/rotasi
  input-capture.ts                  # pointer/keyboard event → input.* JSON (mapping koordinat)
  stats-overlay.tsx                 # debug panel: fps, decode queue, bitrate, resolusi
```

### 4.2 API publik `@enkaku/scrcpy`

```ts
// packages/scrcpy/src/index.ts
export const SCRCPY_VERSION = '3.1'          // satu-satunya sumber versi (§3.2)

export interface ScrcpySessionOptions {
  serial: string
  jarPath: string                            // dari Toolchain Manager
  port: number                               // dari pool core
  maxSize?: number                           // default 1600
  bitRate?: number                           // default 4_000_000
  maxFps?: number                            // default 30 (encoder cap; NFR minimal 24)
}

export interface ScrcpyVideoMeta {
  deviceName: string
  codec: 'h264'
  width: number
  height: number
}

export type ScrcpyPacket =
  | { kind: 'config';   data: Uint8Array }                       // SPS/PPS
  | { kind: 'keyframe'; ptsUs: bigint; data: Uint8Array }
  | { kind: 'frame';    ptsUs: bigint; data: Uint8Array }

export interface ScrcpySession {
  readonly meta: ScrcpyVideoMeta
  onPacket(cb: (p: ScrcpyPacket) => void): void
  onMetaChange(cb: (m: ScrcpyVideoMeta) => void): void           // rotasi (lihat §4.7)
  onClose(cb: (reason: string) => void): void
  control: ScrcpyControl
  close(): Promise<void>
}

export interface ScrcpyControl {
  injectTouch(action: 'down'|'up'|'move', x: number, y: number, w: number, h: number): void
  injectKeycode(action: 'down'|'up', keycode: number, meta: number): void
  injectText(text: string): void
  uhidCreate(id: number, name: string, reportDesc: Uint8Array): void
  uhidInput(id: number, report: Uint8Array): void
}

export function startScrcpySession(opts: ScrcpySessionOptions, adb: AdbExecutor): Promise<ScrcpySession>
```

`AdbExecutor` = interface tipis dari `@enkaku/adb` (exec lewat per-device queue Plan 01) supaya `@enkaku/scrcpy` tidak tergantung core.

### 4.3 Diagram alur socket (device → core → browser)

```
 Device (Android)                     Core (Bun)                            Browser (Studio)
┌───────────────────────┐            ┌────────────────────────────┐        ┌────────────────────────┐
│ scrcpy-server.jar     │            │ @enkaku/scrcpy             │        │ device-view            │
│ (app_process, pinned) │            │  ScrcpyConnection          │        │                        │
│                       │  adb fwd   │   ├─ video socket ─┐       │  WS    │  demux channel-prefix  │
│ MediaCodec ── H.264 ──┼──────────► │   │  [dummy][meta] │       │ /ws/   │   ch 0x01 ─► decoder   │
│               Annex-B │ localabstr │   │  [frame]...    ▼       │ device │   (WebCodecs |         │
│                       │ scrcpy_<sc>│   │            Demuxer     │ /:id/  │    TinyH264 fallback)  │
│ /dev/uhid ◄─ UHID ────┼──────────┐ │   │               │        │ /view  │        │               │
│ InputManager ◄─ SDK ──┼────────┐ │ │   │        DisplayRelay ───┼──────► │   canvas render        │
└───────────────────────┘        │ │ │   │  (cache config,        │ binary │                        │
                                 │ │ │   │   single-viewer,       │        │  pointer/keyboard      │
                                 │ └─┼── │   backpressure)        │ ◄──────┼── input.tap/swipe/...  │
                                 └───┼── │  ControlWriter ◄── InputSink    │  (JSON envelope)       │
                                     │   │        ▲ (reject saat busy —    │                        │
                                     │   │          lease, Plan 04)        │                        │
                                     │   └────────────────────────┘        └────────────────────────┘
                                     └── control socket (arah host→device)
```

**Handshake video socket** (mode `tunnel_forward`, urutan `TODO-verify` §3.2):

```
[1 byte  dummy]                        ← hanya socket pertama
[64 byte device name, UTF-8 + NUL pad] ← karena send_device_meta=true
[4 byte  codec id (u32 BE)]            ← karena send_codec_meta=true
[4 byte  width  (u32 BE)]
[4 byte  height (u32 BE)]
kemudian berulang:
[8 byte  ptsAndFlags (u64 BE)]         ← karena send_frame_meta=true
[4 byte  packetSize  (u32 BE)]
[packetSize byte payload H.264 Annex-B]
```

Flag di `ptsAndFlags` (**`TODO-verify`** nilai bit terhadap `demuxer.c`/`Streamer.java` versi pinned):
`PACKET_FLAG_CONFIG = 1n << 63n`, `PACKET_FLAG_KEY_FRAME = 1n << 62n`, sisanya PTS mikrodetik.

### 4.4 Demuxer — parser incremental (snippet inti)

Parser harus tahan terhadap chunk TCP terpotong di posisi manapun (stateful, buffer akumulatif):

```ts
// packages/scrcpy/src/demuxer.ts
const PACKET_FLAG_CONFIG    = 1n << 63n   // TODO-verify vs source pinned
const PACKET_FLAG_KEY_FRAME = 1n << 62n
const PTS_MASK              = (1n << 62n) - 1n

export class FrameDemuxer {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array, emit: (p: ScrcpyPacket) => void): void {
    this.buf = concat(this.buf, chunk)
    for (;;) {
      if (this.buf.length < 12) return                     // header belum lengkap
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset)
      const ptsAndFlags = dv.getBigUint64(0)
      const size = dv.getUint32(8)
      if (this.buf.length < 12 + size) return              // payload belum lengkap
      const data = this.buf.slice(12, 12 + size)
      this.buf = this.buf.slice(12 + size)
      if (ptsAndFlags & PACKET_FLAG_CONFIG) {
        emit({ kind: 'config', data })
      } else {
        const ptsUs = ptsAndFlags & PTS_MASK
        emit(ptsAndFlags & PACKET_FLAG_KEY_FRAME
          ? { kind: 'keyframe', ptsUs, data }
          : { kind: 'frame', ptsUs, data })
      }
    }
  }
}
```

### 4.5 Format WS ke browser (mengikuti channel-prefix Plan 03)

Binary message (ArrayBuffer) di `/ws/device/:id/view`:

```ts
// packages/protocol/src/binary/channels.ts
export const CH_VIDEO = 0x01                 // channel lain reserved (Plan 03/11)

// Layout binary message video (core → browser):
// [0]      u8   channel = CH_VIDEO
// [1]      u8   flags: bit0=config, bit1=keyframe
// [2..9]   u64  BE  ptsUs (0 untuk config)
// [10..]   payload H.264 Annex-B
export function encodeVideoMessage(p: ScrcpyPacket): Uint8Array { /* ... */ }
export function decodeVideoMessage(buf: ArrayBuffer): DecodedVideo { /* ... */ }
```

JSON envelope (format overview §4.3, schema di `packages/protocol/src/messages/display.ts`):

- `display.configure` `{ deviceId, codec: 'h264', width, height, codecString }` — dikirim saat stream mulai **dan setiap rotasi/resize**; `codecString` (mis. `'avc1.42C028'`) dihitung core dari config packet via `sps.ts`.
- `display.stats` (opsional, tiap 2 s): `{ fpsEncoder?, bytesPerSec }` untuk overlay debug.
- `display.error` `{ code: 'display_busy' | 'engine_failed' | ... , message }`.
- Arah browser→core tetap `input.tap` / `input.swipe` / `input.key` / `input.text` (schema Plan 03, tidak berubah — core yang menerjemahkan ke UHID/SDK).

**Backpressure di DisplayRelay:** kalau `ws.getBufferedAmount()` > threshold (mis. 1 MB), relay **drop frame non-config sampai keyframe berikutnya** (drop parsial di tengah GOP menghasilkan artefak; drop harus mulai lagi dari keyframe). Config packet tidak pernah di-drop.

### 4.6 Studio — WebCodecs decoder (snippet inti)

```ts
// packages/studio/src/features/device-view/decoder-webcodecs.ts
export class WebCodecsH264Decoder {
  private decoder: VideoDecoder | null = null
  private config: Uint8Array | null = null       // SPS/PPS terakhir
  private awaitingKeyframe = true

  constructor(private onFrame: (f: VideoFrame) => void,
              private onFatal: (e: Error) => void) {}

  async configure(codecString: string): Promise<boolean> {
    const support = await VideoDecoder.isConfigSupported({
      codec: codecString, optimizeForLatency: true })   // tanpa description = Annex-B in-band
    if (!support.supported) return false
    this.decoder?.close()
    this.decoder = new VideoDecoder({
      output: (f) => this.onFrame(f),
      error: (e) => this.onFatal(e as Error),
    })
    this.decoder.configure({ codec: codecString, optimizeForLatency: true })
    this.awaitingKeyframe = true
    return true
  }

  push(msg: DecodedVideo): void {
    if (msg.isConfig) { this.config = msg.payload; return }   // simpan, prepend ke keyframe
    if (this.awaitingKeyframe && !msg.isKeyframe) return       // buang delta sebelum IDR pertama
    if (!this.decoder || this.decoder.state !== 'configured') return
    let data = msg.payload
    if (msg.isKeyframe && this.config) data = concat(this.config, data)  // SPS/PPS in-band
    this.decoder.decode(new EncodedVideoChunk({
      type: msg.isKeyframe ? 'key' : 'delta',
      timestamp: Number(msg.ptsUs),
      data,
    }))
    if (msg.isKeyframe) this.awaitingKeyframe = false
  }

  reset(): void { this.awaitingKeyframe = true; this.decoder?.reset?.() }
}
```

Alur di `stream.ts`: terima `display.configure` → pilih decoder (WebCodecs support? kalau tidak → TinyH264) → `configure(codecString)` → binary message ch `0x01` di-decode → `push()`. Rotasi = `display.configure` baru → `configure()` ulang + resize canvas + update mapping input.

### 4.7 Rotasi layar

Saat device rotasi, encoder scrcpy restart internal dan mengirim **config packet baru** (SPS dengan dimensi baru). Mekanisme persis (config baru saja vs metadata tambahan) **`TODO-verify`** di versi pinned. Desain core:

1. Demuxer emit `config` → `sps.ts` parse width/height/profile.
2. Jika dimensi berubah dari meta aktif → `ScrcpySession.onMetaChange` → core kirim `display.configure` baru + update cache `screenW/screenH` runtime session (koordinat input dinormalisasi terhadap dimensi ini).
3. Config packet tetap diteruskan di channel video (browser prepend ke keyframe berikutnya) — decoder re-configure di sisi Studio saat `display.configure` diterima.
4. InputSink uhid: laporan pointer memakai koordinat ternormalisasi 0..32767 terhadap dimensi **saat ini** → mapping otomatis benar setelah langkah 2.

### 4.8 Control message & UHID (layout `TODO-verify` seluruhnya vs `control_msg.c`/`ControlMessageReader.java` pinned)

```ts
// packages/scrcpy/src/control/messages.ts — nilai tipe TODO-verify
export const enum ControlMsgType {
  INJECT_KEYCODE = 0, INJECT_TEXT = 1, INJECT_TOUCH_EVENT = 2,
  /* ... */ UHID_CREATE = 12, UHID_INPUT = 13, /* ... */
}
// INJECT_TOUCH_EVENT: [u8 type][u8 action][u64 pointerId][i32 x][i32 y]
//                     [u16 screenW][u16 screenH][u16 pressure][u32 actionButton][u32 buttons]
// UHID_CREATE       : [u8 type][u16 id][u16? vendor][u16? product][name?][u16 descSize][desc]
// UHID_INPUT        : [u8 type][u16 id][u16 size][data]
```

HID design (`packages/scrcpy/src/hid/`):

- `keyboard.ts`: boot keyboard descriptor standar (8-byte report: modifier, reserved, 6 keycode). Mapping `KeyCode` SDK → HID usage id (tabel statis untuk keycode umum; yang tak terpetakan → degrade ke `injectKeycode` SDK + debug log).
- `pointer.ts`: descriptor digitizer absolut — Usage Page Digitizer/Touch, X/Y logical 0..32767, tip switch. Report `tap(p)`: down di `(x*32767/w, y*32767/h)` → up. `swipe`: down → N step move terinterpolasi (interval dari durasi) → up. Timing jitter TIDAK di sini — jitter tetap tanggung jawab lapisan atas (`DeviceSettings.timing`, sudah dipakai runner sejak Plan 05).

### 4.9 Registrasi engine & registry (Plan 07)

```ts
// packages/drivers/src/display/scrcpy.ts
export const scrcpyDisplay = defineDisplaySource({
  id: 'scrcpy',
  displayName: 'scrcpy (H.264, low-latency)',
  locks: ['video-encoder'],                      // spec §9.5
  configSchema: z.object({
    maxSize: z.number().int().min(480).max(2560).default(1600),
    bitRateMbps: z.number().min(0.5).max(16).default(4),
    maxFps: z.number().int().min(15).max(60).default(30),
  }),
  create: (ctx) => new ScrcpyDisplaySource(ctx),
})
```

`screencap-loop` tidak dihapus; default kolom `devices.display` = `'scrcpy'` (sudah begitu di schema spec §12 — pastikan record lama yang manual di-set `screencap-loop` tidak dimigrasi paksa). Registry `/api/registry` otomatis memuat engine baru (schema-driven, Plan 07) → dropdown Studio langsung menampilkan tanpa UI baru.

### 4.10 Lifecycle & resiliency

| Kejadian | Perilaku |
|---|---|
| Viewer pertama connect | DisplayRelay start `ScrcpySession` (kalau belum hidup untuk automation-view). |
| Viewer disconnect | Grace 10 s → stop session (kecuali dipakai pihak lain). |
| Viewer kedua connect | Ditolak `display_busy` (§3.7). |
| Device `busy` (job) | Video terus; `input.*` di-reject core (Plan 04, tak berubah). |
| Device disconnect (track-devices) | Teardown: close sockets (server exit sendiri), `adb forward --remove`, release port; kalau device masih reachable tapi session zombie → best-effort kill via socket close saja (JANGAN `adb kill-server`, overview §3). |
| Device reconnect + `autoReconnect` | Kalau ada viewer WS yang masih hidup menunggu → auto-restart session, kirim `display.configure` baru; viewer re-init decoder. |
| Socket scrcpy putus mendadak | Relay kirim `display.error {code:'engine_failed'}`; retry start 1× dengan scid baru; gagal lagi → biarkan viewer memilih fallback `screencap-loop` dari Studio. |
| Rotasi | §4.7. |
| Toolchain swap adb | Sudah diatur Plan 02 (drain session dulu) — display session termasuk yang di-drain. |

## 5. Langkah implementasi

### Tahap 5.1 — Pin versi & verifikasi protokol (gerbang wajib sebelum koding)

- [ ] Tetapkan versi final `SCRCPY_VERSION` (kandidat `3.1`); pastikan Toolchain manifest `scrcpy-server` (Plan 02) punya entri versi ini dengan sha256 dari rilis resmi GitHub Genymobile + `compatibleCoreRange` menunjuk versi core M6.
- [ ] Checkout/baca source `Genymobile/scrcpy` tag `v<SCRCPY_VERSION>`; verifikasi SEMUA titik `TODO-verify` §3–§4: format argumen server & daftar opsi, urutan socket + dummy byte, layout metadata (device name/codec/width/height), bit flag frame header, tipe & layout semua control message yang dipakai (inject touch/keycode/text, UHID create/input), perilaku rotasi, keberadaan reset-video, batas API UHID.
- [ ] Tulis hasil verifikasi ke `packages/scrcpy/PROTOCOL.md` (catatan byte-layout per message + link file source rujukan). Ini artefak wajib — reviewer memeriksa dokumen ini, bukan mempercayai plan.
- [ ] `packages/scrcpy/src/version.ts`: `SCRCPY_VERSION`, `UHID_MIN_API`, konstanta flag/tipe hasil verifikasi.
- **Verifikasi tahap:** `PROTOCOL.md` ada, setiap entri menyebut file+baris source rujukan; tidak ada `TODO-verify` yang tersisa tanpa jawaban.

### Tahap 5.2 — `@enkaku/scrcpy`: server launcher & connection

- [ ] `packages/scrcpy/package.json`, `tsconfig`, wiring workspace (pola package Plan 01).
- [ ] `src/options.ts`: Zod schema `ScrcpySessionOptions` + builder daftar argumen `key=value` (unit-testable, deterministic order).
- [ ] `src/server.ts`: `ScrcpyServerProcess` — push jar (skip kalau md5/size sama), `adb forward` + alokasi port dari pool, spawn `app_process` (proses adb shell dipegang; exit code & stderr server di-log), teardown idempotent (`forward --remove`, release port).
- [ ] `src/connection.ts`: connect TCP video → baca dummy byte + metadata → connect control socket; timeout 5 s per langkah; hasil = `ScrcpyVideoMeta` + dua stream.
- [ ] `src/index.ts`: `startScrcpySession()` merakit semuanya, expose `ScrcpySession`.
- **Verifikasi tahap:** script smoke `ENKAKU_TEST_DEVICE=1 bun run packages/scrcpy/scripts/smoke-connect.ts <serial>` mencetak `{deviceName, codec, width, height}` dari device fisik lalu teardown bersih (`adb forward --list` kosong, tidak ada proses `app_process` scrcpy tersisa di `adb shell ps`).

### Tahap 5.3 — Demuxer + SPS parser (unit-test-first)

- [ ] `src/demuxer.ts`: `FrameDemuxer` sesuai §4.4 (incremental, tahan chunk terpotong).
- [ ] `src/sps.ts`: parser minimal SPS Annex-B → `{ codecString, width, height }` (cukup untuk H.264 profile umum; exp-Golomb reader kecil).
- [ ] Fixture: `src/__fixtures__/` — (a) bytes sintetis header frame (dibuat oleh helper test), (b) capture asli beberapa KB pertama stream device fisik (di-commit, dipakai regression test lintas versi).
- [ ] Unit test: header utuh, header terpotong di setiap offset 1..11, payload terpotong, config→keyframe→delta sequence, PTS/flag benar; SPS fixture → dimensi & codecString benar.
- **Verifikasi tahap:** `bun test packages/scrcpy` hijau; smoke `smoke-connect.ts` diperluas mencetak 100 packet pertama (kind, pts, size) — terlihat `config` lalu `keyframe` di awal.

### Tahap 5.4 — Control writer + UHID

- [ ] `src/control/messages.ts` + `writer.ts`: encoder inject touch/keycode/text, UHID create/input — layout persis `PROTOCOL.md`; writer serialize ke socket control (queue FIFO, backpressure aware).
- [ ] `src/hid/keyboard.ts` + `src/hid/pointer.ts`: descriptor + report builder (§4.8).
- [ ] Unit test golden-bytes: setiap message type → byte array yang diharapkan (dari `PROTOCOL.md`); HID report tap(100,200) di layar 1080×2400 → nilai X/Y ternormalisasi benar.
- **Verifikasi tahap:** `ENKAKU_TEST_DEVICE=1` smoke: inject touch SDK men-tap app icon di device; UHID create keyboard sukses (tidak ada error di log server scrcpy) dan `key(KEYCODE_A)` mengetik huruf di field fokus.

### Tahap 5.5 — Engine drivers: DisplaySource + InputSink

- [ ] `packages/drivers/src/display/scrcpy.ts`: `ScrcpyDisplaySource` implement `DisplaySource` (spec §7) — `start()` = `startScrcpySession` (jar path dari Toolchain, port dari pool core), `onFrame(cb)` meneruskan `ScrcpyPacket` + `FrameMeta` (flags/pts/dimensi), `stop()` teardown; `locks: ['video-encoder']`; configSchema §4.9.
- [ ] `packages/drivers/src/input/scrcpy-uhid.ts` + `scrcpy-sdk.ts`: implement `InputSink` (`mode: 'uhid' | 'sdk'`) di atas `ScrcpyControl` **dari session display yang sama** (satu proses server melayani video+control; kalau display bukan scrcpy tapi input scrcpy diminta → start session `video=false` khusus control — flag `video=false` `TODO-verify` ada di 5.1).
- [ ] `packages/drivers/src/input/select.ts`: resolusi mode (§3.8): preferredMode → gating apiLevel → degrade chain `uhid → sdk → adb-input`, dengan alasan degrade dilaporkan ke log + field `session.inputModeActive`.
- [ ] Registrasi ke registry drivers (pola Plan 07); pastikan lock `input-injection` bentrok terdeteksi (mis. dengan appium input kelak).
- **Verifikasi tahap:** `GET /api/registry` memuat `scrcpy`, `scrcpy-uhid`, `scrcpy-sdk` lengkap dengan `configSchema` + `locks`; membuat session dengan display `scrcpy` + input `scrcpy-uhid` di device fisik: `tap/swipe/key/text` semua bekerja; set `preferredMode:'sdk'` di DeviceSettings → mode aktif berubah tanpa restart core.

### Tahap 5.6 — Core: DisplayRelay + WS device-view

- [ ] `packages/protocol/src/binary/channels.ts` + `messages/display.ts`: konstanta channel (selaras Plan 03), encoder/decoder binary message video (§4.5), Zod schema `display.configure|stats|error`.
- [ ] `packages/core/src/display/relay.ts`: `DisplayRelay` — subscribe `DisplaySource.onFrame`, cache config packet terakhir, kirim `display.configure` saat start & saat `onMetaChange`, framing binary, backpressure drop-to-keyframe (§4.5), single-viewer policy (§3.7), stop dengan grace 10 s.
- [ ] `packages/core/src/ws/device-view.ts`: endpoint `/ws/device/:id/view` — auth, cek device online, tolak viewer kedua (`display_busy`), wire relay; `input.*` tetap lewat jalur lease Plan 04 (tidak diduplikasi di sini).
- [ ] Unit test: relay dengan DisplaySource palsu — urutan pesan (configure → config → keyframe → delta), drop-to-keyframe saat bufferedAmount mock tinggi, config tidak pernah di-drop, viewer kedua ditolak.
- **Verifikasi tahap:** `bun test packages/core` hijau; via `wscat`/script kecil: connect ke `/ws/device/:id/view` device fisik → menerima `display.configure` JSON lalu binary frames mengalir (hexdump menunjukkan prefix `0x01`).

### Tahap 5.7 — Studio: decoder, renderer, input mapping

- [ ] `stream.ts`: WS client per device-view (satu WS per view session), demux binary vs JSON, state machine connect/retry (ikut `autoReconnect`).
- [ ] `decoder-webcodecs.ts` (§4.6) + `decoder-tinyh264.ts` (vendor wasm TinyH264, muat lazy) + seleksi otomatis via `isConfigSupported`; saat fallback aktif tampilkan badge "software decoder".
- [ ] `renderer.ts`: canvas (ukuran mengikuti `display.configure`, object-fit contain, devicePixelRatio-aware); rotasi → resize mulus.
- [ ] `input-capture.ts`: pointer events canvas → koordinat device (skala + letterbox offset; **wajib** memakai dimensi dari `display.configure` terbaru, bukan dimensi awal) → kirim `input.tap`/`input.swipe`; keyboard capture saat canvas fokus → `input.key`/`input.text`. Saat `busy`: UI disable + tampilkan reject dari core dengan badge (perilaku Plan 04, dipertahankan).
- [ ] `stats-overlay.tsx`: fps decode (hitung `VideoFrame` per detik), resolusi, bitrate (dari `display.stats`), decoder aktif, tombol copy angka (dipakai untuk laporan NFR).
- [ ] Halaman device detail: pilih engine display/input dari dropdown registry (sudah schema-driven dari Plan 07 — pastikan engine baru muncul & config form ter-render).
- **Verifikasi tahap:** buka device view di Chrome → video hidup, klik & ketik tembus ke device; matikan flag WebCodecs (atau buka Firefox) → fallback TinyH264 hidup (dengan badge); rotasi device → canvas menyesuaikan dan klik tetap akurat di orientasi baru.

### Tahap 5.8 — Lifecycle & resiliency

- [ ] Wire `device.removed`/transport disconnect → teardown relay+session (tabel §4.10); pastikan `adb forward` dibersihkan (audit dengan `adb forward --list` di test).
- [ ] Auto-reconnect: device balik online + viewer masih menunggu + `autoReconnect:true` → restart session; Studio re-init decoder dari `display.configure` baru.
- [ ] Retry engine gagal (1× scid baru) + `display.error` + jalur pindah manual ke `screencap-loop`.
- [ ] Pastikan job automation berjalan (device `busy`) tidak mengganggu/terganggu: video jalan, input viewer di-reject, job memakai InputSink scrcpy yang sama tanpa konflik lock.
- **Verifikasi tahap:** skenario manual berskrip (§7.2 kasus D–F) semuanya lulus.

### Tahap 5.9 — Verifikasi NFR + dokumentasi

- [ ] Implement prosedur pengukuran §7.3 (timestamp overlay + kamera; fps dari stats-overlay); jalankan di ≥ 2 device fisik berbeda (idealnya beda vendor), catat hasil di `packages/scrcpy/README.md` bagian "Measured performance".
- [ ] README `packages/scrcpy` (arsitektur, versi-lock, cara regen fixture saat naik versi) + update README `packages/drivers` (engine baru, degrade chain input).
- [ ] Sweep: tidak ada `TODO-verify` tersisa di kode; `bun test` hijau seluruh workspace.
- **Verifikasi tahap:** seluruh acceptance criteria §6 dicek satu per satu.

## 6. Acceptance criteria

Semua harus lulus:

1. `bun test` hijau di seluruh workspace, termasuk unit test baru `packages/scrcpy`, `packages/core` (relay), `packages/protocol` (framing).
2. `packages/scrcpy/PROTOCOL.md` ada, setiap layout byte merujuk file source scrcpy versi pinned; `SCRCPY_VERSION` tunggal dan dipakai baik oleh argumen server maupun pengecekan Toolchain (`compatibleCoreRange`).
3. Tool `scrcpy-server` tetap tampil "managed by core" di Studio Tools (tidak ada tombol ganti versi) — regresi Plan 02/07 tidak terjadi.
4. Device fisik (Android ≥ `UHID_MIN_API`): buka device view di Chrome → video tampil < 3 s sejak klik, tap/swipe/ketik bekerja dengan mode input `uhid` (terlihat di badge mode aktif).
5. Device dengan `apiLevel < UHID_MIN_API` atau `preferredMode:'sdk'` → mode aktif `sdk`; cabut paksa scrcpy input (simulasi gagal init) → degrade sampai `adb-input`, tercatat di log.
6. **Glass-to-glass < 150 ms (LAN)** diukur dengan prosedur §7.3, median dari ≥ 10 sampel, di Chrome + WebCodecs.
7. **FPS ≥ 24** saat konten bergerak (scroll cepat / video playback di device) selama 30 s, dibaca dari stats-overlay.
8. Rotasi device saat streaming: video menyesuaikan ≤ 2 s, tap setelah rotasi akurat (uji tap 4 sudut target).
9. Cabut USB saat streaming: viewer dapat `display.error`, `adb forward --list` bersih, tidak ada proses scrcpy zombie; colok lagi (autoReconnect on) → video hidup kembali tanpa reload halaman.
10. Viewer kedua ke device yang sama ditolak dengan `display_busy`; viewer pertama tidak terganggu.
11. Saat job automation berjalan (`busy`): video tetap tampil, klik viewer di-reject core (bukan cuma disabled UI) — perilaku Plan 04 utuh.
12. Fallback: pilih engine display `screencap-loop` dari Studio → tetap bekerja; browser tanpa WebCodecs → TinyH264 menampilkan video (fps boleh < 24, dicatat).
13. Tidak ada pemanggilan `adb kill-server` baru; semua akses adb lewat per-device queue + semaphore (overview §3).

## 7. Test plan

### 7.1 Unit test (`bun test`)

| Area | Test | File |
|---|---|---|
| Options builder | schema default, urutan argumen deterministik, penolakan nilai invalid | `packages/scrcpy/src/options.test.ts` |
| Demuxer | fixture sintetis: potong chunk di setiap offset header (1..11 byte), payload terpotong, sequence config→key→delta, PTS & flag benar; fixture capture asli device → packet pertama = config | `packages/scrcpy/src/demuxer.test.ts` |
| SPS parser | fixture SPS beberapa resolusi/profile → `codecString`, width, height benar | `packages/scrcpy/src/sps.test.ts` |
| Control writer | golden bytes per message type sesuai `PROTOCOL.md` (touch down/up/move, keycode, text UTF-8, uhid create/input) | `packages/scrcpy/src/control/messages.test.ts` |
| HID reports | tap/swipe → report bytes; normalisasi koordinat 0..32767 di beberapa resolusi; swipe interpolasi N step | `packages/scrcpy/src/hid/pointer.test.ts` |
| WS framing | encode↔decode round-trip binary video message; flags; channel salah → error | `packages/protocol/src/binary/channels.test.ts` |
| DisplayRelay | source palsu: urutan configure→config→key→delta; drop-to-keyframe saat backpressure; config tak pernah drop; single-viewer reject; grace stop | `packages/core/src/display/relay.test.ts` |
| Input select | matrix preferredMode × apiLevel × init-failure → mode aktif yang benar | `packages/drivers/src/input/select.test.ts` |

Fixture bytes disimpan di `packages/scrcpy/src/__fixtures__/`; script `scripts/capture-fixture.ts` (butuh device) meregenerasi capture asli — dijalankan ulang setiap naik `SCRCPY_VERSION`.

### 7.2 E2E device fisik (`ENKAKU_TEST_DEVICE=1`, sebagian manual berskrip)

- **A. Smoke connect** — `bun run packages/scrcpy/scripts/smoke-connect.ts <serial>`: meta benar, packet mengalir, teardown bersih.
- **B. Input end-to-end** — session uhid: tap membuka app yang ditarget, swipe scroll list, `text('enkaku123')` masuk ke field; ulangi mode sdk.
- **C. Browser happy path** — Chrome: video < 3 s, klik akurat (tap 4 sudut + tengah pada app grid target), ketik.
- **D. Rotasi** — putar device (auto-rotate on) saat streaming → acceptance #8.
- **E. Disconnect/reconnect** — cabut-colok USB → acceptance #9; ulangi via wireless adb (`adb-tcp`).
- **F. Busy interplay** — enqueue job dummy 60 s (Plan 04) → tonton video jalan, klik di-reject, job selesai → input pulih.
- **G. Single-viewer** — dua tab browser → tab kedua dapat `display_busy` (kebijakan §3.7); tutup tab pertama + tunggu grace → tab kedua bisa connect.
- **H. Fallback decoder** — Firefox (atau Chrome dengan `--disable-features=WebCodecs`): TinyH264 hidup, badge tampil.
- **I. Fallback engine** — ganti display ke `screencap-loop` dari Studio → live view tetap jalan (regresi Plan 03).

### 7.3 Prosedur verifikasi NFR (spec §16)

**Glass-to-glass < 150 ms (LAN):**
1. Di device, tampilkan stopwatch milidetik (app clock dengan centiseconds, atau halaman web `requestAnimationFrame` timer di Chrome Android).
2. Letakkan device fisik bersebelahan dengan monitor yang menampilkan Studio device-view.
3. Foto keduanya dalam SATU frame kamera (mode shutter cepat, atau video 240 fps lalu ambil frame) — selisih angka stopwatch device vs stopwatch di video Studio = glass-to-glass.
4. Ambil ≥ 10 sampel, laporkan median + p95. Lulus: median < 150 ms.
5. Pelengkap (bukan pengganti): stats-overlay menampilkan `t_core→render` (timestamp core saat kirim, disinkronkan kasar via WS ping, vs `performance.now()` render) untuk debugging regresi — angka acceptance tetap dari metode kamera.

**FPS ≥ 24:** jalankan konten bergerak di device (scroll cepat berulang via swipe otomatis, lalu video playback) 30 s; baca fps decode dari stats-overlay (rata-rata & minimum per detik). Lulus: rata-rata ≥ 24 saat konten bergerak (idle boleh turun, sesuai spec).

Hasil kedua pengukuran dicatat di README `packages/scrcpy` (device, Android version, host, network).

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Detail protokol di plan meleset dari source versi pinned | Video/kontrol mati total | Tahap 5.1 = gerbang wajib: verifikasi source + `PROTOCOL.md` sebelum koding; fixture capture asli sebagai regression test. |
| Upgrade scrcpy di masa depan merusak client | Rilis core cacat | Versi-lock (§3.2): `SCRCPY_VERSION` + `compatibleCoreRange` + checklist regen fixture; upgrade = pekerjaan rilis, bukan operasi user. |
| Descriptor UHID pointer absolut tidak didukung ROM vendor tertentu | Tap uhid tidak jalan di sebagian device | Degrade chain otomatis `uhid → sdk → adb-input` + badge mode aktif; e2e di ≥ 2 vendor; catat device bermasalah di README. |
| WebCodecs tidak ada (Firefox/Safari) | Tidak bisa nonton | Fallback TinyH264 (badge "software decoder"); dokumentasikan Chromium sebagai rekomendasi. |
| Backpressure viewer lambat (WiFi jelek) | Latency menumpuk / memori WS bengkak | Drop-to-keyframe di relay (§4.5) + threshold bufferedAmount; stats-overlay memperlihatkan drop. |
| Port forward bentrok / bocor | Session gagal start setelah lama jalan | Pool port ber-register + teardown idempotent + audit `adb forward --list` di e2e. |
| Keyframe jarang → recovery lambat setelah drop/rotasi | Layar beku beberapa detik | Ukur di e2e; kalau parah, evaluasi opsi encoder interval IDR / reset-video di Open questions. |
| `text()` uhid tidak bisa non-ASCII | Ketik teks lokal gagal | Keputusan §3.8: text lewat inject-text SDK; dicatat sebagai trade-off di README + Open questions. |
| Server scrcpy zombie di device (teardown gagal) | Encoder terkunci, battery drain | `cleanup=true`, close socket = server exit; deteksi via smoke test `ps`; restart dengan scid baru tidak bentrok dengan zombie lama. |

## 9. Open questions

Ambiguitas yang butuh keputusan manusia — JANGAN diputuskan sepihak saat implementasi:

1. **Multi-viewer satu device.** M6 memakai single-viewer (§3.7). Kalau multi-viewer dibutuhkan (mis. mentor menonton operator), pilih strategi late-joiner: restart stream, cache config + tunggu IDR, atau reset-video control message (kalau terverifikasi ada di versi pinned). Prioritas dan pilihan strateginya butuh keputusan produk.
2. **Prioritas upgrade fallback decoder ke MSE.** TinyH264 cukup "bisa dipakai", tapi kalau segmen user non-Chromium signifikan, MSE (hardware decode) layak jadi pekerjaan lanjutan. Seberapa penting non-Chromium untuk target pasar?
3. **`text()` full-HID.** Saat ini `text()` memakai jalur inject-text SDK meski mode uhid (§3.8) — artinya app yang mendeteksi injeksi teks tetap bisa membedakan. Untuk use case red-team detektor (spec §9.4), perlukah implementasi typing HID penuh (layout mapping + IME considerations)?
4. **Audio forwarding.** scrcpy mendukungnya; M6 mematikannya. Apakah audio dibutuhkan untuk QA (mis. test notifikasi suara), dan di milestone mana?
5. **Nilai `UHID_MIN_API` final.** Ditetapkan dari verifikasi 5.1 + hasil e2e lintas vendor; kalau temuan lapangan menunjukkan batas berbeda per-vendor, apakah perlu deny-list per model di samping gating apiLevel?
6. **Interval IDR encoder.** Kalau recovery-after-drop terasa lambat (§8), apakah kita set opsi encoder (bila tersedia di versi pinned) untuk IDR lebih sering — dengan trade-off bitrate naik?
7. **Grace period stop stream (10 s) & pool port (27100–27299)** — angka awal yang wajar; perlu dikonfirmasi/diubah setelah dipakai di farm nyata?
8. **Codec H.265/AV1.** WebCodecs mendukung keduanya di Chromium modern; kapan layak dibuka sebagai opsi config display (dengan fallback tetap H.264)?
