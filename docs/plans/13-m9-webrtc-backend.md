# Plan 13 — M9b : Backend WebRTC (video cloud tanpa freeze)

> **Status:** siap dikerjakan. **Depends on:** Plan 12 (mode cloud berfungsi) — WebRTC menggantikan jalur video-nya, bukan menambahkannya dari nol.
> **Referensi spec:** §5.3 (video cloud butuh transport lain), §16 (NFR latensi & fps).

---

## 1. Goals

- Video device di mode cloud mengalir lewat **WebRTC (UDP)**, sehingga kehilangan paket **tidak lagi membekukan layar**.
- Pemilihan jalur otomatis dan jujur: WebRTC bila bisa, WebSocket bila tidak, dengan indikator jelas di Studio — pengguna tahu sedang di jalur mana.
- Keyframe pulih otomatis saat paket hilang (browser mengirim PLI → relay meminta IDR baru ke device).
- Mode LAN/lokal **tidak berubah sama sekali** — tetap WS + WebCodecs yang sudah terbukti dan lebih sederhana.

Demo akhir: agent + HP di balik NAT rumah, control plane di VPS, browser di jaringan ketiga. Dengan `tc netem` mensimulasikan 3% packet loss, jalur WS terlihat membeku berulang sementara jalur WebRTC tetap mengalir.

## 2. Non-goals

- **Audio** — scrcpy mendukungnya, tapi farm QA tidak membutuhkannya. Channel `audio` sudah dicadangkan di protokol.
- **Video dua arah / kamera** — tidak relevan.
- **SFU multi-viewer** — satu device satu penonton (kebijakan Plan 08 §3.7) masih berlaku.
- **Mengganti jalur LAN** — WS+WebCodecs tetap default di LAN; menambah WebRTC di sana hanya menambah TURN/STUN tanpa manfaat.

## 3. Konteks & keputusan desain

### 3.1 Kenapa WebSocket tidak cukup di internet

WebSocket berjalan di atas TCP, yang menjamin **urutan**. Ketika satu paket hilang, semua data setelahnya ditahan di buffer penerima sampai paket itu berhasil dikirim ulang — *head-of-line blocking*. Untuk transfer file itu benar; untuk video langsung itu bencana: layar membeku 1–2 detik lalu melompat.

WebRTC memakai UDP: frame yang hilang ya hilang, aliran lanjut. Untuk remote control, frame basi memang tidak ada gunanya.

Di LAN kehilangan paket praktis nol, jadi WS baik-baik saja — dan jauh lebih sederhana (tanpa STUN/TURN, tanpa DTLS). Itulah kenapa keduanya tetap ada.

### 3.2 Keputusan library: **werift** — sudah diverifikasi jalan di Bun

Plan 11 menandai pilihan library sebagai pertanyaan terbuka karena kompatibilitas dengan Bun belum terbukti. **Pertanyaan itu sudah dijawab dengan pengujian nyata** (werift 0.24.2, Bun 1.3.14, macOS arm64):

| Yang diuji | Hasil |
|---|---|
| `new RTCPeerConnection` + `createOffer` + `setLocalDescription` | ✅ berhasil |
| SDP berisi `m=video` dengan codec H.264 | ✅ |
| DTLS fingerprint dihasilkan (artinya `node:crypto` memadai) | ✅ |
| Pengumpulan kandidat ICE | ✅ 9 kandidat (artinya `node:dgram`/UDP berfungsi) |
| Umpan balik `nack`/`pli` ternegosiasi | ✅ |
| `MediaStreamTrack.writeRtp` untuk injeksi RTP mentah | ✅ tersedia |
| `RtpPacket.serialize()` | ✅ 12 byte header + payload |

Ini penting karena dua primitif paling berisiko — **UDP socket** dan **kriptografi DTLS** — justru yang terbukti bekerja.

Yang **belum** terverifikasi dan harus dibuktikan di plan ini: handshake DTLS lengkap dengan browser sungguhan, aliran SRTP berkelanjutan, dan konsumsi CPU untuk beberapa stream sekaligus.

### 3.3 Soal "Bun kan kompatibel Node, tidak bisakah otomatis lari ke Node?"

Pertanyaan yang wajar, dan jawabannya menentukan rencana cadangan.

