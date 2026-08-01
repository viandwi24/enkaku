# Plan 14 — M9c : Aplikasi desktop (Tauri)

> **Status:** siap dikerjakan. **Depends on:** Plan 09 (single-binary core, Studio static export). Tidak bergantung Plan 12/13.
> **Referensi spec:** §2 (zero-config), §5.1 (shell Tauri), §3 (persona end customer).

---

## 1. Goals

- **Double-click → jalan.** Pengguna tidak membuka terminal, tidak mengetik alamat di browser, tidak menghafal port.
- Jendela native berisi Studio, ikon tray, dan core yang hidup-mati mengikuti aplikasi.
- Auto-update: aplikasi memberi tahu ada versi baru dan memasangnya sendiri.
- Aman secara default: core hanya mendengarkan `127.0.0.1`, sehingga mode auth `local` sah dipakai (tidak ada login, tapi juga tidak terjangkau dari jaringan).

Demo akhir: di mesin bersih tanpa Bun, tanpa adb, tanpa Node — pasang satu file, buka, colok HP, layar tampil.

## 2. Non-goals

- **Mengganti mode server/Docker** — desktop adalah kemasan tambahan untuk pengguna tunggal, bukan pengganti deployment tim.
- **UI khusus desktop** — Studio dipakai apa adanya; tidak ada halaman yang hanya ada di desktop.
- **Auto-update core mode server** — punya jalur sendiri (Docker pull / systemd), di luar lingkup.
- **Distribusi ke App Store** — hanya installer langsung (dmg/msi/AppImage).

## 3. Konteks & keputusan desain

### 3.1 Kenapa Tauri, bukan Electron

Tauri memakai webview bawaan sistem operasi, sementara Electron membawa Chromium sendiri (~150 MB per aplikasi). Untuk aplikasi yang isinya hanya membungkus Studio, ukuran itu tidak masuk akal. Tauri juga memakai Rust, yang berarti binary kecil dan tanpa runtime tambahan.

Konsekuensi yang harus diterima: webview berbeda per OS (WebKit di macOS, WebView2 di Windows, WebKitGTK di Linux). **Ini penting untuk kita** karena Studio memakai WebCodecs untuk decode H.264 — dukungannya tidak merata (lihat §3.4).

### 3.2 Core sebagai proses anak, bukan sidecar ter-bundle

Dua pilihan: (a) core ikut di-bundle sebagai *sidecar binary* di dalam aplikasi, atau (b) aplikasi menjalankan binary core yang dipasang terpisah.

**Keputusan: (a) sidecar ter-bundle.** Alasannya justru tujuan utama plan ini — pengguna cukup memasang satu file. Kalau core harus dipasang terpisah, kita kembali ke masalah yang ingin dihilangkan.

Implikasi: proses rilis desktop harus menjalankan `bun build --compile` untuk tiap platform lebih dulu, lalu menaruh hasilnya di `src-tauri/binaries/` dengan akhiran target (`enkaku-core-aarch64-apple-darwin`, dst.) sesuai konvensi Tauri.

### 3.3 Siklus hidup: aplikasi tutup, core ikut mati

Farm yang menggantung sebagai proses yatim tanpa UI adalah jebakan: pengguna mengira sudah menutup aplikasi, padahal device masih dikuasai. Aturan:

- Jendela ditutup → core dimatikan (SIGTERM, tunggu 5 detik, lalu paksa).
- Menutup jendela **tidak** langsung keluar bila tray aktif — aplikasi mengecil ke tray, core tetap hidup. Keluar hanya lewat menu tray "Quit".
- Aplikasi crash → core yatim. Ditangani dengan menuliskan PID core ke berkas di data dir; saat start berikutnya, PID lama diperiksa dan dimatikan bila masih hidup.

### 3.4 WebCodecs di webview — **sudah diuji, hasilnya lolos**

Studio memakai `VideoDecoder` (WebCodecs) untuk stream scrcpy H.264. Dukungannya:

| Platform | Webview | WebCodecs | Status |
|---|---|---|---|
| macOS | WKWebView (Safari 26.4) | ✅ `VideoDecoder` ada, H.264 baseline didukung | **terverifikasi di aplikasi Tauri sungguhan** |
| Windows | WebView2 (Chromium) | ✅ ada | belum diuji langsung |
| Linux | WebKitGTK | ⚠️ bergantung versi | belum diuji |

