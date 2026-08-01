# Engine inspector `ui-server`

Server instrumentation persistent di device (pola [openatx/uiautomator2](https://github.com/openatx/android-uiautomator-server)): hidup sekali per session, query selector dieksekusi **di device** lewat JSONRPC lokal yang di-forward `adb forward`.

Kenapa ada: `uiautomator dump` butuh 0,5–2 detik per query dan gagal saat UI terus berubah ("could not get idle state"). Karena `waitFor` = polling inspector, kecepatan inspector menentukan kecepatan seluruh script framework.

## Bentuk

| Bagian | File | Isi |
|---|---|---|
| Client | `client.ts` | HTTP/JSONRPC ke `127.0.0.1:<localPort>`; **subset method dibatasi sengaja** supaya migrasi ke APK sendiri murah |
| Launcher | `launcher.ts` | install APK (app + test), `am instrument`, `adb forward` |
| Watchdog | `watchdog.ts` | `starting → healthy ⇄ restarting(n) → dead` |
| Selector | `selector.ts` | Selector Enkaku → UiSelector uiautomator |
| Inspector | `index.ts` | implement `Inspector` + `InspectorElementActions` |

APK di-pin ke versi tertentu dan dikelola Toolchain Manager (`swappable: false`, checksum wajib) — protokol client↔server coupled, sama seperti perlakuan scrcpy-server.

## Kenapa watchdog wajib

Instrumentation gampang mati: low-memory killer, battery optimization vendor (Xiaomi/Oppo agresif), user force-stop, atau **tool lain yang merebut UiAutomation — termasuk `uiautomator dump` itu sendiri**. Karena itu `ui-server` dan `uiautomator-dump` tidak boleh aktif bersamaan dalam satu session; lock `instrumentation` di descriptor engine yang menegakkannya.

## Fallback

Gagal start / watchdog menyerah → session **tetap dibuat** dengan `uiautomator-dump`, plus event WS `device.inspector.fallback`. Kolom `devices.inspection` tidak diubah (fallback per-session, bukan permanen), jadi session berikutnya mencoba `ui-server` lagi.

## Batas yang perlu diketahui

- **WebView/hybrid**: elemen terlihat sebatas yang diekspos accessibility tree; banyak muncul sebagai node generic. `setText` ke input WebView jauh lebih reliable daripada inject keystroke — itu keuntungan nyata engine ini. Inspeksi WebView penuh (DOM, context switching) butuh Appium (opt-in, M8).
- **Nama method JSONRPC** di `client.ts` mengikuti APK yang di-pin; verifikasi ulang terhadap device fisik saat menaikkan versi APK.
