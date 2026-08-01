# @enkaku/toolchain

Runtime provisioning tool (adb, scrcpy-server, ui-server): download + verifikasi sha256 wajib + versioning + pointer aktif. Core tidak pernah memakai binary dari system PATH (spec §7.8).

## Layout disk

```
<app-data>/tools/
  .staging/                      # download/extract sementara — dibersihkan tiap boot
  adb/
    36.0.0/platform-tools/adb
    active.json                  # pointer versi aktif { version, sha256, activatedAt }
  scrcpy-server/                 # swappable: false — versi dikunci ke core (spec §7.6)
```

Pointer pakai `active.json` (bukan symlink) supaya portable Windows; ditulis temp+rename (atomik).

## Menambah tool / mengisi sha256 di manifest

1. Tambah entry di `manifest/enkaku-tools.json` (schema: `src/types.ts`, persis spec §7.3 + field `format: zip|raw`).
2. Download artifact dari URL resmi, `shasum -a 256`, isi `sha256` + `sizeBytes`. Entry dengan `sha256: "TODO-verify"` lolos parse tapi ditolak saat install (`E_CHECKSUM_MISSING`).
3. Tool coupled ke core (mis. scrcpy-server): set `swappable: false` + `compatibleCoreRange` (semver range versi core).
4. Daftarkan entrypoint binary di `src/entrypoints.ts`.

## Override dev/test

`ENKAKU_<TOOL_ID>_PATH` (mis. `ENKAKU_ADB_PATH`) melewati resolusi pointer — dev/test only, selalu ber-warning di log.
