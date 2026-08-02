# @enkaku/toolchain

Runtime provisioning for tools (adb, scrcpy-server, ui-server): download with mandatory sha256 verification, versioning, and an active pointer. The core never uses a binary from the system PATH (spec §7.8).

## Disk layout

```
<app-data>/tools/
  .staging/                      # temporary download/extract space — cleared every boot
  adb/
    36.0.0/platform-tools/adb
    active.json                  # active-version pointer { version, sha256, activatedAt }
  scrcpy-server/                 # swappable: false — its version is pinned to the core (spec §7.6)
```

The pointer is an `active.json` file rather than a symlink so it stays portable on Windows; it is written temp-then-rename (atomic).

## Adding a tool, or filling in a manifest sha256

1. Add an entry to `manifest/enkaku-tools.json` (schema: `src/types.ts`, matching spec §7.3 plus a `format: zip|raw` field).
2. Download the artifact from its official URL, run `shasum -a 256`, and fill in `sha256` and `sizeBytes`. An entry with `sha256: "TODO-verify"` parses fine but is rejected at install time (`E_CHECKSUM_MISSING`).
3. For tools coupled to the core (scrcpy-server, for instance): set `swappable: false` plus `compatibleCoreRange` (a semver range of core versions).
4. Register the binary entrypoint in `src/entrypoints.ts`.

## Dev/test override

`ENKAKU_<TOOL_ID>_PATH` (for example `ENKAKU_ADB_PATH`) bypasses pointer resolution — dev and test only, and always logged with a warning.
