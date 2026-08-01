# Catatan pengukuran WebRTC

## Verifikasi kompatibilitas (selesai)

Diuji pada Bun 1.3.14, macOS arm64, werift 0.24.2:

| Yang diuji | Hasil |
|---|---|
| `RTCPeerConnection` + `createOffer` + `setLocalDescription` | ✅ |
| SDP: `m=video`, H.264, `packetization-mode=1`, `a=sendonly` | ✅ |
| DTLS fingerprint (kriptografi runtime memadai) | ✅ |
| Pengumpulan kandidat ICE, termasuk server-reflexive via STUN | ✅ 9+ kandidat |
| Umpan balik `nack` / `pli` ternegosiasi | ✅ |
| Injeksi RTP mentah (`track.writeRtp`) | ✅ |
| Packetizer H.264 → peer, satu access unit 4 KB | ✅ 6 paket, tanpa error |
| Signaling end-to-end lewat WS control plane | ✅ offer + trickle ICE sampai ke klien |

**Kesimpulan:** rencana cadangan sidecar Node **tidak diperlukan**. Bun menjalankan werift secara langsung.

## Yang belum diukur

Butuh perangkat dan jaringan sungguhan:

- [ ] Handshake DTLS lengkap dengan browser (uji sampai `<video>` menampilkan gambar)
- [ ] Glass-to-glass di LAN, internet bersih, dan internet dengan 3% kehilangan paket
- [ ] Perbandingan WS vs WebRTC pada kondisi kehilangan paket — ini bukti klaim spec §5.3
- [ ] Pemulihan keyframe setelah paket hilang (PLI → IDR)
- [ ] Konsumsi CPU control plane untuk 5 stream simultan
- [ ] Koneksi lewat TURN dari jaringan yang memblokir UDP langsung

Prosedur: `tc netem` untuk mensimulasikan kehilangan paket, stopwatch di layar perangkat difoto bersama layar browser untuk glass-to-glass.
