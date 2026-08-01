# apps/desktop — aplikasi desktop (Tauri)

Membungkus core + Studio menjadi aplikasi desktop: jendela native, ikon tray, dan core yang dijalankan sebagai proses anak.

## Yang sudah terverifikasi

| Hal | Hasil |
|---|---|
| Build Rust (`cargo build`) | ✅ |
| Jendela terbuka & memuat halaman dari core | ✅ |
| Core dijalankan sebagai proses anak dengan bind `127.0.0.1` | ✅ |
| Pencarian port bebas otomatis (mulai 7700) | ✅ |
| Menunggu `/api/health` sebelum memuat UI; gagal → layar error, bukan jendela putih | ✅ |
| **WebCodecs di WKWebView macOS** | ✅ `VideoDecoder` ada, H.264 baseline didukung |
| Pembersihan proses core yatim setelah aplikasi crash | ✅ diuji: PID lama dimatikan saat start berikutnya |
| Menutup jendela → mengecil ke tray, core tetap hidup | ✅ (perilaku by design) |

Hasil WebCodecs itu penting: aplikasi desktop memakai jalur video scrcpy H.264 yang sama dengan browser — tidak turun ke `screencap-loop` yang hanya 2–3 fps.

## Yang belum

- **Bundling installer** (`.dmg`/`.msi`/`.AppImage`) — perlu ikon asli (sekarang placeholder) dan sertifikat penandatanganan: Apple Developer ID untuk notarization macOS, Authenticode untuk Windows. Keduanya berbiaya tahunan dan butuh keputusan Anda.
- **Auto-update** — konfigurasinya sengaja dilepas dulu karena `pubkey` updater harus dibuat saat rilis pertama. Alur "tunggu job selesai sebelum memasang update" sudah dirancang di plan 14 §4.4.
- **Uji di Windows & Linux** — perlu mesinnya.

## Menjalankan saat pengembangan

```bash
# core dijalankan aplikasi; arahkan ke pembungkus bun bila belum di-compile
ENKAKU_CORE_BIN=/path/ke/enkaku-core bun run --cwd apps/desktop dev
```

## Rilis

```bash
./scripts/build-desktop.sh
```

Skrip ini mem-build Studio, meng-compile core jadi binary tunggal, menaruhnya sebagai sidecar, lalu membundel aplikasi.