Diuji dengan menjalankan aplikasi Tauri hasil build dan memuat halaman probe: `'VideoDecoder' in window` → true, `VideoDecoder.isConfigSupported({codec:'avc1.42e01e'})` → supported.

**Artinya:** jalur video desktop memakai scrcpy H.264 penuh, sama seperti di browser. Tidak perlu decoder wasm maupun membatasi platform.

### 3.5 Auto-update

Tauri updater memeriksa endpoint JSON, mengunduh, memverifikasi tanda tangan, lalu memasang. Yang dibutuhkan: sepasang kunci (dibuat sekali, kunci privat disimpan di CI), endpoint rilis, dan `pubkey` di konfigurasi.

Penting: **auto-update memasang core baru sekaligus** karena core ikut di-bundle. Jadi update harus menunggu tidak ada job berjalan — memutus job di tengah jalan akan meninggalkan device dalam keadaan kotor (melanggar janji `finish` selalu jalan, spec §11.2).

## 4. Desain teknis

### 4.1 Struktur

```
apps/desktop/
  package.json                 # skrip dev/build; devDep @tauri-apps/cli
  src-tauri/
    Cargo.toml                 # BARU — dependensi Rust
    tauri.conf.json            # ADA — perlu dilengkapi (sidecar, updater, tray)
    build.rs                   # BARU
    icons/                     # BARU — ikon aplikasi & tray
    binaries/                  # BARU — core hasil compile per target (tidak di-commit)
    src/
      main.rs                  # ADA — perlu diperluas: sidecar, tray, health-wait, PID
      core_process.rs          # BARU — spawn/stop/health-check core
      tray.rs                  # BARU — menu tray
scripts/
  build-desktop.sh             # BARU — compile core → salin ke binaries/ → tauri build
```

### 4.2 Urutan start

```
Aplikasi dibuka
  → baca <data-dir>/core.pid; kalau prosesnya masih hidup, matikan (sisa crash)
  → jalankan sidecar core: ENKAKU_BIND=127.0.0.1, port dari pencarian port bebas
  → tulis PID baru
  → tunggu GET /api/health mengembalikan ok (timeout 30 detik, poll 250 ms)
      ├ sukses → muat Studio di jendela
      └ gagal  → tampilkan layar error berisi log core (bukan jendela putih)
```

Port dicari secara dinamis (mulai 7700, naik bila terpakai) supaya tidak bentrok dengan core lain yang mungkin sedang berjalan. Port yang terpilih diteruskan ke frontend lewat argumen jendela.

### 4.3 Tray

| Menu | Aksi |
|---|---|
| Buka Enkaku | tampilkan/fokuskan jendela |
| Status | jumlah device online (dari `/api/health`), read-only |
| Buka folder data | membuka data dir di file manager |
| Cek pembaruan | memicu pemeriksaan updater |
| Keluar | konfirmasi bila ada job berjalan, lalu matikan core & keluar |

### 4.4 Update saat ada job berjalan

```
updater menemukan versi baru
  → GET /api/jobs?status=running
      ├ kosong  → pasang sekarang, restart aplikasi
      └ ada job → tampilkan "Update siap, akan dipasang setelah job selesai"
                  → pasang otomatis saat job terakhir selesai, atau saat pengguna memilih "Pasang sekarang"
                    (dengan peringatan bahwa job berjalan akan dibatalkan)
```

## 5. Langkah implementasi

### Tahap 1 — Gerbang: WebCodecs di webview

- [ ] Buat aplikasi Tauri minimal yang memuat halaman uji: laporkan `'VideoDecoder' in window` dan coba `VideoDecoder.isConfigSupported({codec:'avc1.42e01e'})`.
- [ ] Jalankan di macOS (mesin ini) — catat hasilnya. Windows/Linux menyusul bila ada aksesnya.
- **Verifikasi:** hasil tercatat di plan ini sebagai keputusan. Bila tidak didukung, tentukan lebih dulu: decoder wasm atau batasi platform. **Jangan lanjut sebelum ini jelas.**

### Tahap 2 — Scaffold Rust

- [ ] `Cargo.toml`, `build.rs`, ikon; `bunx tauri dev` bisa membuka jendela kosong.
- **Verifikasi:** jendela terbuka di macOS.

