# Konsep & Plan: Apply Proxy ke Android Emulator via ADB

Dokumen ini merangkum hasil analisis + riset untuk kebutuhan **uji coba apply proxy
ke emulator Android lewat adb**, dengan bantuan host diperbolehkan, dan syarat
**tidak mengganggu instance/aplikasi lain**. Fokusnya: memilih pendekatan yang
tepat, memahami trade-off masing-masing, dan menyediakan blueprint implementasi
yang bisa langsung dikerjakan.

---

## 1. Ringkasan Keputusan

Ada empat pendekatan realistis. Tidak ada yang "paling benar" secara mutlak —
pemilihan bergantung pada dua pertanyaan: (a) apakah proxy kamu HTTP atau SOCKS5,
dan (b) apakah butuh SEMUA traffic lewat proxy (termasuk app yang buka socket
sendiri) atau cukup traffic yang patuh system-proxy.

| # | Pendekatan | Install app? | Root? | Protokol | Cakupan traffic | Cocok untuk |
|---|-----------|:---:|:---:|----------|-----------------|-------------|
| 1 | `settings put global http_proxy` | Tidak | Tidak | HTTP saja | App yang patuh system proxy | **Uji coba cepat** |
| 2 | Emulator flag `-http-proxy` | Tidak | Tidak | HTTP (+auth) | Semua TCP keluar (via QEMU) | Per-instance saat boot |
| 3 | App VPN-based (sing-box SFA / ProxyDroid / sockstun) | Ya (APK) | Tidak | SOCKS5/HTTP/dll | SEMUA traffic (TUN) | **Produksi / phone farm** |
| 4 | Binary `sing-box` di shell | Tidak (push binary) | Ya | Semua | SEMUA (TUN) | Headless penuh, device root |

**Rekomendasi bertahap:**

- **Sekarang (uji coba):** mulai dari **Pendekatan 1**. Nol instalasi, satu baris
  adb, gampang di-revert. Kalau proxy kamu SOCKS5, tambahkan **converter di host**
  (lihat §5).
- **Produksi phone farm:** naik ke **Pendekatan 3 dengan sing-box (SFA)**. Config
  berbasis file JSON jauh lebih ramah otomasi daripada SharedPreferences milik
  ProxyDroid, protokolnya lengkap, dan satu ekosistem dengan NekoBox yang sudah
  kamu pakai (keduanya berbasis core sing-box dari nekohasekai).

---

## 2. Analisis Tiap Pendekatan

### Pendekatan 1 — `settings put global http_proxy` (tanpa app, tanpa root)

Perintah inti:

```bash
adb -s <serial> shell settings put global http_proxy <host>:<port>
adb -s <serial> shell settings put global http_proxy :0   # matikan / reset
```

- Ini menulis ke setting global Android yang sama yang dihormati sistem setelah
  perubahan jaringan; nilai `:0` langsung berlaku tanpa restart device. Karena
  itulah metode ini yang lazim dipakai di CI dan device farm.
- **Wajib reset ke `:0` setelah selesai** — kalau dibiarkan, emulator bisa
  kehilangan akses internet saat proxy dimatikan.
- **Keterbatasan penting:**
  - Hanya **HTTP proxy**, bukan SOCKS5.
  - Field bawaan Android ini **tidak mendukung autentikasi** user/password.
  - Hanya app yang patuh system proxy yang lewat; app yang buka socket sendiri
    (banyak game / app deteksi-proxy) bisa bypass.
- **Tidak mengganggu instance lain:** setting ini per-device (per-serial), jadi
  aman untuk multi-emulator selama kamu selalu targetkan `-s <serial>`.

### Pendekatan 2 — Emulator flag `-http-proxy` (tanpa app, tanpa root)

```bash
emulator @MyAvd -http-proxy http://<host>:<port>
emulator @MyAvd -http-proxy http://<user>:<pass>@<host>:<port>   # dengan auth
```

- Formatnya `http://host:port` atau `http://username:password@host:port` — jadi
  **mendukung auth**, berbeda dari Pendekatan 1.
