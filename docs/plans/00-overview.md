# Plan 00 — Overview, Konvensi, & Peta Jalan Eksekusi

> Dokumen induk untuk seluruh plan di `docs/plans/`. Baca dokumen ini **sebelum** mengerjakan plan manapun.
> Sumber kebenaran produk: `docs/spec.md` (Enkaku draft v0.2). Jika plan bertentangan dengan spec, spec menang — lalu update plan-nya.

---

## 1. Cara memakai plan series ini

- Setiap plan = satu milestone dari spec §20, dikerjakan **berurutan** (01 → 11). Plan N mengasumsikan semua plan < N sudah selesai dan acceptance criteria-nya terpenuhi.
- Setiap plan bersifat **self-contained untuk konteks kerja**: berisi goals, non-goals, desain teknis, langkah implementasi bernomor, acceptance criteria, dan test plan. AI agent builder cukup membaca `00-overview.md` + plan yang sedang dikerjakan (+ bagian spec yang direferensikan).
- Jangan mengerjakan fitur dari plan berikutnya "sekalian lewat". Kalau menemukan kebutuhan yang belum ter-cover, catat di bagian **Open questions** plan terkait, jangan improvisasi arsitektur.
- Setiap plan selesai → jalankan seluruh acceptance criteria → commit dengan pesan `feat(mX): ...` → baru lanjut plan berikutnya.

## 2. Daftar plan

| # | File | Milestone | Isi singkat |
|---|---|---|---|
| 00 | `00-overview.md` | — | Dokumen ini: konvensi, stack, struktur repo, template. |
| 01 | `01-m0-foundation.md` | M0 | Monorepo, core daemon, `packages/adb` (client + track-devices), device registry + stableId, SQLite, WS broadcast, per-device queue + semaphore. |
| 02 | `02-m1-toolchain.md` | M1 | Toolchain Manager: manifest, download + sha256, versioning, active pointer, swappable flag, first-run auto-provision. |
| 03 | `03-m2-basic-control.md` | M2 | Kontrol dasar: `screencap-loop` + `adb-input`, coordinate mapping, Studio live view + klik, enrollment wizard. |
| 04 | `04-m3-session-lease-queue.md` | M3 | State machine device, lease + heartbeat, queue per-device di SQLite (dummy job). |
| 05 | `05-m4-script-framework.md` | M4 | `defineScript`, runner subprocess, artifact/log, `@enkaku/sdk`, inspector awal (`uiautomator dump`). |
| 06 | `06-m4.5-ui-server.md` | M4.5 | Persistent on-device inspector (pola uiautomator2): fast `find`/`waitFor`, `set_text`. |
| 07 | `07-m5-studio-complete.md` | M5 | Studio lengkap: Scripts CRUD + run form + publish, job detail, Tools UI, settings, schema-driven renderer, registry, battery/thermal + auto-quarantine. |
| 08 | `08-m6-scrcpy.md` | M6 | scrcpy display (H.264 relay, versi-locked) + `scrcpy-uhid` input + WebCodecs decode + fallback decoder. |
| 09 | `09-m7-multiuser-packaging.md` | M7 | Auth/ACL + TLS, single-binary, Docker image, Tauri shell, auto-update, artifact retention/GC. |
| 10 | `10-m7.5-business-plumbing.md` | M7.5 | Docs, license/activation, telemetry opt-in, AUP, support/update channel, `LICENSES.md`. |
| 11 | `11-m8-cloud.md` | M8 | Cloud tunnel agent, split control plane, WebRTC video, security boundary per-job, appium opt-in, redroid, `scrcpy-aoa`. |

Dependensi linier: `01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11`. (07 dan 06 sebagian bisa paralel, tapi default: urut.)

## 3. Stack & keputusan yang TIDAK boleh diubah

Keputusan ini sudah final di spec (§4, §10.3, §21 catatan akhir). Plan manapun tidak boleh menggantinya tanpa revisi spec:

