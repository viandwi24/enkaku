# @enkaku/agent

Mini-core untuk **mode cloud** (spec §5.3): agent ringan berjalan di dekat device, membuka **tunnel WebSocket keluar** ke control plane. Karena koneksi bersifat outbound, tidak perlu port-forward dan NAT tidak jadi masalah.

## Status implementasi

| Sub-fase | Isi | Status |
|---|---|---|
| **M8a** | State + enrollment token, tunnel outbound (auth, keepalive, backoff full-jitter), frame binary multi-device, laporan device dari `track-devices` | ✅ ada di sini |
| M8b | Video WebRTC (relay terminate RTCPeerConnection, repackage H.264 → RTP) | ⏳ belum |
| M8c | Security boundary per job (container/microVM), tenant scoping | ⏳ belum |
| M8d | redroid, `scrcpy-aoa`, engine Appium | ⏳ belum |

Message `session.start`, `session.stop`, dan `job.dispatch` sudah terdefinisi di protokol dan diterima tunnel, tapi handler-nya sengaja belum diimplement — dicatat di log, bukan gagal diam-diam.

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