- Flag ini memaksa emulator melewatkan **semua koneksi TCP keluar** lewat proxy,
  tapi **UDP tidak di-redirect**.
- Karena tunneling terjadi di **layer QEMU sebagai raw TCP**, HTTPS tidak bisa
  didekripsi di level ini, dan QUIC / DNS-over-HTTPS bisa lolos dari proxy.
- **Kelemahan:** harus di-set saat boot (bukan runtime), dan hanya untuk emulator
  (bukan device fisik).
- **Tidak mengganggu instance lain:** murni per-proses emulator.

### Pendekatan 3 — App VPN-based (sing-box SFA / ProxyDroid / sockstun)

Semua app ini bekerja di level **TUN via VpnService** — artinya SEMUA traffic
benar-benar ditangkap dan diteruskan ke proxy, app tidak bisa bypass. **Tanpa root.**

Perbandingan kandidat:

- **sing-box (SFA)** — paling direkomendasikan.
  - Package: `io.nekohasekai.sfa`. Repo resmi: `SagerNet/sing-box-for-android`.
  - Config = **satu file JSON** (inbound TUN + outbound apa saja). Jauh lebih
    bersih untuk otomasi per-device daripada SharedPreferences.
  - Satu runtime mendukung banyak protokol: SOCKS5, HTTP, Shadowsocks, VMess,
    Trojan, WireGuard, Hysteria2, VLESS Reality, dll.
  - Distribusi lengkap: GitHub Releases (APK per-ABI: `x86_64` untuk AVD standar,
    plus `arm64-v8a`, `armeabi-v7a`, `x86`, universal — semua dengan SHA-256) dan
    F-Droid (di-build & ditandatangani developer asli, min Android 6.0).
  - Satu ekosistem dengan NekoBox (frontend di atas core sing-box).
  - Catatan: pernah ada laporan crash di sebagian device — tetap perlu diuji di
    setup kamu.
- **ProxyDroid (v3.4.0)** — VPN-first, tanpa root, TUN via Rust tun2socks.
  - Upstream: SOCKS5 (opsional auth) dan HTTP CONNECT (opsional Basic auth).
  - Config lewat SharedPreferences → key harus di-discover dulu, kurang ramah
    otomasi dibanding JSON sing-box.
- **sockstun (heiher)** — ringan, VPN over SOCKS5 berbasis hev tun2socks.
  - Redirect TCP + UDP (fullcone NAT), mode global/per-app, DNS custom.
  - Bagus kalau kebutuhannya murni SOCKS5 dan mau footprint minimal.

**Tantangan headless untuk kelas ini:** meng-inject config + start service TANPA
menyentuh UWI tetap butuh salah satu dari: `adb root` (untuk tulis internal
storage app), atau UI-automation (`adb shell input`), atau — untuk sing-box —
config remote via URL yang di-fetch app. Detail di §4.

**Batasan penting VpnService:** Android hanya mengizinkan **satu VPN aktif per
profil**. Jadi kalau NekoBox sudah jalan di emulator yang sama, dia dan
SFA/ProxyDroid akan saling menendang. Pilih salah satu per device.

### Pendekatan 4 — Binary `sing-box` langsung di shell (butuh root)

Push executable `sing-box` (Go, static) ke `/data/local/tmp`, jalankan dari adb
shell dengan config JSON. Tanpa APK sama sekali. Tapi membuka TUN device butuh
**root** — hanya jalan di emulator non-Google-Play (`adb root` tersedia) atau
device rooted. Paling "bersih" untuk headless penuh, tapi paling menuntut secara
privilege.

---

## 3. Soal `adb root` (klarifikasi)

`adb root` **bukan** nge-root device (bukan Magisk, tidak unlock bootloader). Ia
hanya me-restart daemon `adbd` agar jalan sebagai user `root`, bukan user `shell`
biasa. Efeknya: shell adb berikutnya bisa akses area privat seperti
`/data/data/<pkg>/`.

