# Plan 15 — M10a : Fondasi desain (Tailwind + shadcn/ui, token, komponen dasar)

> Status: implemented — Tailwind v4 + shadcn/ui foundation, CSS-variable tokens, and the AppShell sidebar frame are built and used across Studio; enum-driven engine dropdowns (`enumSource`), confirm dialogs, and toast feedback are all present. The interface language later settled on English (superseding this plan's Indonesian default, see CLAUDE.md), and design notes now live in `docs/design.md`.
> Ships: packages/studio/src/components/layout/AppShell.tsx
> **Depends on:** Plan 07 (Studio lengkap). **Diikuti oleh:** Plan 16 (perombakan tiap layar).
> **Referensi spec:** §2 (schema-driven UI), §3 (persona end customer), §19 (spec layar).

---

## 1. Audit keadaan sekarang

Bukan opini — ini hasil pemeriksaan langsung terhadap kode dan tampilan berjalan dengan data realistis (4 device beragam status, 3 job selesai, 1 script ter-publish).

### 1.1 Cacat fungsional (bukan sekadar estetika)

| # | Temuan | Bukti | Dampak |
|---|---|---|---|
| F1 | **Field pilihan engine berupa input teks bebas** — user harus mengetik `adb-usb`, `screencap-loop`, `ui-server` dari hafalan | `FarmSettingsSchema` memakai `z.string()`, padahal `GET /api/registry` sudah menyediakan daftar lengkapnya | Salah ketik = setting rusak diam-diam. Ini keluhan utama dan memang paling parah |
| F2 | **Baterai/suhu tidak pernah tampil saat halaman dimuat** | `DeviceInfoSchema` tidak punya field `battery`; badge hanya terisi dari event WS yang datang belakangan | Fitur §15.2 praktis tak terlihat |
| F3 | **Aksi destruktif tanpa konfirmasi** — Hapus script, Hapus versi tool, Cancel job | `grep -c "confirm\|Dialog"` → **0** | Satu salah klik = script hilang permanen |
| F4 | **Kolom Script di halaman Jobs menampilkan UUID mentah** | `1aa42112-85b2-45e1-9bfa-c617bd86cfee` alih-alih `hello-no-device@1.0.0` | Tidak terbaca manusia |
| F5 | **Form debug tampil sebagai UI utama** — "Enqueue internal:sleep" dengan `durationMs` | Halaman Jobs | Alat internal bocor ke pengguna akhir |
| F6 | **Device quarantined tanpa alasan & tanpa jalan keluar** | Kolom `quarantineReason` ada di DB, tidak dipakai UI; endpoint unquarantine tidak punya tombol | Device tersangkut tanpa penjelasan |
| F7 | **Tanpa umpan balik aksi** | `grep -c "toast"` → **0** | Klik tombol, tidak ada tanda berhasil/gagal |

### 1.2 Cacat pengalaman & tampilan

| # | Temuan | Angka |
|---|---|---|
| U1 | **Tidak responsif sama sekali** — nol breakpoint | `grep -c "@media"` → 0 |
| U2 | **Nol atribut aksesibilitas** — tanpa label, tanpa peran, fokus tak terkelola | `grep -c "aria-"` → 0 |
| U3 | **Bahasa campur** dalam satu layar | "Run…", "Disable", "Hapus", "Tutup", "Cancel" berdampingan |
| U4 | **CSS tulis tangan tanpa sistem** | 238 baris, tanpa skala spasi/tipografi, warna ditulis ad-hoc |
| U5 | **Dashboard kosong melompong** | Kartu setinggi 90 px di viewport 868 px — 80% layar tidak terpakai |
| U6 | **Tanpa ringkasan farm** | Tidak ada jumlah device online/sibuk/bermasalah; padahal itu pertanyaan pertama operator |
| U7 | **Tanpa cari/saring/urut** di semua daftar | Tidak terbayang dipakai untuk 10–15 device (target NFR §16) |
| U8 | **Tanpa aksi cepat di kartu device** | Spec §19 mensyaratkan "Quick action: control / run" |
| U9 | **Tautan bergaya bawaan browser** — biru bergaris bawah | Halaman Jobs |
| U10 | **Status kosong/muat/gagal seadanya** | Hanya teks abu-abu satu baris |

### 1.3 Akar penyebab

Tiga hal, dan semuanya keputusan saya di awal:

1. **Tidak ada sistem desain.** Setiap layar menulis gaya sendiri, jadi tidak ada yang konsisten. Membuat komponen baru berarti menulis CSS baru — itu sebabnya semuanya kelihatan seadanya.
2. **Schema tidak membawa cukup informasi.** `z.string()` untuk sesuatu yang sebenarnya punya daftar nilai sah membuat renderer tidak punya pilihan selain memberi kotak teks. Renderer-nya benar; schema-nya yang kurang.
3. **UI dikerjakan untuk membuktikan alur data, bukan untuk dipakai.** Saya berhenti begitu data mengalir benar, dan tidak pernah menanyakan "apa yang dilihat operator pertama kali, dan apa yang ingin dia lakukan detik berikutnya".

## 2. Goals

- Sistem desain nyata: **Tailwind CSS v4 + shadcn/ui**, dengan token warna/spasi/tipografi yang dipakai seluruh layar.
- Pustaka komponen yang cukup untuk seluruh Studio, dengan aksesibilitas bawaan (Radix di balik shadcn): dialog, dropdown, select, tabel, toast, tooltip, tab, sheet.
- **Cacat fungsional F1–F7 tuntas** — terutama dropdown engine yang bersumber dari registry.
- Kerangka layout profesional: sidebar + header, responsif dari 1280 px turun ke tablet.
- Satu bahasa konsisten (Indonesia) untuk seluruh antarmuka.
- Dasar aksesibilitas: fokus terlihat, label pada setiap kontrol, navigasi keyboard berfungsi.

## 3. Non-goals

- **Perombakan tiap layar** → Plan 16. Plan ini menyiapkan fondasi + kerangka; isi layar dirombak menyusul.
- **Mode terang** — farm dipakai di ruangan gelap; token disiapkan agar bisa ditambah, tapi belum dikerjakan.
- **Animasi rumit** — cukup transisi halus bawaan.
- **Rebranding** (logo, nama, ilustrasi) — butuh aset desain.
- **Terjemahan multi-bahasa** — konsistensi dulu, i18n belakangan.

## 4. Keputusan desain

### 4.1 Kenapa Tailwind + shadcn/ui, bukan yang lain

| Pilihan | Alasan ditolak/diterima |
|---|---|
| **Tailwind v4 + shadcn/ui** ✅ | Komponen disalin ke repo (bukan dependency yang mengunci), dibangun di atas Radix sehingga aksesibilitas & keyboard sudah benar, token via CSS variable cocok dengan tema gelap kita |
| MUI / Ant Design | Opini visual sangat kuat dan sulit dilawan; bundle besar; hasilnya "kelihatan MUI", bukan produk kita |
| Lanjut CSS tulis tangan | Persis yang gagal sekarang |
| CSS-in-JS (styled/emotion) | Beban runtime, dan Next App Router lebih ramah CSS statis |

shadcn juga berarti **tidak ada kejutan versi**: komponennya ada di repo kita dan bisa diubah bebas.

### 4.2 Arah visual

Bukan "tema gelap generik". Panduan konkret:

- **Kepadatan informasi tinggi, tenang.** Ini alat kerja yang dipelototi berjam-jam, bukan halaman pemasaran. Kontras dipakai untuk status, bukan untuk hiasan.
- **Warna hanya untuk makna.** Netral untuk kerangka; warna hanya menandai status device dan hasil job. Dengan begitu satu titik merah langsung menarik mata.
- **Angka besar untuk hal yang dipantau** (fps, suhu, jumlah antrian), teks kecil untuk pelengkap.
- **Monospace untuk identitas mesin** (serial, id, path) — sudah dilakukan sekarang dan itu benar, dipertahankan.

### 4.3 Token

```css
/* packages/studio/src/app/globals.css — token, bukan gaya per-komponen */
@theme {
  --color-bg: oklch(0.16 0.008 260);          /* dasar */
  --color-surface: oklch(0.20 0.010 260);     /* kartu */
  --color-surface-2: oklch(0.24 0.012 260);   /* kontrol */
  --color-border: oklch(0.30 0.012 260);
  --color-text: oklch(0.93 0.005 260);
  --color-muted: oklch(0.70 0.010 260);

  /* status — satu-satunya tempat warna jenuh dipakai */
  --color-ok: oklch(0.75 0.16 155);        /* idle, success */
  --color-active: oklch(0.70 0.16 250);    /* manual, running */
  --color-warn: oklch(0.80 0.15 75);       /* suhu tinggi, cancelled */
  --color-danger: oklch(0.65 0.20 25);     /* quarantined, failed */
}
```

OKLCH dipilih karena kecerahannya seragam secara persepsi — status berbeda terasa setara bobotnya, tidak ada yang "meneriaki" yang lain tanpa alasan.

### 4.4 Kerangka layout: sidebar, bukan tab horizontal

Navigasi atas sekarang tidak menyisakan tempat untuk konteks. Gantinya:

```
┌────────────┬──────────────────────────────────────────────┐
│  Enkaku    │  Judul halaman            [aksi utama]       │  ← header per halaman
│            ├──────────────────────────────────────────────┤
│ ▸ Devices 4│                                              │
│ ▸ Scripts 1│   isi                                        │
│ ▸ Jobs    3│                                              │
│ ▸ Tools    │                                              │
│ ▸ Settings │                                              │
│            │                                              │
│ ─────────  │                                              │
│ ● core ok  │  ← status koneksi, versi, mode auth          │
└────────────┴──────────────────────────────────────────────┘
```

Sidebar memberi tiga hal yang sekarang hilang: **jumlah di samping menu** (operator tahu ada 3 job antri tanpa membuka halamannya), tempat permanen untuk **status koneksi core**, dan ruang tumbuh untuk menu baru. Di layar sempit sidebar menjadi laci (sheet).

### 4.5 Memperbaiki F1 dengan benar: schema yang tahu pilihannya

Renderer tidak boleh menebak. Perbaikan dilakukan di sumbernya:

```ts
// packages/protocol/src/settings.ts — SEBELUM
transport: z.string().default('adb-usb')

// SESUDAH: enum + petunjuk sumber daftar untuk UI
transport: z.enum(['adb-usb', 'adb-tcp']).default('adb-usb')
  .describe('Transport default device baru')
  .meta({ enumSource: 'registry.transports' })   // renderer mengambil label & ketersediaan dari /api/registry
```

Dua lapis, sengaja:

1. **Enum di schema** → JSON Schema membawa daftar nilai sah → renderer otomatis membuat dropdown, dan **server menolak nilai di luar daftar**. Ini yang membuat salah ketik jadi mustahil, bukan sekadar tersamarkan.
2. **`enumSource`** → renderer memperkaya dropdown dengan nama tampilan yang enak dibaca ("ADB (USB)"), menandai engine yang belum tersedia sebagai nonaktif beserta alasannya, dan menampilkan konflik lock — semua sudah ada di `/api/registry`.

Kalau `enumSource` tidak dikenal, dropdown tetap jalan memakai enum polos. Perbaikan tidak bergantung pada bagian yang paling rumit.

### 4.6 Aturan yang berlaku untuk semua komponen

Ditulis sebagai aturan supaya Plan 16 tidak perlu memutuskan ulang tiap layar:

- **Setiap daftar punya empat keadaan**: memuat (skeleton, bukan teks "memuat"), kosong (jelaskan cara mengisinya), berisi, gagal (pesan + tombol coba lagi).
- **Setiap aksi destruktif** lewat dialog konfirmasi yang menyebut objeknya ("Hapus script hello-no-device@1.0.0?").
- **Setiap aksi memberi umpan balik** — toast sukses/gagal, dan tombolnya menampilkan status sibuk.
- **Setiap kontrol punya label**; ikon tanpa teks wajib punya tooltip + `aria-label`.
- **Tanpa teks bahasa Inggris di antarmuka** kecuali istilah teknis yang memang tidak diterjemahkan (`idle`, `busy`, nama engine).

## 5. Langkah implementasi

### Tahap 1 — Pasang Tailwind v4 + shadcn/ui

- [ ] `bun add -D tailwindcss @tailwindcss/postcss postcss` di `packages/studio`; `postcss.config.mjs`; `@import "tailwindcss"` di `globals.css`.
- [ ] `bunx shadcn@latest init` (base color neutral, CSS variables). Pastikan tidak menimpa `tsconfig.json` yang sudah disamakan dengan `create-next-app`.
- [ ] Token §4.3 ke `@theme`; hapus CSS lama secara bertahap (jangan sekaligus — layar lama harus tetap jalan sampai Plan 16 selesai).
- **Verifikasi:** `bun dev:studio` naik, halaman lama masih terbaca, kelas Tailwind berfungsi.

### Tahap 2 — Tarik komponen shadcn yang dibutuhkan

- [ ] `button card badge input label select dialog alert-dialog dropdown-menu table tabs tooltip sonner skeleton sheet separator scroll-area switch`
- [ ] Bungkus `<Toaster />` (sonner) di layout root.
- [ ] Varian `Badge` untuk status: `idle | manual | busy | offline | quarantined` dan hasil job `success | failed | cancelled | running | queued` — satu tempat, dipakai semua layar.
- **Verifikasi:** halaman contekan `/dev/kitchen-sink` (hanya mode pengembangan) memuat semua varian.

### Tahap 3 — Kerangka layout

- [ ] `components/layout/AppShell.tsx`: sidebar + header per halaman + area isi.
- [ ] `components/layout/SidebarNav.tsx`: `Link` dengan penanda aktif + jumlah dari `/api/devices` & `/api/jobs`.
- [ ] `components/layout/ConnectionStatus.tsx`: status WS, versi core, mode auth (`local`/`server`) di kaki sidebar.
- [ ] Responsif: sidebar jadi `Sheet` di bawah 1024 px.
- **Verifikasi:** semua halaman lama tetap terbuka di dalam kerangka baru; diuji di 1440/1024/768 px.

### Tahap 4 — Perbaiki F1: enum + `enumSource`

- [ ] Ubah `FarmSettingsSchema` (transport/display/input/inspection) jadi `z.enum` + `.meta({ enumSource })`.
- [ ] `DeviceSettingsSchema.input.preferredMode` sudah enum — pastikan `enumSource: 'registry.inputs'` agar labelnya manusiawi.
- [ ] `SchemaForm`: baca `enumSource`, ambil `/api/registry`, tampilkan `displayName`, nonaktifkan yang `available: false` beserta alasannya.
- [ ] Ganti `<select>` polos dengan `Select` shadcn.
- **Verifikasi:** halaman Settings tidak punya satu pun kotak teks untuk memilih engine; memilih engine yang belum tersedia tidak mungkin dilakukan.

### Tahap 5 — Perbaiki F2: baterai di payload REST

- [ ] Tambah `battery` (nullable) ke `DeviceInfoSchema` dan isi di `rowToDeviceInfo`.
- **Verifikasi:** muat ulang dashboard → badge baterai/suhu langsung tampil tanpa menunggu event.

### Tahap 6 — Perbaiki F3 & F7: konfirmasi dan umpan balik

- [ ] `components/ui/confirm-dialog.tsx` di atas `AlertDialog`; pakai di semua aksi destruktif.
- [ ] Helper `useAction()`: menjalankan aksi, mengelola status sibuk, memunculkan toast sukses/gagal dengan pesan dari server.
- **Verifikasi:** hapus script tanpa konfirmasi menjadi mustahil; setiap aksi memunculkan toast.

### Tahap 7 — Konsistensi bahasa & aksesibilitas

- [ ] Sapu seluruh teks antarmuka ke bahasa Indonesia; kumpulkan di `src/lib/strings.ts` agar tidak menyebar lagi.
- [ ] Setiap `input`/`select` punya `Label` bertaut; ikon punya `aria-label`; cincin fokus terlihat.
- [ ] Telusuri seluruh aplikasi hanya dengan keyboard.
- **Verifikasi:** tidak ada teks Inggris tersisa selain istilah teknis; `grep -c "aria-"` > 0 di semua komponen interaktif.

### Tahap 8 — Bersih-bersih

- [ ] Hapus sisa CSS lama yang sudah tidak dipakai.
- [ ] `docs/design.md`: token, aturan komponen, kapan memakai warna apa.
- **Verifikasi:** `bun run typecheck` hijau, `bun run build:studio` sukses.

## 6. Acceptance criteria

1. [ ] Tailwind v4 + shadcn/ui terpasang; komponen ada di repo, bukan dependency terkunci.
2. [ ] Kerangka sidebar berjalan, dengan jumlah di menu dan status core di kaki.
3. [ ] **Tidak ada satu pun kotak teks untuk memilih engine** — semuanya dropdown, dan nilai di luar daftar ditolak server.
4. [ ] Engine yang belum tersedia tampil nonaktif beserta alasannya, bukan hilang begitu saja.
5. [ ] Badge baterai/suhu tampil pada muat pertama.
6. [ ] Semua aksi destruktif berkonfirmasi; semua aksi bertoast.
7. [ ] Empat keadaan daftar (memuat/kosong/berisi/gagal) tersedia sebagai komponen dan dipakai.
8. [ ] Tanpa teks Inggris di antarmuka selain istilah teknis.
9. [ ] Dapat dioperasikan penuh dengan keyboard; semua kontrol berlabel.
10. [ ] Terbaca di 1440 px, 1024 px, dan 768 px.
11. [ ] `bun run typecheck` hijau dan `bun run build:studio` sukses.

## 7. Test plan

**Visual:** tangkap layar tiap halaman sebelum dan sesudah pada tiga lebar, disimpan di `docs/screenshots/` sebagai pembanding.

**Fungsional:** halaman Settings — coba pilih engine yang belum tersedia (harus tidak bisa); kirim nilai ngawur lewat `curl` langsung ke API (harus ditolak server, membuktikan validasi bukan cuma di UI).

**Keyboard:** Tab menyusuri seluruh sidebar dan isi halaman; Enter/Spasi mengaktifkan; Esc menutup dialog; fokus kembali ke pemicu setelah dialog tertutup.

**Data ekstrem:** 20 device, 200 job, script bernama sangat panjang, device tanpa data baterai — pastikan tata letak tidak rusak.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| shadcn init menimpa tsconfig yang sudah disamakan dengan create-next-app | Error TypeScript 7 vs 5 kambuh | Cadangkan tsconfig sebelum init, bandingkan setelahnya |
| Migrasi setengah jalan membuat dua sistem gaya hidup bersama | Tampilan makin kacau di tengah proses | Kerangka dulu (Tahap 3), isi layar menyusul di Plan 16; CSS lama baru dihapus di akhir |
| Tailwind v4 + Next 15 static export | Build gagal | Uji `build:studio` di Tahap 1, sebelum banyak kode ditulis |
| Mengubah schema ke enum memutus setting yang sudah tersimpan | Boot gagal karena parse | Nilai lama semuanya sah sebagai enum; sediakan fallback ke default bila parse gagal, jangan crash |
| Menambah `battery` ke DeviceInfo memutus konsumen lain | Type error | Field nullable & opsional |

## 9. Open questions

1. **Bahasa antarmuka**: Indonesia sepenuhnya, atau Inggris karena calon pembeli internasional? Plan ini memilih Indonesia karena itu bahasa Anda; ganti keputusan ini sekarang lebih murah daripada nanti.
2. **Nama & logo** — masih "Enkaku" (nama kode di spec). Perlu diputuskan sebelum ada aset visual.
3. **Kepadatan tabel**: nyaman atau rapat? Untuk 15 device rapat lebih berguna, tapi kurang ramah pemula.
4. **Mode terang** — perlu, atau gelap saja cukup?
5. **Thumbnail langsung di dashboard** (spec §19 menyebutnya opsional): sangat membantu secara visual, tapi memaksa stream berjalan untuk semua device sekaligus. Aktifkan di belakang saklar?
