# Plan 16 — M10b : Perombakan tiap layar & alur pengguna

> Status: implemented — every screen described here (dashboard with clickable summary/search/filter/quick actions, device control, jobs, scripts, tools, settings, enrollment) is built in `packages/studio/src/app/`, since extended further by later plans (22, 30, 39, 43, 47).
> Ships: packages/studio/src/app/page.tsx
> **Referensi spec:** §19 (spec layar), §3 (persona), §10.1 (status device), §15.2 (baterai/termal).

---

## 1. Goals

Setiap layar dirancang dari pertanyaan **"apa yang ingin diketahui operator saat membukanya, dan apa tindakan berikutnya"** — bukan sekadar menampilkan isi tabel database.

- Dashboard yang menjawab kondisi farm dalam satu pandangan, dengan aksi cepat ke kontrol dan menjalankan script.
- Layar kontrol device yang terasa seperti memegang perangkatnya, dengan status dan mode input yang jelas.
- Daftar (job, script, tool) yang tetap berguna pada 15 device dan ratusan job: cari, saring, urut.
- Setiap alur kerja punya jalan masuk dan jalan keluar yang jelas — termasuk saat gagal.

## 2. Non-goals

- Fitur baru di luar spec (analitik, penjadwalan berkala, laporan) — di luar lingkup.
- Mengubah kontrak API kecuali yang memang kurang untuk UI (dicatat eksplisit di §4).
- Editor script di dalam Studio — spec §11.5 menempatkan penulisan script di editor milik author sendiri.

## 3. Prinsip yang berlaku di semua layar

1. **Judul menjawab "di mana saya", header menyediakan aksi utama.** Satu aksi utama per layar, sisanya sekunder.
2. **Status ditampilkan, bukan disembunyikan.** Device quarantined harus menunjukkan alasan dan tombol pelepasnya di tempat yang sama.
3. **Kegagalan adalah keadaan yang dirancang**, bukan `alert()` atau teks merah nyasar.
4. **Tidak ada UUID mentah di hadapan pengguna.** Tampilkan nama; sediakan salin-id untuk yang membutuhkan.
5. **Realtime tanpa kedip.** Pembaruan WS mengubah baris di tempat, tidak memuat ulang daftar.

## 4. Rancangan per layar

### 4.1 Dashboard (`/`)

**Pertanyaan operator:** berapa yang siap dipakai, adakah yang bermasalah, dan mana yang mau saya buka.