- Berhasil hanya di build yang mengizinkan: **emulator AVD non-Google-Play**, ROM
  `userdebug`/`eng`, atau custom ROM tertentu.
- Di device retail & emulator image Google Play → ditolak dengan
  `adbd cannot run as root in production builds`.
- **Implikasi untuk plan ini:** kalau mau injeksi config app secara headless
  (Pendekatan 3) atau jalankan binary (Pendekatan 4), pilih **AVD image
  non-Google-Play** supaya `adb root` tersedia. Untuk Pendekatan 1 & 2, root tidak
  diperlukan sama sekali.

---

## 4. Strategi Headless untuk sing-box SFA

Tiga jalur meng-apply config tanpa (atau dengan minimal) sentuhan UI:

1. **`adb root` + tulis internal storage** — inject file profil sing-box ke data
   dir app, lalu start service. Paling deterministik, tapi butuh `adb root`
   (AVD non-Play).
2. **Config remote via URL** — SFA bisa menjalankan config **remote**. Host-kan
   `config.json` di server kecil, daftarkan URL profil-nya sekali, lalu tiap
   device tinggal fetch. Bagus untuk farm karena update config terpusat.
3. **UI-automation** (`adb shell input tap/text` atau uiautomator) — tanpa root,
   tapi rapuh terhadap perubahan UI dan lambat untuk device banyak.

Untuk **auto-grant izin VPN** (menghilangkan dialog "Connection request"):

```bash
adb -s <serial> shell appops set <pkg> ACTIVATE_VPN allow
adb -s <serial> shell cmd appops get <pkg> ACTIVATE_VPN   # verifikasi
```

Ini trik yang sama dipakai komunitas untuk meng-allow VpnService tanpa dialog.
Catatan: normalnya sistem menampilkan connection-request dialog sebelum VPN app
aktif pertama kali; `appops ... allow` mem-bypass langkah itu.

---

## 5. Pola "Bantuan Host" (untuk proxy SOCKS5)

Karena Pendekatan 1 & 2 hanya bicara HTTP, sedangkan proxy kamu mungkin SOCKS5,
pola paling bersih: **jalankan converter kecil di host** yang menerima HTTP dan
meneruskan ke SOCKS5 upstream (mis. `gost`, atau `sing-box`/`clash` mode CLI di
PC). Lalu arahkan emulator ke alamat host.

**Alamat host dari dalam emulator:**

- Android Emulator standar (QEMU): host loopback = **`10.0.2.2`**.
- Genymotion (VirtualBox lama): `10.0.3.2`.
- Alternatif universal: `adb reverse tcp:<devicePort> tcp:<hostPort>` lalu pakai
  `127.0.0.1:<devicePort>` di device.

Contoh alur: converter host listen HTTP di `0.0.0.0:8888` → SOCKS5 upstream →
emulator di-set `http_proxy 10.0.2.2:8888`.

---

## 6. Blueprint Implementasi (yang harus dikerjakan dengan adb)

### Fase A — Uji coba cepat (Pendekatan 1)

Langkah yang diotomasi via adb:

1. **Resolusi device**: `adb devices`; kalau serial berbentuk `ip:port` →
   `adb connect <serial>` dulu (relevan untuk device jaringan / farm).
2. **Set proxy**: `adb -s <serial> shell settings put global http_proxy <host>:<port>`.
3. **Verifikasi**: `adb -s <serial> shell settings get global http_proxy` →
   pastikan nilainya sesuai.
4. **Uji koneksi**: jalankan request dari device (mis. buka URL via
   `am start -a android.intent.action.VIEW -d http://example.com`) dan amati di
   sisi proxy/converter apakah traffic masuk.
5. **Reset**: `adb -s <serial> shell settings put global http_proxy :0`.

Semua langkah selalu pakai `-s <serial>` → dijamin tidak menyentuh instance lain.

### Fase B — Produksi (Pendekatan 3, sing-box SFA)