**Bun tidak mendelegasikan apa pun ke Node.** Bun **menulis ulang** API Node (`fs`, `net`, `dgram`, `crypto`, …) dalam Zig di dalam runtime-nya sendiri. Node tidak perlu terpasang, dan tidak ada mekanisme "kalau gagal, jalankan di Node". Kalau sebuah API belum diimplementasikan Bun, kode itu gagal — tidak ada jaring pengaman otomatis.

Untuk modul **native** (seperti `node-webrtc`/`wrtc` yang membungkus libwebrtc C++), Bun mendukung N-API tapi cakupannya belum penuh — karena itu kandidat native lebih berisiko daripada werift yang TypeScript murni.

**Tapi ide Anda tetap bisa dipakai — sebagai sidecar eksplisit.** Kalau werift ternyata gagal pada tahap DTLS/SRTP dengan browser sungguhan, relay video dijalankan sebagai **proses terpisah di bawah Node**, dan core (Bun) berkomunikasi dengannya lewat unix socket. Bentuk arsitekturnya sama persis dengan rencana cadangan GStreamer yang sudah ada di Plan 11, hanya isinya berbeda. Yang membuatnya murah: `RtcPeerFactory` sudah menjadi antarmuka, jadi menukar implementasi tidak menyentuh kode relay.

Urutan rencana:

| Urutan | Pendekatan | Kapan dipakai |
|---|---|---|
| 1 | werift in-process (Bun) | Default — sudah terbukti sampai tahap SDP/ICE |
| 2 | werift sebagai sidecar Node | Bila DTLS/SRTP gagal khusus di Bun |
| 3 | GStreamer `webrtcbin` sidecar | Bila werift kurang kuat untuk skala banyak stream |

### 3.4 Yang sudah selesai dan tidak perlu diulang

Bagian yang **tidak bergantung library** sudah ada dan terverifikasi logikanya:

- Pemecahan Annex-B → NAL unit.
- Fragmentasi FU-A untuk NAL besar (diuji: 3000 byte → paket-paket ≤ 1200 byte dengan bit S/E benar).
- Penyisipan SPS/PPS otomatis sebelum setiap IDR.
- Konversi timestamp ke clock 90 kHz (1 detik → 90000).
- Marker bit hanya pada paket terakhir tiap access unit.
- Message signaling, endpoint konfigurasi ICE, dan klien Studio dengan fallback.

Plan ini menyambungkan hasil packetizer itu ke peer WebRTC yang sesungguhnya.

### 3.5 STUN & TURN

STUN saja cukup untuk sebagian besar NAT rumahan. Untuk NAT simetris dan jaringan kantor yang memblokir UDP, **TURN wajib** — tanpa itu koneksi gagal dan pengguna jatuh ke WS.

Keputusan: **coturn self-host** sebagai container di sebelah control plane, dengan kredensial berjangka waktu (bukan kredensial statis yang bocor selamanya). Ini sejalan dengan prinsip self-hosted spec §5.3.

## 4. Desain teknis

### 4.1 Struktur file

```
packages/core/src/relay/
  rtp-h264.ts              # SUDAH ADA — packetizer (tidak berubah)
  rtc-peer.ts              # SUDAH ADA — interface RtcPeer (tidak berubah)
  werift-peer.ts           # BARU — implementasi RtcPeerFactory memakai werift
  webrtc-relay.ts          # BARU — orkestrasi: sumber frame → packetizer → peer
  ice-credentials.ts       # BARU — kredensial TURN berjangka waktu
  sidecar/                 # BARU (hanya bila rencana 2 dipakai)
    protocol.ts            # message unix-socket core ⇄ sidecar
    server.mjs             # relay Node yang dijalankan terpisah
deploy/
  coturn/turnserver.conf   # BARU — konfigurasi TURN
  docker-compose.cloud.yml # BARU — control plane + coturn
packages/studio/src/lib/
  webrtc-player.ts         # SUDAH ADA — tambah indikator jalur & statistik
```

### 4.2 Implementasi peer