| Area | Keputusan |
|---|---|
| Runtime core | **Bun** (bukan Node). Core daemon = Bun + **Hono**. |
| Web UI | **Next.js** (Studio), diakses via browser; bisa di-serve core (static export) atau hosted. |
| DB | **SQLite** (zero-setup) + **Drizzle ORM**. Driver DB di-abstract, tapi default SQLite. |
| Validasi/schema | **Zod** di semua boundary (protocol message, params script, config engine, DeviceSettings). JSON Schema untuk UI form di-generate dari Zod. |
| Monorepo | Bun workspaces, layout persis spec §4 (`packages/core|studio|sdk|protocol|adb|scrcpy|toolchain|drivers|agent`, `apps/desktop`). |
| scrcpy-server | **Vanilla .jar resmi Genymobile**, di-pin ke versi core (`swappable: false`). Tidak pernah fork Java. (spec §7.6) |
| Input default | `scrcpy-uhid`; fallback `scrcpy-sdk`; `adb-input` hanya fallback kasar/MVP. (spec §9) |
| Inspector default (akhir) | `ui-server` persistent on-device; `uiautomator dump` hanya jembatan di M4. (spec §7.4) |
| Komunikasi Core⇄Studio | Message-based over **WebSocket** untuk realtime/stream; REST untuk CRUD. Kontrak di `packages/protocol` (Zod). (spec §13) |
| Serialisasi adb | Per-device command queue + global semaphore longgar (6–8). **`adb kill-server` dilarang** kecuali Toolchain Manager swap versi adb. (spec §10.4) |
| Trust model lokal | Crash containment (child process + hard-timeout kill), **bukan** sandbox keamanan. Jangan klaim "sandbox". (spec §11.3) |
| Identity device | `stableId` (ro.serialno → fallback ANDROID_ID) = identitas; serial adb = alamat transport. (spec §7.5) |

## 4. Konvensi repo & kode

### 4.1 Struktur monorepo (target akhir; dibuat bertahap mulai Plan 01)

```
openpf/
  package.json                # workspaces: ["packages/*", "apps/*"]
  bunfig.toml
  tsconfig.base.json
  packages/
    core/                     # Bun + Hono daemon
    studio/                   # Next.js web UI
    sdk/                      # @enkaku/sdk — defineScript, tipe publik
    protocol/                 # @enkaku/protocol — Zod message schema, shared types
    adb/                      # @enkaku/adb — adb client, track-devices, scrcpy-server push
    scrcpy/                   # @enkaku/scrcpy — protocol client (demux, meta decode), versi-locked
    toolchain/                # @enkaku/toolchain — provisioning tool (download, sha256, versi)
    drivers/                  # @enkaku/drivers — implementasi Transport/DisplaySource/InputSink/Inspector
    agent/                    # @enkaku/agent — mini-core cloud tunnel (Plan 11)
  apps/
    desktop/                  # Tauri shell (Plan 09)
  docs/
    spec.md
    plans/
```

- Nama package npm internal: scope `@enkaku/*`. `sdk` dan `protocol` dirancang publishable; sisanya `"private": true`.
- Path alias TS: import antar-package selalu via nama package (`@enkaku/protocol`), bukan relative path lintas package.

### 4.2 Konvensi TypeScript

- `"strict": true`, `"noUncheckedIndexedAccess": true` di `tsconfig.base.json`.
- Semua data lintas boundary (WS message, HTTP body, DB JSON column, config file) **wajib** lewat Zod `.parse()`/`.safeParse()` — tidak ada `as` casting terhadap input eksternal.
- Error: gunakan class error ber-kode (`EnkakuError` dengan `code: string`) di core; API mengembalikan `{ error: { code, message } }` konsisten.
- Logging: satu logger util di core (level: debug/info/warn/error, prefix subsistem, output JSON-lines opsional). Semua subsistem pakai ini, tidak ada `console.log` liar.
- ID entitas: gunakan `nanoid()` / `crypto.randomUUID()` — konsisten satu pilihan sejak Plan 01 (pakai `crypto.randomUUID()`, built-in Bun).
- Timestamp DB: integer unix epoch **detik** (Drizzle `{ mode: 'timestamp' }`), konsisten di semua tabel.

### 4.3 Konvensi API & protocol