1. **Pilih AVD non-Google-Play** (agar `adb root` tersedia untuk injeksi config).
2. **Install APK** sesuai ABI:
   `adb -s <serial> install -r -g SFA-<ver>-x86_64.apk`.
   (Verifikasi SHA-256 dari GitHub Releases sebelum install.)
3. **Siapkan config JSON per device** — generate dari template (inbound `tun` +
   outbound `socks`/`http`/dll), satu file per proxy.
4. **Inject config** via salah satu jalur di §4 (disarankan `adb root` +
   tulis data dir, atau config remote URL).
5. **Grant VPN**: `appops set io.nekohasekai.sfa ACTIVATE_VPN allow`.
6. **Start service** + **verifikasi TUN**: cek `ip addr show tun0` sampai muncul.
7. **Health check**: request keluar dari device, pastikan exit IP = IP proxy.
8. **Teardown**: stop service, (opsional) `appops ... default`, hapus profil.

### Fase C — Orkestrasi Farm

- Simpan mapping **serial → proxy** di satu file (JSON/CSV).
- Loop tiap device, jalankan Fase A atau B, dengan **guard per-serial** dan
  **timeout** agar satu device gagal tidak memblok yang lain.
- Catat status per device (OK / gagal apply / TUN tidak naik / exit IP salah).

---

## 7. Matriks Trade-off Ringkas

| Kriteria | P1 http_proxy | P2 emulator flag | P3 sing-box SFA | P4 binary |
|----------|:---:|:---:|:---:|:---:|
| Setup termudah | ✅✅✅ | ✅✅ | ✅ | ➖ |
| Tanpa root | ✅ | ✅ | ✅ | ❌ |
| Tanpa install | ✅ | ✅ | ❌ | ➖ (push binary) |
| SOCKS5 native | ❌ | ❌ | ✅ | ✅ |
| Auth proxy | ❌ | ✅ | ✅ | ✅ |
| Semua traffic (anti-bypass) | ❌ | ✅ (TCP) | ✅ | ✅ |
| UDP/QUIC | ❌ | ❌ | ✅ | ✅ |
| Runtime toggle | ✅ | ❌ (saat boot) | ✅ | ✅ |
| Ramah otomasi farm | ✅✅ | ✅ | ✅✅ (JSON) | ✅ |
| Isolasi antar-instance | ✅ | ✅✅ | ✅ | ✅ |

---

## 8. Rekomendasi Akhir

1. **Kerjakan Fase A dulu** (Pendekatan 1 + converter host bila SOCKS5) untuk
   memvalidasi pipeline end-to-end hari ini. Murah, cepat, reversibel.
2. **Untuk farm**, pindah ke **Fase B dengan sing-box SFA** di AVD non-Play. Config
   JSON + `appops` + verifikasi `tun0` memberi jalur otomasi paling bersih dan
   sekaligus kompatibel dengan ekosistem NekoBox yang sudah kamu kuasai.
3. **Selalu** targetkan `-s <serial>` di tiap perintah adb, dan pastikan hanya satu
   VpnService aktif per device, untuk memenuhi syarat "tidak mengganggu yang lain".

---

## Lampiran — Sumber Referensi Kunci

- Android Developers — Set up Proxy with the Android Emulator (`-http-proxy`,
  format auth, UDP tidak didukung).
- Android Developers — VPN / VpnService (connection-request dialog, per-app,
  allowBypass).
- sing-box — Android client (SFA): TUN via VpnService, config lokal/remote.
- SagerNet/sing-box Releases — APK per-ABI + SHA-256.
- F-Droid — `io.nekohasekai.sfa` (min Android 6.0, signed by developer).
- Proxyman / Genymotion / Requestly — praktik `settings put global http_proxy`
  dan alamat host `10.0.2.2` / `10.0.3.2` / `adb reverse`.
- heiher/sockstun — tun2socks ringan (TCP+UDP, fullcone, per-app).
- XDA — `appops set <pkg> ACTIVATE_VPN allow` untuk meng-allow VpnService.