```ts
// packages/core/src/relay/werift-peer.ts
export function createWeriftFactory(): RtcPeerFactory {
  return {
    available: true,
    async create({ iceServers }) {
      const pc = new RTCPeerConnection({
        iceServers,
        codecs: { video: [ /* H.264 packetization-mode=1, feedback nack + pli */ ] },
      })
      const track = new MediaStreamTrack({ kind: 'video' })
      pc.addTransceiver(track, { direction: 'sendonly' })
      let seq = 0
      return {
        // Paket dari packetizer kita dibungkus RtpPacket lalu ditulis ke track.
        sendRtp: (p) => track.writeRtp(new RtpPacket(
          new RtpHeader({ payloadType: 96, sequenceNumber: seq++ & 0xffff,
                          timestamp: p.timestamp, marker: p.marker, ssrc }),
          Buffer.from(p.payload))),
        onKeyframeRequest: (cb) => { /* RTCP PLI/NACK dari browser */ },
        // createOffer / setRemoteAnswer / addIceCandidate / onIceCandidate / close
      }
    },
  }
}
```

Nomor urut RTP dipegang relay (bukan packetizer) karena satu peer punya satu ruang nomor urut.

### 4.3 Alur relay

```
agent → tunnel channel video (H.264 Annex-B)
  → WebRtcRelay.push(chunk, ptsUs)
      → createH264Packetizer().push()   # sudah ada, teruji
      → peer.sendRtp(paket)             # werift → SRTP/UDP → browser
browser <video>  ← ontrack

Browser kehilangan frame → RTCP PLI
  → peer.onKeyframeRequest()
  → relay minta IDR: control message scrcpy ke agent
     (TODO-verify mekanisme persis di scrcpy 3.3.1; fallback: restart stream)
```

### 4.4 Pemilihan jalur di Studio

```
mulai → mode lokal/LAN?  ─ya→  WS + WebCodecs (selesai, tidak ada perubahan)
                          └tidak→ minta WebRTC
                                   ├ sukses  → badge "WebRTC"
                                   └ gagal   → WS + WebCodecs, badge "degraded" + alasan
```

Pemicu fallback: `video.webrtc.failed` dari server, status ICE `failed`, atau tidak ada frame selama 10 detik. Semuanya sudah diimplementasikan di klien; plan ini menambahkan **indikator jalur yang terlihat** supaya pengguna tidak menebak kenapa videonya tersendat.

### 4.5 Kredensial TURN berjangka waktu

```ts
// username = "<expiry-unix>:<userId>", password = base64(HMAC-SHA1(secret, username))
```

Berlaku 12 jam. Kredensial bocor hanya berguna sampai kedaluwarsa, dan tidak membocorkan rahasia server.

## 5. Langkah implementasi

### Tahap 1 — Peer werift & bukti ujung-ke-ujung

- [ ] Tambah `werift` sebagai dependensi core; tulis `werift-peer.ts` (§4.2).
- [ ] Uji tulang punggung: peer server ↔ browser sungguhan, kirim RTP dari pola uji sintetis (bukan device), pastikan `<video>` menampilkan gambar.
- **Verifikasi:** ini **gerbang keputusan**. Kalau DTLS/SRTP gagal di Bun, hentikan dan lanjut ke Tahap 1b sebelum menulis kode lain.

### Tahap 1b — (bersyarat) sidecar Node

- [ ] Hanya bila Tahap 1 gagal: pindahkan `werift-peer.ts` ke proses Node terpisah, komunikasi lewat unix socket (`sidecar/protocol.ts`).
- [ ] Sidecar dikelola Toolchain Manager sebagai tool opsional (pola yang sama dengan tool lain).
- **Verifikasi:** hasil akhir dari sudut pandang core identik — `RtcPeerFactory` tidak berubah.

### Tahap 2 — Relay & signaling

- [ ] `webrtc-relay.ts`: sambungkan channel video tunnel → packetizer → `peer.sendRtp`.
- [ ] Handler signaling di control plane: `video.webrtc.request` → buat peer → kirim offer; terima answer & kandidat ICE.
- [ ] `video.webrtc.failed` untuk setiap kegagalan (termasuk saat `RtcPeerFactory.available === false`).
- **Verifikasi:** video device agent tampil di browser lewat WebRTC.

### Tahap 3 — Pemulihan keyframe

- [ ] Terjemahkan RTCP PLI menjadi permintaan IDR ke device lewat tunnel.
- [ ] Verifikasi mekanisme permintaan IDR di scrcpy 3.3.1; bila tidak ada, mulai ulang stream sebagai gantinya (dan catat itu di kode).
- **Verifikasi:** sengaja buang paket dengan `tc netem` 5%; gambar pulih sendiri dalam < 2 detik, tidak macet permanen.

### Tahap 4 — TURN & deployment

