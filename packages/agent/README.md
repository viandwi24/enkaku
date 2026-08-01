# @enkaku/agent

Mini-core untuk **mode cloud** (spec §5.3): agent ringan berjalan di dekat device, membuka **tunnel WebSocket keluar** ke control plane. Karena koneksi bersifat outbound, tidak perlu port-forward dan NAT tidak jadi masalah.

## Status implementasi

| Sub-fase | Isi | Status |
|---|---|---|
| **M8a** | State + enrollment token, tunnel outbound (auth, keepalive, backoff full-jitter), frame binary multi-device, laporan device dari `track-devices`; sisi control plane: registry agent, router, mode `orchestrator` | ✅ |
| **M8b** | Signaling WebRTC (protocol + klien Studio dgn fallback otomatis), packetizer H.264 → RTP (RFC 6184), konfigurasi ICE | ⚠️ sebagian — backend WebRTC server-side belum dipilih |
| **M8c** | `IsolationProvider`: child-process (local) & container (`--network=none`, cap-drop, opsi gVisor via `--runtime=runsc`); kolom `tenantId` di devices & agents | ✅ |
| **M8d** | Engine Appium opt-in, `scrcpy-aoa` (terdaftar tapi `available: false`), redroid via transport `adb-tcp` | ✅ |

Message `session.start`, `session.stop`, dan `job.dispatch` sudah terdefinisi di protokol dan diterima tunnel, tapi handler sisi agent sengaja belum diimplement — dicatat di log, bukan gagal diam-diam.

## Yang tersisa di M8b

`RtcPeerFactory` (di `packages/core/src/relay/rtc-peer.ts`) sengaja dibiarkan `available: false` sampai backend WebRTC server-side dipilih. Rekomendasi plan: **werift** (pure TypeScript, sejalan dengan prinsip self-contained), dengan sidecar GStreamer sebagai rencana cadangan bila verifikasi di Bun gagal. Selama backend belum ada, control plane menjawab `video.webrtc.failed` dan Studio otomatis memakai WS+WebCodecs — jalan, tapi rentan freeze di internet.

Bagian yang tidak bergantung library sudah selesai dan bisa diuji terpisah: pemecahan Annex-B, fragmentasi FU-A, penyisipan SPS/PPS sebelum IDR, dan konversi timestamp ke clock 90 kHz.

## Jalankan

```bash
ENKAKU_CP_URL=https://farm.example.com \
ENKAKU_ENROLL_TOKEN=<token sekali pakai dari Studio> \
ENKAKU_DATA_DIR=/var/lib/enkaku-agent \
bun run packages/agent/src/index.ts
```

Token hanya dibutuhkan sekali: hasilnya (`agentId` + credential jangka panjang) disimpan di `<data-dir>/agent.json`. Setelah itu agent cukup dijalankan tanpa token.

## Kenapa video butuh WebRTC di cloud

Tunnel WebSocket berjalan di atas TCP. Di internet, satu paket hilang membuat TCP menahan seluruh aliran sampai retransmisi selesai (head-of-line blocking) — pada remote control real-time efeknya video membeku. Karena itu jalur video cloud direncanakan pindah ke WebRTC (UDP, congestion control, partial reliability), sementara kontrol dan antrian tetap lewat WebSocket. Di LAN, WS + WebCodecs tetap dipakai karena lebih sederhana dan tidak butuh STUN/TURN.
