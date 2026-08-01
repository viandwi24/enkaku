# Panduan install

Enkaku mengelola sendiri seluruh tool yang dibutuhkannya (adb, scrcpy-server, APK inspector). **Anda tidak perlu meng-install adb** atau mengatur PATH.

## 1. Local (paling gampang)

```bash
bun install
bun run dev
# buka http://localhost:7700
```

Saat pertama kali jalan, core mengunduh adb + scrcpy-server + APK inspector, memverifikasi sha256-nya, lalu mengaktifkannya. Progres terlihat langsung di Studio (biasanya di bawah satu menit).

Karena bind ke `127.0.0.1`, mode auth otomatis `local`: tidak ada halaman login, satu admin implisit. Ini aman karena tidak ada yang bisa mengaksesnya dari luar mesin Anda.

## 2. Server / homelab (systemd)

```bash
sudo useradd -r -s /usr/sbin/nologin -G plugdev enkaku
sudo mkdir -p /opt/enkaku /var/lib/enkaku && sudo chown enkaku: /var/lib/enkaku
sudo cp deploy/enkaku.service /etc/systemd/system/
sudo systemctl enable --now enkaku
```

Bind non-loopback ⇒ mode `server` ⇒ **login wajib dan TLS wajib**. Dua pilihan:

- Di belakang reverse proxy (Caddy/nginx) yang terminate TLS: `ENKAKU_TLS_MODE=external`.
- Sertifikat sendiri: `ENKAKU_TLS_MODE=self`, `ENKAKU_TLS_CERT=/path/cert.pem`, `ENKAKU_TLS_KEY=/path/key.pem`.

Buka Studio → halaman setup meminta email + password admin pertama. Setelah itu endpoint setup tertutup permanen.

## 3. Docker

```bash
docker compose up -d
```

Akses USB dari container merepotkan (butuh `--device /dev/bus/usb`, aturan udev, dan bisa berebut adb server dengan host). **Untuk container, gunakan wireless ADB**: enroll device lewat pairing code dari Studio.

## Variabel lingkungan

| Env | Fungsi |
|---|---|
| `ENKAKU_DATA_DIR` | Lokasi database, tool, artifact |
| `ENKAKU_BIND` / `ENKAKU_PORT` | Alamat bind (menentukan mode auth) |
| `ENKAKU_AUTH_MODE` | `auto` (default) \| `local` \| `server` |
| `ENKAKU_TLS_MODE` | `off` \| `self` \| `external` |
| `ENKAKU_ALLOW_INSECURE=1` | Izinkan mode server tanpa TLS — hanya untuk pengujian |
| `ENKAKU_TOOLS_MANIFEST_URL` | Manifest tool alternatif (mirror internal / air-gapped) |
| `ENKAKU_STUDIO_DIST` | Lokasi build Studio untuk mode satu-origin |

## Troubleshooting

**Device muncul sebagai `unauthorized`.** Cek layar HP: ada dialog "Allow USB debugging". Centang "Always allow", tap Allow. Kalau dialog tidak muncul, cabut-colok kabel; kalau masih tidak muncul, Developer options → Revoke USB debugging authorizations, lalu colok lagi.

**Device tidak terdeteksi sama sekali.** Pastikan USB debugging aktif dan kabel mendukung data (banyak kabel charger tidak). Di Linux, tambahkan aturan udev untuk vendor HP Anda.

**Bentrok dengan Android Studio.** Android Studio menjalankan adb server versinya sendiri di port 5037. Enkaku memakai adb server yang sama, jadi umumnya aman — tapi jangan menjalankan `adb kill-server` manual saat farm sedang bekerja: itu memutus seluruh device.

**Provision gagal (tidak ada internet).** Core tetap hidup; siapkan mirror manifest lalu set `ENKAKU_TOOLS_MANIFEST_URL`, atau salin folder `tools/` yang sudah terisi ke data dir — core akan mengadopsinya saat start.
