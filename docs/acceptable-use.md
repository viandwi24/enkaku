# Acceptable Use Policy (AUP)

Enkaku adalah **device farm untuk QA dan test-automation**: menjalankan pengujian otomatis terhadap aplikasi Android di perangkat fisik. Dokumen ini menetapkan batas pemakaian yang sah dan bagaimana produk mendukungnya secara teknis.

## Untuk apa produk ini dibuat

- Menguji aplikasi **milik Anda sendiri** (atau aplikasi yang Anda punya izin tertulis untuk mengujinya) di banyak perangkat sekaligus.
- Regression test, smoke test, dan uji kompatibilitas lintas versi Android.
- **Menguji sistem deteksi otomasi milik Anda sendiri** (red-team terhadap detektor Anda): menjalankan skenario dari farm, melihat mana yang ter-flag dan mana yang lolos, lalu memperbaiki detektor.

## Yang tidak boleh

- Mengoperasikan akun atau layanan **milik orang lain** tanpa izin, termasuk membuat akun massal, memanipulasi metrik, atau mengakali sistem anti-fraud pihak ketiga.
- Melanggar Terms of Service aplikasi atau layanan yang Anda akses lewat farm.
- Mengakses perangkat yang bukan milik Anda atau bukan di bawah kendali sah Anda.

## Bagaimana produk mendukung batas ini secara teknis

**Instrumentasi, bukan penyamaran.** Trafik yang berasal dari farm **ditandai secara default**. Ini disengaja: kalau Anda memegang dua sisi (detektor dan farm), yang berguna adalah umpan balik — skenario mana yang ter-flag, mana yang lolos — bukan menyembunyikan asal trafik.

**Fitur yang sering disalahpahami:**

- **Input mode UHID** (hardware-like) ada supaya pengujian menempuh **jalur kode aplikasi yang sebenarnya**. Banyak aplikasi memperlakukan input hasil injeksi API berbeda dari sentuhan nyata; menguji lewat jalur yang salah menghasilkan hasil uji yang tidak berarti.
- **Timing jitter** ada karena aplikasi kerap punya jalur berbeda untuk interaksi cepat-robotik dan interaksi manusiawi. Ini praktik QA standar untuk realisme uji, bukan alat penyamaran.

Kedua fitur ini didokumentasikan dalam konteks realisme pengujian. Memakainya untuk mengelabui sistem milik pihak lain adalah pelanggaran AUP ini.

## Perangkat fisik dan privasi

Enkaku bersifat self-hosted: build pre-release, kredensial uji, dan artifact tidak pernah meninggalkan infrastruktur Anda kecuali Anda sendiri yang mengonfigurasinya demikian.

Untuk farm multi-user, aktifkan opsi reset device antar-lease supaya akun dan kredensial tidak bocor antar pengguna.

## Penegakan

Persetujuan atas AUP ini diminta sekali saat pembuatan admin pertama. Pelanggaran yang dilaporkan dapat mengakibatkan pencabutan lisensi komersial.