- [ ] `deploy/coturn/turnserver.conf` + `docker-compose.cloud.yml`.
- [ ] `ice-credentials.ts` (§4.5); `GET /api/agents/ice-config` mengembalikan kredensial berjangka waktu.
- **Verifikasi:** browser di jaringan yang memblokir UDP langsung (hanya TCP/443) tetap tersambung lewat TURN.

### Tahap 5 — Indikator & statistik di Studio

- [ ] Badge jalur: `WebRTC` / `WS (degraded)` + alasan fallback.
- [ ] Panel statistik: fps, bitrate, paket hilang, RTT (dari `getStats()`).
- **Verifikasi:** saat jaringan diganggu, angka di panel berubah sesuai kenyataan.

### Tahap 6 — Pengukuran NFR

- [ ] Ukur glass-to-glass dan fps di tiga kondisi: LAN, internet bersih, internet 3% loss.
- [ ] Bandingkan WS vs WebRTC pada kondisi ketiga — ini bukti klaim spec §5.3.
- **Verifikasi:** angka tercatat di `docs/benchmarks/webrtc.md`.

## 6. Acceptance criteria

1. [ ] Video device agent tampil lewat WebRTC di browser Chromium.
2. [ ] Pada 3% packet loss, WebRTC tetap mengalir sementara WS terbukti membeku — dengan angka pembanding.
3. [ ] Kehilangan keyframe pulih otomatis < 2 detik.
4. [ ] Jaringan tanpa UDP langsung tetap tersambung lewat TURN.
5. [ ] Setiap kegagalan jatuh ke WS **dengan alasan yang terlihat pengguna** — tidak pernah layar hitam tanpa penjelasan.
6. [ ] Mode LAN/lokal tidak berubah sama sekali (diuji ulang).
7. [ ] Konsumsi CPU control plane untuk 5 stream simultan tercatat.
8. [ ] `RtcPeerFactory` tetap satu-satunya titik sentuh library — mengganti backend tidak menyentuh relay.

## 7. Test plan

**Tanpa jaringan nyata:** packetizer sudah punya kasus uji (Annex-B, FU-A, SPS/PPS, timestamp). Tambah: nomor urut RTP berputar di 65535, PLI memicu permintaan IDR.

**Dengan browser, satu mesin:** peer server + Chrome lokal, sumber pola uji sintetis. Membuktikan DTLS/SRTP tanpa variabel device.

**Ujung ke ujung:** device → agent → control plane → browser, tiga jaringan berbeda.

**Degradasi terkendali:** `tc netem` 1%/3%/5% loss dan delay 50/150 ms; catat fps, freeze, dan RTT untuk WS dan WebRTC berdampingan.

**Kegagalan yang disengaja:** matikan coturn saat sesi berjalan; blokir UDP di klien; hentikan agent di tengah stream.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| DTLS/SRTP werift gagal khusus di Bun | Rencana utama batal | Gerbang keputusan di Tahap 1 sebelum kode lain ditulis; sidecar Node sudah dirancang |
| CPU tinggi untuk banyak stream | Control plane jadi hambatan | Ukur sejak awal; SFU/relay terpisah bila perlu (di luar lingkup, tapi tidak dihalangi desain) |
| Nomor urut/timestamp RTP salah | Video patah-patah tanpa error jelas | Uji unit + `getStats()` di browser sebagai pembanding |
| Operasional TURN (port, bandwidth) | Biaya & kerumitan | Dokumentasikan; TURN hanya dipakai saat jalur langsung gagal |
| scrcpy tidak punya permintaan IDR eksplisit | Pemulihan keyframe lambat | Fallback restart stream, didokumentasikan sebagai batasan |

## 9. Open questions

1. **Sidecar Node bila diperlukan**: dikelola Toolchain Manager atau dianggap prasyarat sistem?
2. **Multi-viewer** kembali relevan bila WebRTC dipakai (SFU) — masih ditunda atau dibuka sekarang?
3. **Ambang fallback**: 10 detik tanpa frame terasa lama; apakah 5 detik lebih baik?
4. **Menyimpan rekaman sesi** (spec §22) lebih murah dilakukan di jalur RTP — apakah dimasukkan sekarang?
5. **Codec**: scrcpy mendukung H.265/AV1 yang lebih efisien, tapi dukungan WebCodecs/WebRTC-nya tidak merata. Tetap H.264 saja?
