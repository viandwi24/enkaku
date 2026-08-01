# Device cloud tanpa HP fisik (redroid)

[redroid](https://github.com/remote-android/redroid-doc) menjalankan Android di dalam container. Enkaku memperlakukannya persis seperti device fisik lewat transport `adb-tcp` — tidak ada kode khusus.

```bash
docker run -itd --rm --privileged \
  -v ~/redroid-data:/data \
  -p 5555:5555 \
  redroid/redroid:14.0.0-latest

# daftarkan ke farm: Studio → Tambah device → wireless, host 127.0.0.1 port 5555
```

## Kapan ini masuk akal — dan kapan tidak

**Cocok untuk:** throughput test, uji alur yang tidak menyentuh sensor, dan menambah kapasitas antrian tanpa membeli perangkat.

**Tidak cocok untuk:** apa pun yang bergantung pada karakteristik perangkat nyata. redroid adalah emulator, jadi banyak deteksi otomasi sederhana langsung menandainya: tidak ada sensor asli (accelerometer/gyro), IMEI/serial bukan hardware, properti emulator terbaca, dan sentuhan tidak berasal dari driver input fisik.

Untuk pengujian yang butuh "perangkat asli" — termasuk menguji detektor otomasi Anda sendiri — gunakan HP fisik. Itu justru keunggulan struktural farm perangkat nyata dibanding emulator.