- REST: prefix `/api/...`, JSON, status code semantik. Endpoint tool mengikuti spec §7.7 persis.
- WS: satu endpoint `/ws` untuk control-plane message (JSON envelope), binary stream video via message binary dengan channel-prefix (detil di Plan 03/08). Envelope JSON:
  ```ts
  { type: string; id?: string; payload: unknown }   // id untuk request-reply correlation
  ```
- Semua tipe message dideklarasikan di `packages/protocol` sebagai Zod discriminated union; core dan studio import dari situ. **Tidak ada** string message type hardcode di luar protocol package.

### 4.4 Konvensi testing

- Test runner: `bun test`. File `*.test.ts` colocated di `src/`.
- Tiap plan punya bagian **Test plan**; minimal: unit test untuk logika murni (queue, parser, checksum, state machine) + smoke test manual berskrip (dokumentasikan perintahnya di plan).
- Test yang butuh device fisik ditandai dan bisa di-skip via env `ENKAKU_TEST_DEVICE=1`.

### 4.5 Konvensi commit & branch

- Satu plan boleh banyak commit; pesan `feat(m0): ...`, `fix(m2): ...`, `chore: ...`.
- Repo ini belum git — Plan 01 langkah pertama termasuk `git init`.

## 5. App-data & path runtime (dipakai lintas plan)

Sesuai spec §7.2:

- macOS: `~/Library/Application Support/Enkaku`
- Windows: `%APPDATA%\Enkaku`
- Linux: `~/.local/share/enkaku` (service: `/var/lib/enkaku`)
- Override untuk dev/test: env `ENKAKU_DATA_DIR`.

Isi: `enkaku.db`, `tools/<toolId>/<version>/...` + symlink/pointer `active`, `artifacts/<job-id>/...`, `logs/`.

## 6. Template plan (struktur wajib tiap dokumen 01–11)

Setiap plan mengikuti struktur ini, dengan kedalaman "AI builder tinggal ikut":

```markdown
# Plan XX — <Milestone> : <Judul>

> Status / Depends on / Referensi spec (§...)

## 1. Goals            — apa yang harus TRUE setelah plan selesai (bullet terukur)
## 2. Non-goals        — yang sengaja TIDAK dikerjakan di plan ini (dan dikerjakan di plan mana)
## 3. Konteks & keputusan desain — ringkasan desain + alasan, merujuk spec
## 4. Desain teknis    — interface TS, schema DB/Zod, endpoint, struktur file, flow/sequence
## 5. Langkah implementasi — tahapan bernomor (X.1, X.2, ...) dengan sub-checklist konkret,
##                       tiap tahap menyebut file yang dibuat/diubah & hasil yang bisa diverifikasi
## 6. Acceptance criteria — daftar cek final, semua harus lulus
## 7. Test plan        — unit test + smoke test manual (perintah eksplisit)
## 8. Risiko & mitigasi
## 9. Open questions   — ambiguitas spec yang butuh keputusan manusia (jangan diputuskan sepihak)
```

## 7. Definition of Done global (berlaku untuk semua plan)

1. Semua acceptance criteria plan lulus.
2. `bun test` hijau di seluruh workspace.
3. Tidak ada TODO/`any` baru yang tak beralasan di kode yang disentuh.
4. Perilaku baru terdokumentasi minimal di README package terkait.
5. Target NFR spec §16 yang relevan dengan milestone tsb dicek (mis. Plan 06: inspector find < 200 ms; Plan 08: glass-to-glass < 150 ms LAN).

## 8. Glossary singkat

- **Core** — daemon Bun+Hono, orkestrator semuanya.
- **Studio** — web UI Next.js.
- **Engine** — implementasi salah satu dari 4 lapisan driver (Transport/DisplaySource/InputSink/Inspector).
- **DeviceSession** — rakitan 4 engine untuk satu device (spec §7).
- **Lease** — hak eksklusif memakai device (manual atau job), dengan heartbeat + expiry.
- **stableId** — identitas device stabil (ro.serialno / ANDROID_ID), bukan serial adb.
- **Toolchain Manager** — subsistem provisioning binary (adb, scrcpy-server, ui-server, ...).
- **swappable** — flag tool: boleh/tidaknya user memilih versi bebas (scrcpy-server: `false`).