```
┌─────────────────────────────────────────────────────────────┐
│  Devices                            [Tambah device]         │
│  ┌────────┬────────┬────────┬────────┐                      │
│  │ 4      │ 1      │ 1      │ 1      │  ← ringkasan; klik   │
│  │ total  │ siap   │ sibuk  │ perlu  │    = filter          │
│  │        │        │        │ perhatian                     │
│  └────────┴────────┴────────┴────────┘                      │
│  [cari…]  [status ▾]  [urut ▾]              ⊞ kartu │ ☰ tabel│
│                                                             │
│  ┌───────────────────────┐ ┌───────────────────────┐        │
│  │ Galaxy S21      idle  │ │ Pixel 7        busy   │        │
│  │ Android 14 · 1080×2400│ │ Android 15 · 1080×2400│        │
│  │ 🔋82% · 31,5°C        │ │ 🔋45% · 47,2°C ⚠      │        │
│  │ [Kontrol] [Jalankan…] │ │ menjalankan: post-x   │        │
│  └───────────────────────┘ └───────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

Keputusan:

- **Kartu berukuran cukup** untuk memuat status, kesehatan, dan dua aksi — bukan kartu 90 px yang sekarang menyisakan 80% layar kosong.
- **Ringkasan yang bisa diklik** merangkap filter; "perlu perhatian" = quarantined + offline + suhu di atas ambang.
- **Kartu sibuk menampilkan job yang sedang berjalan** dan tautan ke detailnya — menjawab "kenapa device ini tidak bisa saya pakai".
- **Kartu quarantined menampilkan alasan** (`thermal:49,8°C`) dan tombol "Lepas karantina" dengan konfirmasi.
- **Tampilan tabel** sebagai alternatif untuk operator yang mengelola belasan device.
- Kartu offline diredupkan tapi **tetap bisa dibuka** untuk melihat riwayat dan pengaturannya.

Butuh dari API: `battery` di `DeviceInfo` (Plan 15 Tahap 5), `quarantineReason`, dan job yang sedang berjalan per device (`GET /api/jobs?status=running` sudah cukup).

### 4.2 Kontrol device (`/device?id=`)

**Pertanyaan operator:** apa yang tampil di layar HP, dan bisakah saya menyentuhnya sekarang.

```
┌──────────────────────────────────────────────────────────────┐
│ ← Galaxy S21   [idle]              [Ambil kontrol]           │
├───────────────────────────────┬──────────────────────────────┤
│                               │ Sesi                         │
│                               │  Display   scrcpy (H.264)    │
│        [ layar device ]       │  Input     UHID ✓ hardware   │
│                               │  Inspector ui-server         │
│                               │  Jalur     WebRTC · 28 fps   │
│                               ├──────────────────────────────┤
│                               │ Kesehatan                    │
│                               │  🔋 82% mengisi · 31,5°C     │
│  ◀ Back  ● Home  ■ Recents    ├──────────────────────────────┤
│                               │ Aksi cepat                   │
│  Klik=tap · seret=geser       │  [Jalankan script…]          │
│                               │  [Screenshot] [Bersihkan]    │
│                               │  [Pengaturan device]         │
└───────────────────────────────┴──────────────────────────────┘
```

Keputusan:

- **Panel sesi menampilkan engine yang benar-benar aktif**, termasuk saat turun kelas ("UHID tidak tersedia di API 28 → SDK"). Sekarang informasi ini hanya ada di log server, padahal penting: operator perlu tahu input yang dikirim hardware-like atau tidak (spec §9).
- **Keadaan kontrol dibuat eksplisit** lewat tiga tampilan berbeda: belum ambil kontrol (kanvas diredupkan + ajakan), memegang kontrol (aktif penuh), device sibuk (spanduk "otomasi berjalan — hanya menonton", video tetap jalan sesuai spec §10.1).
- **Lease terlihat**: sisa waktu sebelum lepas otomatis, dengan tombol perpanjang. Sekarang lease bisa lepas diam-diam dan operator tidak tahu kenapa kontrolnya hilang.
- Ketikan diarahkan ke device dengan penanda jelas saat kanvas fokus.

### 4.3 Jobs (`/jobs`)

**Pertanyaan operator:** apa yang sedang berjalan, apa yang gagal, kenapa.

- **Form debug `internal:sleep` dipindah** ke halaman pengembang (`/dev/tools`, hanya tampil saat mode pengembangan). Ini alat internal dan tidak boleh jadi hal pertama yang dilihat pengguna.
- Kolom Script menampilkan **`nama@versi`**, bukan UUID.
- **Saring** berdasarkan status dan device; **cari** berdasarkan nama script; urut waktu.
- Job berjalan tampil di **atas dengan indikator fase** (`prepare → run → finish`) dan durasi berjalan.
- Waktu relatif ("2 menit lalu") dengan waktu persis di tooltip.
- Baris gagal menampilkan **potongan pesan error** langsung, tanpa harus membuka detail.
- Aksi massal: batalkan beberapa job antri sekaligus.

### 4.4 Detail job (`/jobs/detail?id=`)

- **Garis waktu fase** di atas: prepare/run/finish dengan durasi masing-masing — langsung terlihat di mana waktunya habis.
- Log dengan **saring level** dan sumber (script/stdout/runner), pencarian, dan gulir-otomatis yang bisa dimatikan.
- **Artifact sebagai galeri** dengan pratinjau gambar; klik untuk memperbesar; ukuran & waktu terbaca.
- Panel parameter & hasil dalam JSON yang tersorot, bukan teks polos.
- Untuk job yang gagal: error ditampilkan **paling atas**, bukan tercampur di tengah log.

### 4.5 Scripts (`/scripts`)

- Dikelompokkan per **nama**, dengan versi sebagai riwayat yang bisa dibuka — bukan satu baris per versi yang membanjiri daftar.
- Menjalankan script memakai **dialog**: pilih device (hanya yang siap), isi parameter (form dari schema), lalu jalankan. Sekarang panelnya muncul di bawah daftar dan mudah terlewat.
- Menampilkan **riwayat job** per script: kapan terakhir dijalankan, berapa yang sukses.
- Hapus dan nonaktifkan berkonfirmasi, dengan peringatan bila ada job antri yang memakainya.
- Keadaan kosong menjelaskan cara mem-publish, lengkap dengan perintah yang bisa disalin.

### 4.6 Tools (`/tools`)

- Tiap tool jadi **kartu**: versi aktif, kesehatan, dan versi tersedia.
- **Progres unduh sebagai progress bar** dengan persentase dan ukuran, bukan teks berubah-ubah.
- `scrcpy-server` dan `ui-server` ditandai **"dikelola core"** beserta penjelasan singkat kenapa versinya tidak bisa dipilih (spec §7.6) — sekarang hanya ada label tanpa alasan.
- Riwayat: kapan tool ini diaktifkan, oleh siapa (dari audit log).

### 4.7 Settings (`/settings`)

- **Tab**: Umum · Device default · Baterai & termal · Retensi · Pengguna · Audit.
- Semua pilihan engine berupa **dropdown dari registry** (Plan 15 Tahap 4), lengkap dengan penjelasan singkat tiap engine.
- Perubahan **tidak langsung tersimpan**: tombol Simpan/Batal muncul saat ada perubahan, dengan peringatan bila hendak meninggalkan halaman.
- Nilai yang berbeda dari bawaan diberi penanda, dengan tombol "kembalikan ke bawaan".
- Tab Audit menampilkan log yang selama ini hanya ada di API.

### 4.8 Enrollment (dialog, bukan panel)

- Wizard **berlangkah**: pilih cara (USB / wireless) → ikuti instruksi → tunggu terdeteksi → selesai.
- Langkah USB **memantau kedatangan device** dan otomatis maju saat terdeteksi — sekarang pengguna harus menebak sendiri kapan berhasil.
- Langkah wireless menjelaskan beda **port pairing dan port connect** dengan gambar posisinya di layar HP; ini sumber kebingungan yang paling sering.
- Kegagalan menampilkan pesan asli dari adb **beserta terjemahan maksudnya**.

## 5. Langkah implementasi

Dikerjakan per layar, masing-masing selesai utuh sebelum lanjut — supaya aplikasi tidak pernah dalam keadaan setengah dirombak.

### Tahap 1 — Komponen bersama antarlayar
- [ ] `DataTable` (saring, urut, cari, kosong/muat/gagal), `PageHeader`, `StatCard`, `RelativeTime`, `CopyableId`, `EmptyState`, `ErrorState`.
- **Verifikasi:** dipakai minimal dua layar tanpa penyesuaian khusus.

### Tahap 2 — Dashboard (§4.1)
- [ ] Ringkasan yang bisa diklik, kartu baru, tampilan kartu/tabel, cari & saring, aksi cepat, kartu quarantined dengan alasan + pelepas.
- **Verifikasi:** dengan 4 device beragam status, semua informasi terbaca tanpa membuka halaman lain.

### Tahap 3 — Kontrol device (§4.2)
- [ ] Tata letak dua kolom, panel sesi dengan engine efektif, keadaan kontrol yang eksplisit, hitung mundur lease.
- [ ] Core: sertakan engine efektif & alasan degrade pada `stream.started` (sebagian sudah ada di mode cloud, samakan untuk lokal).
- **Verifikasi:** ketiga keadaan (belum kontrol / memegang / sibuk) tampil benar dan berpindah otomatis.

### Tahap 4 — Jobs & detail (§4.3, §4.4)
- [ ] Pindahkan form debug ke `/dev/tools`; nama script menggantikan UUID; saring/cari; garis waktu fase; galeri artifact.
- [ ] Core: `GET /api/jobs` menyertakan `scriptName` & `scriptVersion` (hindari N+1 di klien).
- **Verifikasi:** dengan 200 job, halaman tetap responsif dan pencarian terasa instan.

### Tahap 5 — Scripts (§4.5)
- [ ] Pengelompokan per nama, dialog jalankan, riwayat job per script, konfirmasi hapus.
- **Verifikasi:** menjalankan script dari dialog menghasilkan job yang benar dengan parameter yang benar.

### Tahap 6 — Tools (§4.6)
- [ ] Kartu per tool, progress bar, penjelasan "dikelola core".
- **Verifikasi:** install versi baru menampilkan progres yang bergerak mulus sampai selesai.

### Tahap 7 — Settings (§4.7)
- [ ] Tab, dropdown dari registry, pola simpan/batal, penanda nilai non-bawaan, tab audit.
- **Verifikasi:** mengubah lalu membatalkan mengembalikan nilai semula; meninggalkan halaman dengan perubahan tertahan memunculkan peringatan.

### Tahap 8 — Enrollment (§4.8)
- [ ] Dialog berlangkah, deteksi otomatis USB, penjelasan port wireless.
- **Verifikasi:** dengan device fisik, alur USB maju sendiri setelah tap Allow.

### Tahap 9 — Pemolesan
- [ ] Sapuan responsif di semua layar; audit keyboard; tangkap layar sebelum/sesudah untuk dokumentasi.
- **Verifikasi:** seluruh acceptance criteria §6.

## 6. Acceptance criteria

1. [ ] Dashboard menjawab "berapa siap / sibuk / bermasalah" tanpa berpindah halaman.
2. [ ] Aksi cepat kontrol & jalankan tersedia di kartu device (spec §19).
3. [ ] Device quarantined menampilkan alasan dan cara melepasnya.
4. [ ] Layar kontrol menampilkan engine efektif, termasuk saat turun kelas.
5. [ ] Tiga keadaan kontrol tampil benar dan berpindah otomatis.
6. [ ] Sisa waktu lease terlihat; kontrol tidak pernah lepas tanpa penjelasan.
7. [ ] Tidak ada UUID mentah di layar mana pun.
8. [ ] Form debug `internal:sleep` tidak tampil di UI pengguna.
9. [ ] Semua daftar punya cari + saring dan tetap enak dipakai pada 200 baris.
10. [ ] Detail job menampilkan garis waktu fase dan galeri artifact.
11. [ ] Settings memakai tab dan pola simpan/batal; tidak ada perubahan yang tersimpan tanpa disengaja.
12. [ ] Enrollment USB maju otomatis saat device terdeteksi.
13. [ ] Semua layar terbaca di 1440/1024/768 px dan bisa dioperasikan dengan keyboard.

## 7. Test plan

**Berbasis skenario**, bukan per komponen — tiap skenario ditelusuri dari awal sampai selesai:

1. *"Device baru sampai di meja."* Colok → wizard muncul → Allow di HP → device tampil siap → buka kontrol → tap.
2. *"Kenapa device ini tidak bisa dipakai?"* Buka dashboard → lihat sibuk → lihat job berjalan → buka detail → lihat log → batalkan → device siap lagi.
3. *"Device panas."* Suhu melewati ambang → quarantined dengan alasan → operator memeriksa → lepas karantina.
4. *"Menjalankan script baru."* Publish dari CLI → tampil di Scripts → dialog jalankan dengan parameter → pantau di Jobs → periksa artifact.
5. *"Salah klik."* Tekan Hapus di script → konfirmasi muncul → batal → tidak ada yang hilang.

**Beban:** 20 device, 200 job, 30 versi script — periksa pencarian, gulir, dan waktu render.

**Keyboard & pembaca layar:** telusuri skenario 1 dan 4 tanpa menyentuh tetikus.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Perombakan sekaligus membuat aplikasi tak terpakai di tengah jalan | Tidak bisa diuji | Satu layar selesai utuh sebelum lanjut |
| Menyembunyikan form debug menyulitkan pengujian saya sendiri | Kehilangan alat | Dipindah, bukan dihapus: `/dev/tools` saat mode pengembangan |
| Perlu perubahan API di tengah pekerjaan UI | Pekerjaan terhenti | Kebutuhan API sudah dikumpulkan di §4 dan dikerjakan lebih dulu tiap tahap |
| Rancangan hanya bagus untuk data contoh | Rusak di dunia nyata | Uji beban dengan nama panjang, data kosong, dan status janggal |

## 9. Open questions

1. **Thumbnail langsung di dashboard** — sangat membantu, tapi memaksa banyak stream berjalan. Aktifkan hanya saat kartu terlihat di layar, atau di belakang saklar?
2. **Kepadatan bawaan** tabel: rapat atau nyaman?
3. **Apakah operator butuh melihat job milik orang lain?** Berkaitan dengan ACL Plan 09 dan mempengaruhi saringan bawaan di halaman Jobs.
4. **Riwayat device** (kapan online, berapa job dijalankan) — berguna, tapi butuh tabel baru. Masuk lingkup atau nanti?
5. **Notifikasi** saat job selesai / device bermasalah: cukup toast, atau perlu pemberitahuan sistem?
