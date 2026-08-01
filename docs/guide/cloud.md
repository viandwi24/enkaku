# Mode cloud

Control plane di server, perangkat tetap di lokasi Anda. Agent membuka koneksi **keluar** ke control plane, jadi tidak perlu port-forward dan NAT bukan masalah.

```
HP ──USB/WiFi── Agent ──tunnel keluar (WSS)──► Control plane ◄──browser
   (kantor/rumah, di balik NAT)                  (VPS)
```

## Menjalankan control plane

```bash
ENKAKU_MODE=orchestrator ENKAKU_BIND=0.0.0.0 ENKAKU_TLS_MODE=external bun run dev
```

Mode orchestrator tidak menyentuh adb sama sekali — semua perangkat datang dari agent.

## Mendaftarkan agent

1. Di control plane: `POST /api/agents` dengan `{ "name": "lab-jakarta" }` → menghasilkan **token sekali pakai** (hanya ditampilkan sekali).
2. Di mesin dekat perangkat:

```bash
ENKAKU_CP_URL=https://farm.example.com \
ENKAKU_ENROLL_TOKEN=<token> \
ENKAKU_DATA_DIR=/var/lib/enkaku-agent \
bun run packages/agent/src/index.ts
```

Token ditukar dengan credential jangka panjang yang disimpan di `<data-dir>/agent.json`. Selanjutnya agent dijalankan tanpa token.

## Yang berfungsi

Perangkat milik agent diperlakukan sama seperti perangkat lokal di Studio: terlihat di dashboard, layarnya bisa dilihat dan disentuh, dan script bisa dijalankan padanya. Job **dieksekusi di agent** — dekat perangkat, sehingga query inspector tidak melintasi internet berkali-kali; hanya log, artifact, dan hasil akhir yang melewati tunnel.

Keputusan tetap di control plane: lease, antrian, penolakan input saat perangkat sibuk. Agent hanya mengeksekusi.

## Saat tunnel putus

Perangkat milik agent ditandai offline, sesi dibatalkan, dan job yang sedang berjalan gagal lewat mekanisme lease-expiry biasa. Permintaan berikutnya dijawab error yang jelas (`agent_offline`), bukan menggantung. Agent menyambung ulang sendiri dengan jeda yang meningkat bertahap.

## Batasan saat ini

Video melewati tunnel WebSocket. Untuk agent di jaringan yang sehat ini memadai, tapi di internet dengan kehilangan paket, TCP menahan seluruh aliran sampai paket dikirim ulang — layar bisa membeku sesaat. Jalur WebRTC menangani ini (lihat `docs/plans/13-m9-webrtc-backend.md`).