### Tahap 3 — Core sebagai sidecar

- [ ] `scripts/build-desktop.sh`: `bun build --compile` core → salin ke `src-tauri/binaries/enkaku-core-<target-triple>`.
- [ ] `core_process.rs`: cari port bebas, jalankan sidecar, tulis PID, tunggu health, matikan saat keluar, bersihkan PID yatim.
- [ ] Layar error yang menampilkan log core bila gagal start.
- **Verifikasi:** `tauri dev` → Studio tampil, `/api/health` hijau, tutup aplikasi → proses core hilang dari `ps`.

### Tahap 4 — Tray & siklus hidup

- [ ] `tray.rs` (§4.3); tutup jendela → mengecil ke tray; Keluar → konfirmasi bila ada job.
- **Verifikasi:** job berjalan lalu tekan Keluar → muncul konfirmasi, bukan langsung mati.

### Tahap 5 — Updater

- [ ] Buat sepasang kunci; simpan privat di luar repo; isi `pubkey` di konfigurasi (mengganti `TODO-verify` yang ada sekarang).
- [ ] Endpoint rilis + alur update-menunggu-job (§4.4).
- **Verifikasi:** dari versi lama ke versi baru di mesin uji.

### Tahap 6 — Packaging & tanda tangan

- [ ] macOS: `.dmg`, penandatanganan + notarization.
- [ ] Windows: `.msi`, sertifikat Authenticode.
- [ ] Linux: `.AppImage`.
- **Verifikasi:** pasang di mesin bersih (tanpa Bun/adb/Node) → farm berfungsi.

### Tahap 7 — Dokumentasi

- [ ] `docs/guide/desktop.md` + perbarui `apps/desktop/README.md`.
- [ ] Catat batasan platform yang ditemukan di Tahap 1.

## 6. Acceptance criteria

1. [ ] Hasil uji WebCodecs per platform tercatat, dan keputusan jalur video desktop diambil berdasarkan itu.
2. [ ] Di mesin bersih: pasang → buka → colok HP → layar tampil, tanpa terminal sama sekali.
3. [ ] Menutup aplikasi mematikan core; tidak ada proses yatim (diuji juga setelah crash paksa).
4. [ ] Port bentrok tertangani otomatis.
5. [ ] Core gagal start → layar error informatif berisi log, bukan jendela putih.
6. [ ] Tray berfungsi; Keluar saat ada job meminta konfirmasi.
7. [ ] Auto-update berhasil dan menunggu job selesai.
8. [ ] Core tetap bind `127.0.0.1` (diperiksa: `lsof` tidak menunjukkan alamat lain).

## 7. Test plan

**Manual di macOS (mesin ini):** seluruh Tahap 1–5.

**Mesin bersih (VM):** tanpa Bun/Node/adb — membuktikan klaim zero-config yang jadi alasan keberadaan plan ini.

**Chaos:** bunuh proses core dari luar (aplikasi harus menampilkan status, bukan diam); bunuh aplikasi dengan `kill -9` lalu buka lagi (PID yatim harus dibersihkan); jalankan dua instans aplikasi.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| WebCodecs tidak ada di WKWebView/WebKitGTK | Video desktop 2–3 fps | Gerbang Tahap 1; siapkan decoder wasm atau batasi platform |
| Notarization/signing macet | Aplikasi tidak bisa dibuka pengguna | Kerjakan lebih awal; sediakan panduan "buka paksa" sementara |
| Binary core besar (Bun ~50–90 MB) | Installer gemuk | Terima; masih jauh di bawah Electron. Ukur & catat |
| Update memutus job | Device tertinggal kotor | Alur §4.4 |
| Proses core yatim | Device dikuasai tanpa UI | Berkas PID + pembersihan saat start |

## 9. Open questions

1. **Ikon & merek** — belum ada aset desain.
2. **Sertifikat penandatanganan**: Apple Developer ID dan sertifikat Windows berbiaya tahunan. Siapa yang mengurus?
3. **Endpoint rilis**: hosting sendiri atau GitHub Releases?
4. **Linux**: AppImage saja, atau `.deb`/Flatpak juga?
5. **Mode desktop untuk tim kecil**: bolehkah desktop membuka bind ke LAN (dengan peringatan bahwa login jadi wajib), atau tetap loopback saja?
