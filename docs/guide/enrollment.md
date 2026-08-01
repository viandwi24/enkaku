# Panduan enrollment device

Satu HP = satu record, apa pun cara koneksinya. Enkaku memakai **identitas stabil** (serial hardware, fallback ANDROID_ID), bukan alamat adb — jadi HP yang sama lewat USB lalu WiFi tidak menjadi dua device.

## USB

1. Di HP: Settings → About phone → tap "Build number" 7× untuk membuka Developer options.
2. Developer options → aktifkan **USB debugging**.
3. Colok ke mesin yang menjalankan core.
4. Layar HP menampilkan dialog "Allow USB debugging?" → centang **Always allow from this computer** → **Allow**.
5. Device muncul di Studio dengan status `idle`. Selesai — tidak ada langkah tambahan.

Kalau di Studio device tampak `unauthorized`, dialog di langkah 4 belum disetujui.

## Wireless (Android 11+)

Wireless debugging memakai **dua port berbeda**: satu untuk pairing (sekali pakai, berubah tiap kali layar dibuka) dan satu untuk koneksi.

1. Developer options → **Wireless debugging** → aktifkan.
2. Tap **Pair device with pairing code**. Layar menampilkan IP, port pairing, dan kode 6 digit. **Biarkan layar ini terbuka** — menutupnya membatalkan kode.
3. Di Studio: Devices → **Tambah device** → isi IP, port pairing, kode 6 digit.
4. Isi juga **connect port** (angka yang tertera di layar utama Wireless debugging, berbeda dari port pairing).
5. Tekan **Pair & connect**.

Kalau gagal, pesan asli dari adb ditampilkan apa adanya di wizard — biasanya penyebabnya kode kedaluwarsa atau port pairing sudah berubah.

## Dari USB ke wireless

Enroll lewat USB dulu, lalu pindah ke wireless. Karena identitas device diambil dari serial hardware, record-nya tetap satu; hanya kolom alamat transport yang berubah.

## Baterai dan panas

Farm yang di-charge terus-menerus berisiko baterai kembung. Core memantau suhu tiap perangkat dan **mengeluarkan device yang terlalu panas dari antrian** secara otomatis (status `quarantined`). Ambang suhu dan interval poll bisa diubah di Settings. Device yang di-quarantine dilepas kembali secara manual setelah Anda memeriksanya.
