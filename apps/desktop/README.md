# apps/desktop — shell Tauri

Membungkus core + Studio jadi aplikasi desktop: jendela native, ikon tray, dan auto-update.

## Status

Konfigurasi dan entry point sudah ada, **tapi belum pernah di-build**: Tauri membutuhkan toolchain Rust dan signing key per-OS yang berada di luar lingkup pekerjaan pengembangan ini. Yang masih menunggu:

- `cargo` + `Cargo.toml` (dibuat otomatis oleh `bunx create-tauri-app` atau ditulis manual saat pertama kali build),
- ikon aplikasi di `src-tauri/icons/`,
- public key updater di `tauri.conf.json` (kini bertanda `TODO-verify`),
- signing: notarization macOS, sertifikat Authenticode Windows.

## Cara kerja

Shell menjalankan binary core sebagai proses anak dengan bind `127.0.0.1`, sehingga mode auth otomatis `local` — pengguna desktop tidak pernah melihat halaman login, dan farm tidak terjangkau dari jaringan. Menutup jendela mematikan core juga, supaya tidak ada proses yatim.

Studio dimuat dari hasil static export (`packages/studio/out`), jadi satu origin dengan API core.

```bash
# prasyarat: binary core sudah terpasang atau set ENKAKU_CORE_BIN
bun run --cwd packages/studio build
cargo tauri dev    # dari apps/desktop/src-tauri
```
