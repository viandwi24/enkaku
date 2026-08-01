# Lisensi & redistribusi komponen pihak ketiga

Dokumen ini mencatat setiap komponen eksternal yang disentuh Enkaku, statusnya, dan **keputusan distribusi** kita. Audit ini wajib selesai sebelum produk dijual (spec §7.8, §18).

> Status `PERLU REVIEW HUKUM` berarti keputusan teknis sudah diambil, tapi konfirmasi legal manusia belum ada. Jangan menjual sebelum item tersebut ditutup.

## Ringkasan keputusan

| Komponen | Lisensi | Kita redistribusi? | Keputusan |
|---|---|---|---|
| **adb / platform-tools** (Google) | Android SDK Terms of Service | **TIDAK** | Diunduh saat first-run langsung dari `dl.google.com`, diverifikasi sha256. Binary tidak pernah masuk ke image/installer kami. |
| **scrcpy-server.jar** (Genymobile) | Apache-2.0 | Tidak (diunduh dari GitHub Releases resmi) | Apache-2.0 mengizinkan redistribusi dengan atribusi; kita tetap memilih unduh-saat-runtime agar checksum selalu mengacu rilis resmi. Atribusi tetap dicantumkan. |
| **android-uiautomator-server** (openatx) — APK inspector | Perlu dikonfirmasi (repo openatx) | Tidak (diunduh dari GitHub Releases) | **PERLU REVIEW HUKUM**: konfirmasi lisensi repo & syarat redistribusi APK sebelum bundling. Saat ini hanya diunduh runtime. |
| **redroid** (Android in container) | Perlu dikonfirmasi | Tidak | Opsional, dijalankan user sendiri. Ditinjau saat M8. |
| **Bun** (runtime) | MIT | Ya (jika single-binary compile) | MIT — sertakan teks lisensi di distribusi biner. |
| **Dependency npm** | Beragam (mayoritas MIT/Apache-2.0) | Ya (ter-bundle) | Lihat bagian "Dependency npm" di bawah; regenerate tiap rilis. |

## Kenapa adb tidak kami redistribusi

Android SDK Terms of Service membatasi redistribusi komponen SDK. Menghindari perdebatan itu sekaligus lebih aman secara teknis: Toolchain Manager mengunduh platform-tools dari URL resmi Google dan **memverifikasi sha256** sebelum dipakai (spec §7.8), sehingga user selalu mendapat binary asli dari sumbernya.

**Implikasi air-gapped:** instalasi tanpa internet tidak bisa mengambil adb dari Google. Solusinya: sediakan mirror internal dan arahkan `ENKAKU_TOOLS_MANIFEST_URL` ke manifest yang menunjuk mirror tersebut — mengunduh dari mirror internal milik organisasi user adalah keputusan (dan tanggung jawab) mereka, bukan redistribusi oleh kami.

## Atribusi

Produk ini memakai:

- **scrcpy** (© Genymobile, Apache-2.0) — https://github.com/Genymobile/scrcpy
- **Android platform-tools** (© Google) — https://developer.android.com/tools/releases/platform-tools
- **android-uiautomator-server** (openatx) — https://github.com/openatx/android-uiautomator-server

Teks lengkap Apache-2.0 disertakan di `licenses/Apache-2.0.txt` saat rilis.

## Dependency npm

Regenerate daftar ini di setiap rilis dan simpan hasilnya di `licenses/npm.txt`:

```bash
bunx license-checker-rseidelsohn --production --summary
```

Checklist rilis:

- [ ] Tidak ada dependency berlisensi copyleft kuat (GPL/AGPL) di jalur produksi.
- [ ] Semua lisensi MIT/BSD/Apache tercantum atribusinya.
- [ ] `licenses/npm.txt` diperbarui dan ikut dalam artefak rilis.

## Item yang menunggu keputusan manusia

1. Lisensi & syarat redistribusi APK openatx (bundling vs unduh-runtime).
2. Apakah single-binary akan menyertakan teks lisensi Bun + dependency secara otomatis (mekanisme embed).
3. Kebijakan mirror untuk pelanggan air-gapped: kita sediakan atau mereka bangun sendiri.
