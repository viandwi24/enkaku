# Plan 09 — M7 : Multi-user & Packaging

> Status: implemented — auth/ACL, TLS, config precedence, retention GC, sessions table, and the Tauri desktop shell all ship in the core and apps/desktop.
> Ships: packages/core/src/auth/acl.ts
> **Depends on:** Plan 01–08 (M0–M6) selesai & acceptance criteria-nya lulus. Placeholder settings retention dari Plan 07 diaktifkan di sini.
> **Referensi spec:** §20 baris M7, §14 (keamanan: auth, TLS, audit, data hygiene), §5.1–5.2 (mode deployment local & headless server), §12 (tabel `users`, `audit_log`, `artifacts.sizeBytes`), §18 (artifact retention/GC), §7.2 (app-data dir), §4 (`apps/desktop` Tauri).

---

## 1. Goals

Setelah plan ini selesai, semua pernyataan berikut TRUE:

- Core punya **config file** (`enkaku.config.json` + env override) dengan schema Zod: `bind`, `port`, `tls`, `dataDir`, `auth`, `retention`. Precedence: CLI flag > env > file > default.
- **Mode auth otomatis terdeteksi dari bind address**: bind loopback → mode `local` (auto-create admin, tanpa login, zero-config tetap utuh); bind non-loopback → mode `server` (login **wajib**, argon2 via `Bun.password`).
- Mode server first-boot menampilkan **setup page sekali jalan** untuk membuat admin pertama; setelah admin ada, setup tertutup permanen.
- Session berbasis **cookie httpOnly** untuk HTTP + WS same-origin, plus **WS ticket sekali-pakai** untuk kasus cookie tidak tersedia. Login/logout endpoint jalan; session tersimpan hashed di tabel `sessions` dengan expiry.
- **ACL role `admin` vs `operator`** di-enforce **di core** (server-authoritative, spec §2) untuk semua endpoint & WS action sesuai matrix eksplisit di §4.4 — bukan sekadar hide tombol di Studio.
- **Device ownership** (`devices.ownerId`) di-enforce: device tanpa owner bebas dipakai semua operator; device ber-owner hanya boleh dikontrol/di-run-job oleh owner + admin (default sementara, lihat Open questions).
- Semua aksi sensitif tercatat di **`audit_log`** (daftar action lengkap di §4.5), bisa dibaca via API (admin only) dan tampil sederhana di Studio Settings.
- **TLS**: core bisa serve HTTPS/WSS dengan cert user-provided (`tls.mode: 'self'`), atau jalan di belakang reverse proxy (`tls.mode: 'external'`, terdokumentasi dengan contoh Caddy/nginx — jalur yang direkomendasikan). Mode server tanpa TLS **menolak boot** kecuali dev-override eksplisit.
- **Data hygiene antar-lease** (opt-in): saat lease dilepas, core menjalankan `pm clear <pkg>` untuk daftar package yang dikonfigurasi (per-device / farm default).
- **Artifact retention/GC** jalan sebagai job periodik di core: TTL + quota global + quota per-device + LRU eviction memakai `artifacts.sizeBytes`; setting-nya bisa diubah dari Studio.
- **Packaging** lengkap:
  - Single binary `bun build --compile` untuk `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, dengan Studio static export **ter-embed** (tools tetap di-download runtime oleh Toolchain Manager).
  - Docker image multi-stage + `docker-compose.yml` + dokumentasi akses USB / rekomendasi adb wireless-only.
  - Contoh systemd unit.
  - Tauri shell di `apps/desktop`: window + tray + auto-update, core sebagai sidecar.
- **Auto-update** sesuai scope realistis M7: Tauri updater penuh; binary/systemd = notifikasi versi baru di Studio; Docker = pull image (terdokumentasi).
- `bun test` hijau; unit test ACL matrix & auth flow lulus; smoke test packaging (binary di mesin bersih, `docker compose up`) terdokumentasi & lulus.

## 2. Non-goals

- **Cloud tunnel / agent / WebRTC / split control plane** — Plan 11 (M8). Token auth untuk agent hanya disiapkan bentuk tabelnya, tidak diimplementasikan.
- **Security boundary per-job (container/gVisor/microVM)** — Plan 11. Trust model tetap "script author = operator tepercaya" (spec §11.3); ACL di plan ini mengatur *siapa boleh apa*, bukan mengisolasi script.
- **License key/activation, telemetry, AUP, `LICENSES.md`, update channel bisnis** — Plan 10 (M7.5). Plan ini hanya menyiapkan mekanisme cek versi.
- **Multi-tenant / organisasi / lebih dari 2 role** — di luar spec. Role hanya `admin|operator` (spec §12).
- **OAuth/SSO/LDAP** — tidak ada di spec. Login = email + password saja.
- **Self-replace auto-update untuk raw binary** (binary menimpa dirinya sendiri) — hanya notifikasi di M7; eksekusi update tetap manual/via Tauri.
- **Windows build** — spec §7.2 menyebut path Windows, tapi target platform M7 dibatasi macOS/Linux (lihat Open questions).
- **Video recording per-session sebagai artifact** — spec §22 (future); GC di sini cukup menangani `kind: video` kalau sudah ada.

## 3. Konteks & keputusan desain

1. **Auth mode dari bind address, bukan flag terpisah** (spec §14): zero-config lokal tidak boleh rusak — user awam double-click binary, bind default `127.0.0.1`, tidak pernah melihat login. Begitu operator bind ke `0.0.0.0`/IP LAN (mode headless server §5.2), login wajib. Ini meniru pelajaran ws-scrcpy secara terbalik: mereka default "listen all interfaces, no auth" dan itu disebut spec sebagai kesalahan yang tidak boleh diulang (§6.2, §14). Deteksi otomatis + opsi override eksplisit (`auth.mode`) memberi jalan keluar untuk kasus aneh (mis. reverse proxy di host yang sama), tapi kombinasi tidak aman (`local` + bind non-loopback) ditolak saat boot, bukan sekadar warning.
2. **Session opaque token di server, bukan JWT**: SQLite sudah ada, single instance, revoke harus instan (logout, hapus user). Token 32-byte random, disimpan **hashed (SHA-256)** di DB supaya dump DB tidak berisi token hidup. Cookie `httpOnly` + `SameSite=Lax` + `Secure` (saat TLS) menutup XSS-steal & CSRF dasar; WS same-origin otomatis membawa cookie saat upgrade. Untuk klien tanpa cookie (Studio hosted lintas origin nanti, CLI) ada **WS ticket sekali-pakai TTL 60 detik** — bukan long-lived token di query string (query string bocor di log).
3. **ACL sebagai matrix data, bukan if tersebar**: satu konstanta `ACL_MATRIX` (permission → role[]) di satu file, dipakai middleware `requirePermission()`. Ini membuat unit test tinggal table-driven, dan Studio bisa fetch matrix yang sama untuk hide/disable UI — tapi enforcement tetap di core (spec §2 "client tidak pernah dipercaya"). Ownership device adalah cek **resource-level** terpisah dari role matrix (role menjawab "boleh sentuh kategori aksi", ownership menjawab "boleh sentuh device INI").
4. **Audit log append-only, best-effort synchronous**: ditulis dalam request handler yang sama (SQLite cepat), tidak ada queue terpisah. Gagal tulis audit → log error, request tetap jalan (audit bukan alasan mematikan farm 10 device). `userId` nullable untuk event sistem (GC, auto-quarantine).
5. **TLS: reverse proxy direkomendasikan, cert langsung didukung** (spec §14). Bun `serve()` mendukung `tls: { cert, key }` native, jadi `tls.mode: 'self'` murah diimplementasikan. Tapi rotasi cert, ACME, HTTP→HTTPS redirect adalah pekerjaan yang Caddy selesaikan dalam 3 baris config — dokumentasi mengarahkan ke sana untuk deployment serius; `tls.mode: 'external'` membuat core percaya `X-Forwarded-Proto` untuk cookie `Secure`.
6. **Data hygiene = `pm clear` daftar package, opt-in** (spec §14, pelajaran STF §6.1 "devices tidak di-reset antar-pakai"): full factory reset terlalu destruktif dan lambat untuk farm internal; `pm clear` per-package (logout paksa + hapus data app) adalah kompromi yang tepat dan bisa dijalankan lewat per-device queue yang sudah ada sejak Plan 01. Opt-in karena farm single-user tidak membutuhkannya dan `pm clear` menghapus state test yang mungkin sengaja dipertahankan.
7. **GC: TTL dulu, lalu quota dengan eviction tertua-dulu** (spec §18): TTL menjawab "artifact tua tidak berguna", quota menjawab "disk penuh". Eviction memakai `finishedAt` job (proksi LRU paling jujur yang datanya sudah ada — artifact tidak punya `lastAccessedAt`, menambahkannya = tracking akses file yang tidak sepadan). Artifact milik job `running` tidak pernah dihapus.
8. **Single binary meng-embed Studio, TIDAK meng-embed tools**: `bun build --compile` bisa meng-embed file via import; Studio static export (sudah di-serve core sejak Plan 07) masuk ke binary lewat asset manifest yang di-generate saat build. Tools (adb/platform-tools, scrcpy-server.jar, ui-server.apk) **tetap di-download runtime** oleh Toolchain Manager — alasan: ukuran per-platform, model versioning/swap yang sudah dibangun di Plan 02, dan lisensi redistribusi platform-tools yang belum diaudit (audit = Plan 10, spec §18).
9. **Tauri = shell tipis, core = sidecar**: Tauri tidak mengandung logika farm; ia spawn binary core (sidecar per-platform), tunggu health check, arahkan window ke `http://127.0.0.1:<port>`. Auto-update Tauri meng-update shell + sidecar sekaligus (satu bundle). Signing per-OS ditandai TODO-verify (butuh akun Apple Developer / sertifikat — keputusan manusia).
10. **Auto-update scope realistis**: satu mekanisme cek versi (endpoint manifest rilis) dipakai semua kanal; yang berbeda hanya eksekusinya — Tauri updater otomatis, binary/systemd tampil banner "versi baru tersedia" di Studio, Docker didokumentasikan `docker compose pull`. Self-replace binary ditunda (risiko tinggi, nilai kecil selama Tauri ada untuk user awam).

## 4. Desain teknis

### 4.1 Config file core (`enkaku.config.json`)

File baru: `packages/core/src/config/schema.ts`, `packages/core/src/config/load.ts`.

Lokasi file: `<dataDir>/enkaku.config.json` (default), override via `--config <path>` atau `ENKAKU_CONFIG`. `dataDir` sendiri di-resolve lebih dulu dari `ENKAKU_DATA_DIR` / default per-platform (Plan 00 §5) — `dataDir` di dalam file config hanya dipakai kalau config dibaca dari path eksplisit.

```ts
// packages/core/src/config/schema.ts
import { z } from 'zod'

export const TlsConfigSchema = z.object({
  mode: z.enum(['off', 'self', 'external']).default('off'),
  // mode 'self': core terminate TLS sendiri
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
  // mode 'external': di belakang reverse proxy; percaya X-Forwarded-Proto utk cookie Secure
})

export const AuthConfigSchema = z.object({
  mode: z.enum(['auto', 'local', 'server']).default('auto'),
  sessionTtlHours: z.number().int().positive().default(24 * 30), // 30 hari
  loginMaxAttempts: z.number().int().positive().default(5),
  loginLockoutSeconds: z.number().int().positive().default(30),
})

export const RetentionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  artifactTtlDays: z.number().int().positive().default(30),
  maxTotalBytes: z.number().int().positive().default(20 * 1024 ** 3),      // 20 GB
  maxPerDeviceBytes: z.number().int().positive().default(2 * 1024 ** 3),   // 2 GB
  gcIntervalMinutes: z.number().int().positive().default(60),
})

export const EnkakuConfigSchema = z.object({
  bind: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(7788),
  dataDir: z.string().optional(),
  auth: AuthConfigSchema.default({}),
  tls: TlsConfigSchema.default({}),
  retention: RetentionConfigSchema.default({}),
})
export type EnkakuConfig = z.infer<typeof EnkakuConfigSchema>
```

Env override (di `load.ts`): `ENKAKU_BIND`, `ENKAKU_PORT`, `ENKAKU_AUTH_MODE`, `ENKAKU_TLS_MODE`, `ENKAKU_TLS_CERT`, `ENKAKU_TLS_KEY`, `ENKAKU_DATA_DIR`, `ENKAKU_ALLOW_INSECURE` (dev only). Precedence: CLI flag > env > file > default. Hasil load di-`parse()` Zod; config invalid = boot gagal dengan pesan jelas.

**Resolusi mode efektif** (`resolveAuthMode(config): 'local' | 'server'`):

| `auth.mode` | bind loopback (`127.0.0.1`/`::1`/`localhost`) | bind lain |
|---|---|---|
| `auto` | `local` | `server` |
| `local` | `local` | **boot ditolak** (`E_INSECURE_BIND`) |
| `server` | `server` (dipaksa login walau localhost — utk testing/reverse-proxy satu host) | `server` |

**Validasi TLS saat boot**: mode efektif `server` + `tls.mode: 'off'` → boot ditolak (`E_TLS_REQUIRED`, spec §14 "TLS wajib") kecuali `ENKAKU_ALLOW_INSECURE=1` (log warning besar). `tls.mode: 'self'` tanpa `certPath`/`keyPath` yang bisa dibaca → boot ditolak.

### 4.2 Schema DB tambahan: `sessions`

`users` dan `audit_log` sudah ada sejak Plan 01 (schema spec §12) tapi belum dipakai. Plan ini menambah satu tabel (migration Drizzle baru):

```ts
// packages/core/src/db/schema.ts (tambahan)
export const sessions = sqliteTable('sessions', {
  id:         text('id').primaryKey(),                 // crypto.randomUUID()
  tokenHash:  text('token_hash').notNull().unique(),   // sha256(token), token mentah TIDAK disimpan
  userId:     text('user_id').notNull(),
  createdAt:  integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt:  integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  userAgent:  text('user_agent'),
  ip:         text('ip'),
})
```

WS ticket **tidak** butuh tabel: in-memory `Map<ticketHash, { userId, expiresAt }>` cukup (TTL 60 detik, sekali pakai, hilang saat restart — by design).

### 4.3 Auth: service, middleware, endpoint, flow

File baru di `packages/core/src/auth/`: `password.ts`, `session.ts`, `middleware.ts`, `routes.ts`, `local-mode.ts`.

**Password** (`password.ts`): `Bun.password.hash(pw, { algorithm: 'argon2id' })` / `Bun.password.verify` (spec §12 `passwordHash argon2`). Kebijakan minimal: panjang ≥ 8 (validasi Zod di endpoint).

**Session** (`session.ts`):
- `create(userId, meta)` → generate token `crypto.getRandomValues` 32 byte → base64url; simpan `sha256(token)`; return token mentah (sekali ini saja).
- `validate(token)` → lookup by hash, cek expiry, update `lastUsedAt` (throttle: max sekali/menit), return `{ session, user }` atau null.
- `revoke(token)` / `revokeAllForUser(userId)` (dipakai saat delete user / ganti password).
- Sweep session expired ikut jadwal GC (§4.8).

**Cookie**: nama `enkaku_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` bila request efektif HTTPS (TLS self, atau `tls.mode: 'external'` + `X-Forwarded-Proto: https`), `Max-Age` = `sessionTtlHours`.

**Middleware Hono** (`middleware.ts`):

```ts
// packages/core/src/auth/middleware.ts
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

export function authMiddleware(): MiddlewareHandler<{ Variables: { user: User } }> {
  return async (c, next) => {
    if (getEffectiveAuthMode() === 'local') {
      c.set('user', await getOrCreateLocalAdmin())   // §4.3 mode local
      return next()
    }
    if (!(await hasAnyAdmin()) && isSetupRoute(c.req.path)) return next() // first-boot
    const token =
      getCookie(c, 'enkaku_session') ??
      c.req.header('authorization')?.replace(/^Bearer /, '')
    const result = token ? await sessionService.validate(token) : null
    if (!result) {
      return c.json({ error: { code: 'auth.required', message: 'Login required' } }, 401)
    }
    c.set('user', result.user)
    await next()
  }
}
```

Dipasang global di semua route `/api/*` dan upgrade `/ws`, **kecuali** allowlist publik: `POST /api/auth/login`, `GET/POST /api/auth/setup`, `GET /api/health`, dan static asset Studio (halaman login butuh asset). WS upgrade handler membaca cookie dari header upgrade; kalau tidak ada, cek `?ticket=`.

**Endpoints** (`routes.ts`):

```
POST /api/auth/login      { email, password } → set cookie; 401 kalau salah; rate-limit per IP+email
POST /api/auth/logout     → revoke session + clear cookie
GET  /api/auth/me         → { user: { id, email, role }, authMode: 'local'|'server' }
POST /api/auth/ws-ticket  → { ticket }  (sekali pakai, TTL 60 dtk; dipakai /ws?ticket=...)
GET  /api/auth/setup      → { needed: boolean }          (publik)
POST /api/auth/setup      { email, password } → create admin PERTAMA; 409 kalau admin sudah ada
POST /api/auth/password   { current, next } → ganti password sendiri; revoke session lain
```

Rate limit login: in-memory counter per `ip+email`, `loginMaxAttempts` gagal → tolak `429` selama `loginLockoutSeconds`. Cukup untuk LAN; bukan proteksi internet-grade (reverse proxy bisa menambah).

**Mode `local`** (`local-mode.ts`): saat boot dengan mode efektif `local`, upsert user `id: 'local-admin'`, `email: 'admin@localhost'`, `role: 'admin'`, `passwordHash: null`. Middleware selalu inject user ini; halaman login tidak pernah muncul; Studio menyembunyikan menu logout (dari `GET /api/auth/me → authMode`). Audit log tetap ditulis atas nama `local-admin`.

**First-boot mode server**: boot → mode `server` → `hasAnyAdmin()` false (user dengan `role='admin'` **dan** `passwordHash` terisi belum ada) → semua request non-allowlist dijawab 401 dengan hint `setupNeeded: true`; Studio redirect ke `/setup` (form email+password, sekali submit). Setelah admin pertama dibuat: endpoint setup permanen mengembalikan 409, event `user.setup` masuk audit. Race dua request setup bersamaan diserialisasi via transaksi (cek-dan-insert dalam `BEGIN IMMEDIATE`).

**Flow login (sequence)**:

```
Browser                Core
  | GET /login page      |
  | POST /api/auth/login |── verify argon2 ── create session ── audit user.login
  |  ← 200 + Set-Cookie  |
  | GET /api/... (cookie)|── middleware validate ── handler
  | WS /ws (cookie ikut upgrade) ── validate ── accept
```

### 4.4 ACL: matrix permission & ownership

File baru: `packages/core/src/acl/matrix.ts`, `packages/core/src/acl/guard.ts`.

**Matrix eksplisit** (di-enforce middleware `requirePermission(perm)`; ✅O = operator boleh, ✅A = admin boleh; admin boleh SEMUA yang operator boleh):

| Permission | Endpoint/aksi | operator | admin |
|---|---|---|---|
| `device.view` | GET devices, dashboard, WS `device.*` events | ✅ | ✅ |
| `device.enroll` | Enrollment wizard, pairing (spec §15.1) | ✅ | ✅ |
| `device.control` | Lease manual, `input.*` WS (subject cek ownership) | ✅ | ✅ |
| `device.settings.edit` | Update DeviceSettings/driver pilihan (subject cek ownership) | ✅ | ✅ |
| `device.owner.set` | Assign/lepas `ownerId` device | ❌ | ✅ |
| `device.delete` | Hapus device dari registry | ❌ | ✅ |
| `device.quarantine` | Set/unset `quarantined` manual | ❌ | ✅ |
| `script.view` | List/read scripts | ✅ | ✅ |
| `script.publish` | Publish/update bundle script (spec persona script author = operator) | ✅ | ✅ |
| `script.delete.own` | Hapus/disable script buatan sendiri | ✅ | ✅ |
| `script.delete.any` | Hapus/disable script orang lain | ❌ | ✅ |
| `job.run` | Enqueue job (subject cek ownership device) | ✅ | ✅ |
| `job.cancel.own` | Cancel job milik sendiri | ✅ | ✅ |
| `job.cancel.any` | Cancel job orang lain | ❌ | ✅ |
| `job.view` | List job, log, artifact | ✅ | ✅ |
| `tool.view` | GET /api/tools, registry | ✅ | ✅ |
| `tool.manage` | install/activate/delete/check/manifest-refresh (spec §7.7) | ❌ | ✅ |
| `user.manage` | CRUD user, set role, reset password orang lain | ❌ | ✅ |
| `user.self` | Ganti password sendiri, lihat profil | ✅ | ✅ |
| `settings.farm` | Farm defaults, retention policy, hygiene default, backup/restore DB | ❌ | ✅ |
| `audit.view` | GET /api/audit | ❌ | ✅ |

```ts
// packages/core/src/acl/matrix.ts
export type Role = 'admin' | 'operator'
export type Permission =
  | 'device.view' | 'device.enroll' | 'device.control' | 'device.settings.edit'
  | 'device.owner.set' | 'device.delete' | 'device.quarantine'
  | 'script.view' | 'script.publish' | 'script.delete.own' | 'script.delete.any'
  | 'job.run' | 'job.cancel.own' | 'job.cancel.any' | 'job.view'
  | 'tool.view' | 'tool.manage'
  | 'user.manage' | 'user.self'
  | 'settings.farm' | 'audit.view'

export const ACL_MATRIX: Record<Permission, Role[]> = {
  'device.view':          ['operator', 'admin'],
  'device.enroll':        ['operator', 'admin'],
  'device.control':       ['operator', 'admin'],
  'device.settings.edit': ['operator', 'admin'],
  'device.owner.set':     ['admin'],
  'device.delete':        ['admin'],
  'device.quarantine':    ['admin'],
  'script.view':          ['operator', 'admin'],
  'script.publish':       ['operator', 'admin'],
  'script.delete.own':    ['operator', 'admin'],
  'script.delete.any':    ['admin'],
  'job.run':              ['operator', 'admin'],
  'job.cancel.own':       ['operator', 'admin'],
  'job.cancel.any':       ['admin'],
  'job.view':             ['operator', 'admin'],
  'tool.view':            ['operator', 'admin'],
  'tool.manage':          ['admin'],
  'user.manage':          ['admin'],
  'user.self':            ['operator', 'admin'],
  'settings.farm':        ['admin'],
  'audit.view':           ['admin'],
}
```

`guard.ts`: `requirePermission(perm): MiddlewareHandler` (403 `{ error: { code: 'acl.forbidden' } }`) + helper untuk WS message handler (`assertPermission(user, perm)`).

**Ownership device** (resource-level, dipanggil handler `device.control`, `device.settings.edit`, `job.run`):

```ts
export function canUseDevice(user: User, device: Device): boolean {
  if (user.role === 'admin') return true
  if (!device.ownerId) return true          // device tanpa owner: bebas dipakai semua operator
  return device.ownerId === user.id         // ber-owner: hanya owner (+admin)
}
```

Default sementara (spec tidak menegaskan — lihat Open questions #1): saat enroll, `ownerId = null`; hanya admin yang bisa assign owner. Pelanggaran → 403 `acl.device_owned`. WS `input.*` untuk device yang tidak boleh dipakai di-reject di core (konsisten dengan reject saat `busy`, spec §10.1). `GET /api/registry` ditambah blok `acl: { matrix, role }` supaya Studio render UI dari data yang sama (schema-driven, spec §8) — enforcement tetap di core.

### 4.5 Audit log

File baru: `packages/core/src/audit/service.ts`, `packages/core/src/audit/routes.ts`. Tabel `audit_log` sudah ada (spec §12).

`audit(userId | null, action, target?, meta?)` — dipanggil dari handler terkait. **Daftar action lengkap** (string konstanta di `packages/protocol` supaya Studio type-safe):

| Kategori | Actions |
|---|---|
| Auth/user | `user.login`, `user.login.failed`, `user.logout`, `user.setup`, `user.create`, `user.update`, `user.delete`, `user.password.change`, `user.role.change` |
| Device | `device.enroll`, `device.delete`, `device.settings.update`, `device.owner.set`, `device.quarantine`, `device.unquarantine`, `device.control.start`, `device.control.end`, `device.hygiene.run` |
| Tools | `tool.install`, `tool.activate`, `tool.delete`, `tool.manifest.refresh` |
| Scripts | `script.publish`, `script.update`, `script.delete`, `script.enable`, `script.disable` |
| Jobs | `job.run`, `job.cancel` |
| Settings/sistem | `settings.farm.update`, `retention.policy.update`, `retention.gc.run` (userId null), `system.boot` (userId null) |

`target` = id entitas (deviceId/jobId/userId/toolId+versi); `meta` = JSON kecil (mis. `{ from: 'operator', to: 'admin' }` untuk role change; **tidak pernah** berisi password/token). `user.login.failed` mencatat email yang dicoba + ip di `meta`.

API (admin only, `audit.view`):

```
GET /api/audit?limit=50&before=<cursor>&action=<prefix>&userId=<id>
→ { entries: [{ id, at, userId, userEmail, action, target, meta }], nextCursor }
```

Pagination cursor by `at` DESC + `id`. Filter `action` boleh prefix (`device.` → semua device events). Studio: tab **Audit** di Settings — tabel sederhana (waktu, user, action, target), filter dropdown action + user, tombol "load more". Tidak ada delete/edit dari UI (append-only; pemangkasan usia audit = Open questions #5).

### 4.6 TLS & serving

Perubahan di `packages/core/src/server.ts` (entry `Bun.serve` yang sudah ada):

- `tls.mode: 'self'` → `Bun.serve({ tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) }, ... })`. WS otomatis jadi `wss://` (endpoint sama, upgrade di atas TLS — tidak ada kerja tambahan di protokol).
- `tls.mode: 'external'` → serve HTTP biasa; `X-Forwarded-Proto: https` dianggap secure untuk atribut cookie `Secure`. Dokumentasi menyarankan bind `127.0.0.1` bila proxy satu host (dan itu berarti `auth.mode: 'server'` harus di-set eksplisit karena bind loopback).
- Studio: semua URL WS dibangun relatif dari `location` (`wss:` bila `https:`) — audit kode Studio dari Plan 03/08, hilangkan hardcode `ws://`.

Contoh reverse proxy (masuk `docs/deploy.md`, jalur **direkomendasikan** untuk mode server):

```caddyfile
# Caddyfile — TLS otomatis via ACME
farm.example.com {
  reverse_proxy 127.0.0.1:7788
}
```

nginx: contoh `location /` + `proxy_set_header Upgrade/Connection` untuk WS + `proxy_read_timeout 1h` (stream video WS long-lived) + `X-Forwarded-Proto`.

### 4.7 Data hygiene antar-lease

Extend `DeviceSettings` (Zod, spec §12) + farm-level default di settings farm:

```ts
hygiene: z.object({
  resetBetweenLeases: z.boolean().default(false),        // opt-in (spec §14)
  clearPackages: z.array(z.string()).default([]),        // package yang di-`pm clear`
}).default({}),
```

Mekanisme (`packages/core/src/hygiene/run.ts`):
- Trigger: saat lease dilepas (manual control berakhir ATAU job selesai/failed/cancelled — hook di session/lease manager Plan 04) dan `resetBetweenLeases: true` (per-device override > farm default).
- Eksekusi: untuk tiap package → `pm clear <pkg>` via **per-device command queue** (Plan 01; tidak memblok device lain). `pm clear` = hapus data app + logout paksa — memenuhi "clear app data / logout" spec §14.
- Device baru masuk pool `idle` **setelah** hygiene selesai (state tetap `busy`/leased selama hygiene; timeout hygiene 60 dtk → log warn, device tetap dilepas, audit `device.hygiene.run` dengan `meta.ok: false`).
- Audit `device.hygiene.run` `meta: { packages, ok, ms }`.
- Studio: bagian "Data hygiene" di device settings (schema-driven form dari Zod — otomatis, spec §8) + farm default di Settings.

### 4.8 Artifact retention/GC

File baru: `packages/core/src/retention/gc.ts`, `packages/core/src/retention/routes.ts`.

Policy = `RetentionConfigSchema` (§4.1); nilai runtime bisa dioverride dari Studio (disimpan di tabel settings farm yang sudah ada dari Plan 07; config file = default awal).

Algoritma GC (jalan tiap `gcIntervalMinutes`, plus manual `POST /api/retention/gc` admin):

1. **TTL**: hapus artifacts dengan `createdAt < now - artifactTtlDays` dan job-nya tidak `running`.
2. **Quota per-device**: per device, `SUM(sizeBytes)` artifacts (join jobs→deviceId) > `maxPerDeviceBytes` → hapus dari job dengan `finishedAt` tertua dulu (eviction LRU-proxy) sampai di bawah quota.
3. **Quota global**: `SUM(sizeBytes)` semua artifacts > `maxTotalBytes` → sama, tertua dulu lintas device.
4. Tiap penghapusan: hapus file di `artifacts/<job-id>/...`, lalu row `artifacts`; direktori job kosong ikut dihapus. File hilang tapi row ada (drift) → row tetap dihapus; row hilang tapi file ada (orphan scan ringan di direktori artifacts) → file dihapus.
5. Sekalian: sweep `sessions` expired dan WS ticket kadaluarsa.
6. Audit `retention.gc.run` `meta: { deletedCount, freedBytes, ms }` — hanya bila ada yang dihapus.

Invariant: artifact milik job `status='running'` **tidak pernah** dihapus (langkah 1–3 semua exclude). GC single-flight (skip kalau run sebelumnya masih jalan).

API + Studio:

```
GET  /api/retention          → { policy, usage: { totalBytes, perDevice: [...] } }   (admin)
PUT  /api/retention          → update policy (admin, audit retention.policy.update)
POST /api/retention/gc       → trigger manual, return ringkasan                      (admin)
```

Studio: Settings → Storage/Retention — mengaktifkan placeholder Plan 07: form policy (schema-driven), bar pemakaian disk global + per-device, tombol "Run GC now".

### 4.9 Packaging A — single binary

Script baru: `scripts/build-binaries.ts` (root repo) + `scripts/gen-studio-manifest.ts`.

Pipeline:
1. `bun run --cwd packages/studio build` → Next.js static export (`output: 'export'`, sudah dipakai sejak Plan 07) → `packages/studio/out/`.
2. `gen-studio-manifest.ts` → generate `packages/core/src/studio-assets.gen.ts`: daftar `import path from '../.../out/...' with { type: 'file' }` untuk **setiap** file export + map `urlPath → { file, contentType }`. (Bun meng-embed file yang di-import saat `--compile`; glob runtime tidak ter-embed — karena itu manifest harus di-generate build-time.)
3. Handler static core: mode dev = serve dari disk; mode compiled (`process.env.ENKAKU_EMBEDDED === '1'` di-inject saat build) = serve dari manifest embed.
4. Compile per target:

```bash
bun build --compile --minify \
  --target=bun-darwin-arm64 \      # juga: bun-darwin-x64, bun-linux-x64, bun-linux-arm64
  packages/core/src/main.ts \
  --outfile dist/enkaku-darwin-arm64
```

5. Migration Drizzle: file `.sql` ikut di-embed lewat manifest yang sama (import with type file) — runner migration membaca dari embed, bukan `readdir` (readdir tidak jalan di binary compiled).

**Yang TIDAK di-embed** (dokumentasikan di `docs/deploy.md`): adb/platform-tools, `scrcpy-server.jar`, `ui-server.apk`, appium — semuanya di-download runtime oleh Toolchain Manager ke `<dataDir>/tools/` (Plan 02; first-run provisioning < 90 dtk, spec §16). Binary hasil = core + Studio + migration saja.

Smoke wajib: binary jalan di mesin bersih (tanpa Bun/Node terinstall), first-run auto-provision jalan, mode local tanpa login.

### 4.10 Packaging B — Docker

File baru: `docker/Dockerfile`, `docker/docker-compose.yml`, bagian di `docs/deploy.md`.

```dockerfile
# docker/Dockerfile — outline
# ---- build ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/studio build          # Next static export
RUN bun scripts/gen-studio-manifest.ts
RUN bun build --compile packages/core/src/main.ts --outfile /out/enkaku

# ---- runtime ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libusb-1.0-0 unzip && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/enkaku /usr/local/bin/enkaku
ENV ENKAKU_DATA_DIR=/data ENKAKU_BIND=0.0.0.0
VOLUME /data
EXPOSE 7788
USER 1000:1000
ENTRYPOINT ["enkaku"]
```

`docker-compose.yml`: service `enkaku`, `ports: ["7788:7788"]`, `volumes: ["enkaku-data:/data"]`, env `ENKAKU_AUTH_MODE=server` (bind 0.0.0.0 → server otomatis; tulis eksplisit biar jelas), `ENKAKU_ALLOW_INSECURE=1` **dengan komentar** "hanya untuk trial; produksi wajib TLS/reverse-proxy" + contoh service Caddy opsional.

**Akses device dari container** (dokumentasi, dua jalur):
1. **USB passthrough (Linux host saja)**: `--device=/dev/bus/usb -v /dev/bus/usb:/dev/bus/usb` + udev rule di HOST (`plugdev`, `SUBSYSTEM=="usb", MODE="0664", GROUP="plugdev"`) + user container masuk group tsb. Catatan jujur: hot-plug kadang butuh `-v` (bind mount) karena `--device` tidak mengikuti device baru; Docker Desktop macOS/Windows **tidak bisa** USB passthrough (VM).
2. **Rekomendasi container: adb wireless-only** (`adb-tcp`, pairing wizard Plan 03/spec §15.1) — tanpa privilege khusus, jalan di semua host. Ini rekomendasi default di docs; USB passthrough = advanced.

### 4.11 Packaging C — systemd

File baru: `deploy/systemd/enkaku.service` (+ instruksi install di `docs/deploy.md`):

```ini
[Unit]
Description=Enkaku device farm core
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=enkaku
Group=enkaku
ExecStart=/usr/local/bin/enkaku --config /etc/enkaku/enkaku.config.json
Restart=on-failure
RestartSec=3
Environment=ENKAKU_DATA_DIR=/var/lib/enkaku
StateDirectory=enkaku
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/enkaku
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Instruksi: buat user `enkaku` (masuk group `plugdev` untuk USB), taruh config dengan `bind` LAN + TLS, `systemctl enable --now enkaku`. `dataDir` = `/var/lib/enkaku` (spec §7.2 varian server).

### 4.12 Packaging D — Tauri shell (`apps/desktop`)

Struktur baru: `apps/desktop/` (Tauri v2: `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/capabilities/`).

- **Sidecar**: binary core per-platform (hasil §4.9, dinamai sesuai konvensi Tauri `enkaku-<target-triple>`) didaftarkan sebagai `externalBin`. Saat app start: spawn sidecar dengan `ENKAKU_DATA_DIR` default OS + `--port 0`/port dari config user → poll `GET /api/health` sampai OK (timeout 30 dtk → dialog error + log path) → window navigasi ke `http://127.0.0.1:<port>`. Mode auth otomatis `local` (bind loopback) → tanpa login, zero-config (spec §5.1).
- **Tray**: ikon status (running/error), menu: Open Studio, Restart core, Quit. Close window = minimize ke tray; Quit = kill sidecar (SIGTERM → tunggu 5 dtk → SIGKILL) lalu exit.
- **Single instance**: plugin single-instance; instance kedua memfokuskan window yang ada.
- **Auto-update**: `tauri-plugin-updater` — endpoint manifest update (JSON `latest.json` di GitHub Releases / server rilis), channel dari build config (§4.13). Update bundle berisi shell + sidecar sekaligus. **TODO-verify (keputusan manusia, jangan diputuskan sendiri):** signing per-OS — macOS notarization (Apple Developer ID), Linux AppImage signature, keypair updater Tauri (`TAURI_SIGNING_PRIVATE_KEY`); tanpa key ini updater tidak bisa diaktifkan di build rilis.

### 4.13 Auto-update (lintas kanal)

Satu sumber kebenaran versi: endpoint manifest rilis (mis. `https://releases.<domain>/latest.json` atau GitHub Releases API) — URL dikonfigurasi build-time, channel `stable` (default) / `beta`.

| Kanal distribusi | Mekanisme M7 |
|---|---|
| Tauri desktop | `tauri-plugin-updater`: cek saat start + tiap 24 jam, prompt user, update otomatis. |
| Raw binary / systemd | Core cek manifest tiap 24 jam (opt-out via config) → banner di Studio "vX tersedia" + link. **Tidak** self-replace. |
| Docker | Tidak ada cek in-app khusus selain banner yang sama; docs: `docker compose pull && up -d` (mention Watchtower sebagai opsi user). |

Endpoint internal: `GET /api/version → { current, latest?, channel, updateAvailable }`. Gagal fetch manifest = silent (offline/air-gapped harus tetap jalan mulus).

### 4.14 Studio — layar baru/berubah

- `/login` — form email+password; error state; redirect balik ke halaman asal. Hanya tampil di mode server.
- `/setup` — first-boot admin creation (satu kali).
- Settings → **Users** (admin): list, create (email, password awal, role), ubah role, reset password, delete (revoke semua session-nya). Operator hanya melihat "ganti password sendiri".
- Settings → **Audit** (admin): tabel + filter (§4.5).
- Settings → **Storage/Retention** (admin): §4.8, mengaktifkan placeholder Plan 07.
- Settings → **Security** (admin, read-only info): mode auth efektif, status TLS, bind — membantu diagnosa "kenapa saya tidak ditanya login".
- Device settings: bagian **Data hygiene** (schema-driven, otomatis dari Zod §4.7).
- Header: menu user (email, role, logout) — disembunyikan di mode local.
- Guard sisi client: fetch `GET /api/auth/me` + matrix dari registry → hide/disable menu admin bagi operator (UX saja; core tetap menolak).

## 5. Langkah implementasi

### 5.1 Config core

- [ ] Buat `packages/core/src/config/schema.ts` (Zod §4.1) + `load.ts` (precedence CLI > env > file > default; tulis file default kalau belum ada saat first-run).
- [ ] Refactor entry `packages/core/src/main.ts` + `server.ts`: ambil `bind`/`port`/`dataDir` dari config (gantikan konstanta/env ad-hoc dari Plan 01).
- [ ] Implement `resolveAuthMode()` + validasi boot (`E_INSECURE_BIND`, `E_TLS_REQUIRED`, cert path tidak terbaca) dengan pesan error yang menyebut cara memperbaiki.
- [ ] Unit test: `packages/core/src/config/load.test.ts` — precedence, default, kombinasi bind×auth.mode (tabel §4.1), reject config invalid.
- **Verifikasi:** `bun run dev` tanpa config = perilaku lama (localhost:7788); `ENKAKU_BIND=0.0.0.0 bun run dev` tanpa TLS = exit dengan `E_TLS_REQUIRED`; dengan `ENKAKU_ALLOW_INSECURE=1` = boot + warning.

### 5.2 Tabel sessions + migration

- [ ] Tambah `sessions` ke `packages/core/src/db/schema.ts` (§4.2); generate migration Drizzle.
- [ ] Pastikan `users` & `audit_log` (sudah ada sejak Plan 01) match spec §12; kalau ada drift, migration perbaikan di sini.
- **Verifikasi:** `bun run db:migrate` di DB lama (hasil Plan 08) sukses tanpa kehilangan data; `bun test` schema hijau.

### 5.3 Auth service + middleware + endpoints

- [ ] `packages/core/src/auth/password.ts` — wrapper `Bun.password` argon2id + kebijakan panjang.
- [ ] `packages/core/src/auth/session.ts` — create/validate/revoke/revokeAllForUser, hashing token, sweep expired; WS ticket in-memory store.
- [ ] `packages/core/src/auth/middleware.ts` (§4.3) — pasang global di `/api/*` + upgrade `/ws` dengan allowlist publik.
- [ ] `packages/core/src/auth/routes.ts` — login/logout/me/ws-ticket/password + rate-limit login.
- [ ] `packages/core/src/auth/local-mode.ts` — upsert `local-admin`, inject di middleware.
- [ ] First-boot setup: `hasAnyAdmin()` + `GET/POST /api/auth/setup` + transaksi anti-race.
- [ ] WS upgrade: baca cookie / `?ticket=`; koneksi tanpa auth di mode server ditolak sebelum upgrade.
- [ ] Semua schema request/response di `packages/protocol` (Zod) — tidak ada shape ad-hoc.
- [ ] Unit test `auth/*.test.ts`: hash/verify; session lifecycle (create→validate→expiry→revoke); ticket sekali-pakai; rate-limit; setup race (dua insert paralel → satu 409).
- **Verifikasi:** integration test in-process (Hono `app.request()`): tanpa cookie → 401; login benar → cookie → 200; logout → 401 lagi; mode local → semua 200 tanpa cookie.

### 5.4 ACL + ownership enforcement

- [ ] `packages/core/src/acl/matrix.ts` (§4.4, persis tabel) + `guard.ts` (`requirePermission`, `assertPermission`, `canUseDevice`).
- [ ] Pasang `requirePermission` di SEMUA route yang ada (Plan 01–08): tools (`tool.manage`), users, settings farm, retention, audit, device delete/owner/quarantine, dst. sesuai matrix — sisir route-by-route, buat checklist di PR.
- [ ] Handler WS `input.*`, lease manual, `job.enqueue`, `job.cancel`: cek permission + `canUseDevice`; `job.cancel` bandingkan pemilik job (`jobs` perlu kolom `createdBy`? — cek: kalau belum ada dari Plan 04, tambah kolom `created_by` via migration di tahap 5.2).
- [ ] `GET /api/registry` expose `acl: { matrix, role }`.
- [ ] Unit test table-driven `acl/matrix.test.ts`: iterate SEMUA `Permission × Role`, assert sesuai tabel §4.4; test `canUseDevice` (unowned/owned/owner/admin).
- **Verifikasi:** login sebagai operator → `POST /api/tools/adb/activate` = 403; sebagai admin = jalan; operator kontrol device ber-owner orang lain = 403 + WS input di-reject.

### 5.5 Audit log

- [ ] `packages/core/src/audit/service.ts` + konstanta action di `packages/protocol/src/audit.ts` (§4.5).
- [ ] Panggil `audit()` dari semua handler di daftar §4.5 (sisir; termasuk handler lama Plan 02 tools & Plan 04 jobs).
- [ ] `packages/core/src/audit/routes.ts` — `GET /api/audit` + cursor pagination + filter (guard `audit.view`).
- [ ] Unit test: pagination cursor, filter prefix action; audit gagal tulis tidak menggagalkan request (mock DB error).
- **Verifikasi:** lakukan login→enqueue job→activate tool → `GET /api/audit` menampilkan 3 entry berurutan dengan user benar.

### 5.6 TLS + docs reverse proxy

- [ ] `server.ts`: opsi `tls` Bun.serve untuk mode `self`; deteksi secure-context (TLS langsung / `X-Forwarded-Proto`) untuk cookie `Secure`.
- [ ] Audit Studio: URL WS/API relatif terhadap `location.protocol` (wss bila https).
- [ ] Tulis `docs/deploy.md` bagian TLS: cert user-provided (self), Caddy (rekomendasi) + nginx (WS upgrade + `proxy_read_timeout`), catatan wss.
- **Verifikasi:** generate self-signed cert (`openssl req -x509 ...` — perintah ada di docs), boot `tls.mode: 'self'` → `https://` + video WS jalan (accept self-signed di browser); boot di belakang Caddy lokal → login + stream jalan via https.

### 5.7 Data hygiene antar-lease

- [ ] Extend `DeviceSettings` Zod dengan `hygiene` (§4.7) + farm default di settings farm.
- [ ] `packages/core/src/hygiene/run.ts` + hook di lease-release path (session/lease manager Plan 04) — jalankan via per-device queue, timeout 60 dtk, audit.
- [ ] Studio: form hygiene muncul otomatis (schema-driven); farm default di Settings.
- [ ] Unit test: resolusi setting (per-device override > farm default > off); command yang di-generate (`pm clear x` per package); timeout path.
- **Verifikasi (butuh device, `ENKAKU_TEST_DEVICE=1`):** set `resetBetweenLeases + clearPackages: ['com.android.chrome']`, login manual di Chrome device, akhiri lease → Chrome ter-logout/data bersih; entry `device.hygiene.run` di audit.

### 5.8 Retention/GC

- [ ] `packages/core/src/retention/gc.ts` (algoritma §4.8) + scheduler interval + single-flight.
- [ ] `routes.ts`: GET/PUT `/api/retention`, POST `/api/retention/gc` (guard `settings.farm`/`audit`? → `settings.farm`).
- [ ] Sweep sessions expired ikut di GC.
- [ ] Studio Settings → Storage: aktifkan placeholder Plan 07 (form policy + usage + Run GC now).
- [ ] Unit test `gc.test.ts` dengan fixture dir + DB in-memory: TTL menghapus yang tua; quota per-device evict tertua dulu; quota global; artifact job running TIDAK terhapus; orphan file terhapus; row-tanpa-file dibersihkan; hitungan `freedBytes` benar.
- **Verifikasi:** set TTL 0 hari + jalankan job dummy penghasil screenshot → `POST /api/retention/gc` → file & row hilang, usage di Studio turun, audit `retention.gc.run` tercatat.

### 5.9 Single binary

- [ ] `packages/studio`: pastikan `output: 'export'` build bersih (sudah dari Plan 07); `scripts/gen-studio-manifest.ts` → `packages/core/src/studio-assets.gen.ts` (gitignore file gen).
- [ ] Handler static core: cabang dev (disk) vs embedded (manifest) via `ENKAKU_EMBEDDED`.
- [ ] Migration runner: baca `.sql` dari embed manifest, bukan `readdir`.
- [ ] `scripts/build-binaries.ts`: build studio → gen manifest → `bun build --compile` × 4 target → `dist/enkaku-<platform>`; print ukuran tiap binary.
- [ ] Tambah `bun run build:binaries` di root `package.json`.
- **Verifikasi:** di macOS dev: `dist/enkaku-darwin-arm64` dijalankan dengan `ENKAKU_DATA_DIR` fresh → DB dibuat, migration jalan, Studio tampil dari embed, first-run provisioning tools jalan, mode local tanpa login. Cross-compile linux targets sukses (eksekusi diverifikasi di 5.10/5.11).

### 5.10 Docker

- [ ] `docker/Dockerfile` (§4.10) + `.dockerignore`.
- [ ] `docker/docker-compose.yml` + komentar keamanan + contoh Caddy service opsional (commented).
- [ ] `docs/deploy.md`: bagian Docker — wireless-only (rekomendasi), USB passthrough Linux (`--device`/`-v /dev/bus/usb` + udev), keterbatasan Docker Desktop macOS/Windows.
- **Verifikasi:** `docker build` sukses; `docker compose up` → container healthy, buka `http://<host>:7788` → redirect `/setup` (mode server) → create admin → login → dashboard; data survive `compose down && up` (volume).

### 5.11 systemd

- [ ] `deploy/systemd/enkaku.service` (§4.11) + instruksi install di `docs/deploy.md` (buat user, group plugdev, config, enable).
- **Verifikasi:** di VM Linux (atau container systemd): install binary + unit → `systemctl start enkaku` → aktif; `systemctl restart` → data utuh; kill -9 proses → auto-restart.

### 5.12 Tauri shell

- [ ] Scaffold `apps/desktop` (Tauri v2) masuk workspace; window + navigasi ke core.
- [ ] Sidecar: daftarkan binary core `externalBin` (rename per target-triple di `build-binaries.ts`); spawn + health-poll + error dialog; Quit = SIGTERM→SIGKILL sidecar.
- [ ] Tray (Open Studio / Restart core / Quit) + single-instance plugin + close-to-tray.
- [ ] `tauri-plugin-updater` terpasang tapi **nonaktif by default** sampai signing key ada (TODO-verify §4.12); wiring endpoint manifest siap.
- [ ] Dokumen build: `apps/desktop/README.md` (dev: `bun tauri dev`; build: butuh binary core dulu).
- **Verifikasi:** `bun tauri dev` → window Studio muncul, device terlihat; close window → app di tray, core tetap hidup; Quit → proses core mati (cek `ps`).

### 5.13 Auto-update check

- [ ] `packages/core/src/version/check.ts`: fetch manifest rilis (URL build-time env, no-op kalau kosong/offline), cache 24 jam; `GET /api/version`.
- [ ] Studio: banner non-intrusif "update tersedia" (dismissable) di header untuk admin.
- [ ] Format `latest.json` didokumentasikan di `docs/deploy.md` (dipakai juga oleh Tauri updater).
- **Verifikasi:** mock manifest server lokal versi lebih tinggi → banner muncul untuk admin; tanpa network → tidak ada error di log selain debug.

### 5.14 Studio: login, setup, users, security info

- [ ] `/login`, `/setup` (App Router, di luar shell utama), redirect logic dari 401 + `setupNeeded`.
- [ ] Settings → Users (admin CRUD §4.14), Audit (§4.5), Security info (mode auth, TLS, bind).
- [ ] Menu user di header (mode server) / hidden (mode local); guard client dari `me` + matrix registry.
- **Verifikasi:** alur end-to-end mode server: setup → login admin → buat operator → logout → login operator → menu admin tidak tampil & API admin 403; ganti password operator → session lama tertendang.

## 6. Acceptance criteria

Semua harus lulus:

1. **Zero-config utuh**: binary dijalankan tanpa argumen di laptop → bind `127.0.0.1`, tanpa login, semua fitur Plan 01–08 tetap jalan (regresi manual dasar: enroll, control, run job, scrcpy stream).
2. `ENKAKU_BIND=0.0.0.0` tanpa TLS → boot ditolak dengan `E_TLS_REQUIRED`; dengan `ENKAKU_ALLOW_INSECURE=1` → boot + warning; dengan `tls.mode: 'self'` + cert → serve https/wss.
3. Mode server first-boot → `/setup` membuat admin sekali; percobaan kedua = 409.
4. Login benar = cookie httpOnly (+`Secure` saat https); salah 5× = 429 sementara; logout mematikan session; WS tanpa cookie/ticket di mode server ditolak.
5. Seluruh matrix §4.4 di-enforce core: minimal diverifikasi test integrasi untuk `tool.manage`, `user.manage`, `settings.farm`, `audit.view`, `job.cancel.any`, `device.owner.set` (operator = 403).
6. Device ber-owner tidak bisa dikontrol/di-run-job operator lain (HTTP 403 + WS reject); device tanpa owner bisa dipakai semua operator.
7. Audit log terisi untuk seluruh daftar action §4.5 yang tersentuh alur uji; `GET /api/audit` hanya admin; tampilan Audit di Studio jalan (filter + load more).
8. Hygiene opt-in: dengan `resetBetweenLeases` aktif, `pm clear` berjalan pada release lease dan device kembali `idle` setelahnya (test device fisik, `ENKAKU_TEST_DEVICE=1`).
9. GC: unit test §5.8 hijau; smoke TTL-0 menghapus artifact + file; artifact job running tidak pernah terhapus; setting retention bisa diubah dari Studio dan tersimpan.
10. `bun run build:binaries` menghasilkan 4 binary; binary macOS diverifikasi di mesin/akun bersih (tanpa Bun): first-run OK, Studio ter-embed, tools ter-download runtime.
11. `docker compose up` dari repo bersih → setup → login → dashboard; volume data persisten.
12. systemd unit: start/restart/auto-restart on crash diverifikasi di VM Linux.
13. Tauri dev build: window + tray jalan; Quit menghentikan proses core; auto-update wiring ada (nonaktif tanpa signing key, ditandai TODO-verify).
14. `GET /api/version` + banner update jalan dengan mock manifest; offline tidak menimbulkan error.
15. `bun test` hijau di seluruh workspace; tidak ada endpoint `/api/*` baru tanpa guard permission (review checklist di PR).

## 7. Test plan

### 7.1 Unit test (`bun test`, colocated)

| File | Cakupan |
|---|---|
| `core/src/config/load.test.ts` | Precedence CLI>env>file>default; tabel resolusi auth mode ×bind; reject `local`+non-loopback; reject server tanpa TLS. |
| `core/src/auth/password.test.ts` | Hash argon2id + verify; tolak password < 8. |
| `core/src/auth/session.test.ts` | Token tidak tersimpan plaintext (cek DB berisi hash ≠ token); validate/expiry/revoke/revokeAll; ticket sekali-pakai + TTL. |
| `core/src/auth/routes.test.ts` | In-process Hono: login sukses/gagal/rate-limit 429; logout; `me`; setup sekali-jalan + race (Promise.all dua setup → tepat satu 200). |
| `core/src/acl/matrix.test.ts` | Table-driven: SEMUA Permission × Role sesuai tabel §4.4 (test gagal kalau matrix berubah tanpa update tabel plan). |
| `core/src/acl/guard.test.ts` | `requirePermission` 401/403/200; `canUseDevice` 4 kasus. |
| `core/src/audit/service.test.ts` | Insert + pagination cursor + filter prefix; DB error tidak melempar ke caller. |
| `core/src/hygiene/run.test.ts` | Resolusi override; urutan `pm clear` per package via mock queue; timeout. |
| `core/src/retention/gc.test.ts` | Fixture tmp-dir + DB in-memory: TTL, quota per-device, quota global, eviction order (finishedAt tertua), proteksi job running, orphan/drift cleanup, freedBytes. |

### 7.2 Integration (in-process, tanpa device)

- Boot core test-mode (`ENKAKU_DATA_DIR` tmp) dalam mode server → alur penuh: setup → login → create operator → operator ditolak di endpoint admin (daftar di AC #5) → cancel job orang lain 403 → admin sukses.
- WS: koneksi tanpa auth ditolak; dengan cookie diterima; dengan ticket expired ditolak.

### 7.3 Smoke manual (perintah eksplisit, didokumentasikan di plan/PR)

```bash
# 1. Binary di mesin bersih (macOS tanpa Bun — akun user baru / VM)
./enkaku-darwin-arm64                      # → browser localhost, tanpa login, enroll device OK

# 2. Mode server + TLS self-signed
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout key.pem -out cert.pem -days 30 -nodes -subj "/CN=farm.local"
ENKAKU_BIND=0.0.0.0 ENKAKU_TLS_MODE=self ENKAKU_TLS_CERT=cert.pem \
  ENKAKU_TLS_KEY=key.pem ./enkaku-darwin-arm64
# → https://<ip>:7788 → /setup → login → stream video via wss OK

# 3. Docker
docker compose -f docker/docker-compose.yml up --build
# → http://<host>:7788 → setup/login → pair device wireless → control OK
docker compose down && docker compose up   # data persisten

# 4. systemd (VM Linux)
sudo systemctl start enkaku && systemctl status enkaku
sudo kill -9 $(pgrep enkaku) && sleep 5 && systemctl is-active enkaku   # auto-restart

# 5. Tauri
bun tauri dev                              # window+tray; Quit → pgrep enkaku kosong

# 6. GC
# set artifactTtlDays=0 via Studio → run job screenshot → Settings→Storage→Run GC → hilang

# 7. Hygiene (ENKAKU_TEST_DEVICE=1, device fisik)
# aktifkan resetBetweenLeases utk device, clearPackages Chrome → manual lease → release → cek Chrome bersih
```

### 7.4 Regresi NFR (spec §16)

Auth middleware + audit tidak boleh menambah latensi terasa: cek glass-to-glass manual control tetap < 150 ms LAN (Plan 08 harness) dengan auth mode server aktif.

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| `bun build --compile` gagal meng-embed asset/migration dengan pola import tertentu, atau ukuran binary bengkak | Packaging macet | Manifest asset di-generate build-time (import statis, bukan glob runtime); smoke embed dites paling awal di tahap 5.9; kalau embed Studio buntu, fallback terdokumentasi: zip Studio export di samping binary (dicatat sebagai deviasi, bukan diam-diam). |
| Cross-compile `--target=bun-linux-*` dari macOS menghasilkan binary yang tak jalan (edge case native module) | Rilis Linux cacat | Core sengaja tanpa native module npm (argon2 = `Bun.password` built-in, SQLite = `bun:sqlite`); verifikasi eksekusi Linux di Docker/VM (5.10/5.11), bukan cuma "compile sukses". |
| Menyisir guard ke semua route lama ada yang kelewat → endpoint admin bocor ke operator | Lubang ACL | Middleware global default-deny opsi: route tanpa `requirePermission` eksplisit ditandai; test integrasi menembak daftar endpoint sensitif (AC #5); checklist route di PR. |
| Cookie `Secure` + reverse proxy salah konfigurasi → login loop | UX rusak di deploy nyata | Mode `external` percaya `X-Forwarded-Proto` terdokumentasi; halaman Security info (§4.14) menampilkan apa yang core lihat; docs deploy berisi troubleshooting. |
| `pm clear` pada package sistem/launcher membuat device tidak stabil | Device farm rewel | Hygiene opt-in + docs peringatan; validasi nama package (regex) ; timeout + audit `ok:false`; tidak pernah `pm clear` otomatis tanpa konfigurasi eksplisit. |
| GC menghapus artifact yang sedang di-stream/diunduh user | Download gagal sesekali | Eviction hanya job selesai + tertua dulu (jarang sedang diakses); operasi delete per-file, error ENOENT di-ignore; bukan masalah correctness DB. |
| USB passthrough Docker rapuh (hot-plug, Docker Desktop tak bisa) | Ekspektasi user salah | Dokumentasi memposisikan wireless-only sebagai rekomendasi container; USB = advanced Linux-only dengan udev; tidak dijanjikan di README utama. |
| Tauri signing/notarization butuh akun & rahasia yang belum ada | Auto-update desktop tertunda | Updater dikapalkan nonaktif-by-default + TODO-verify eksplisit; fungsi desktop lain tidak bergantung updater. |
| Rate-limit login in-memory tidak melindungi dari brute force terdistribusi internet | Keamanan mode server di internet publik | Docs: mode server di internet WAJIB di belakang reverse proxy (fail2ban/Cloudflare); Enkaku target LAN/homelab di M7, internet publik = pertimbangan M8/cloud. |

## 9. Open questions

1. **Kebijakan ownership device** — spec §12 hanya punya `devices.ownerId` tanpa aturan. Default sementara plan ini: enroll → `ownerId: null` (bebas dipakai semua operator); hanya admin bisa assign owner; device ber-owner = owner+admin saja. Alternatif yang butuh keputusan: (a) enroller otomatis jadi owner? (b) owner boleh melepas ownership sendiri? (c) device ber-owner boleh "dipinjam" kalau idle?
2. **Operator boleh hapus/disable script buatan orang lain?** Default plan: tidak (`script.delete.any` = admin). Tim kecil mungkin mau lebih longgar.
3. **Login pakai email atau username?** Schema spec §12 pakai `email` unique — plan mengikuti (email), tapi farm internal mungkin lebih suka username tanpa format email. Mengubah = migration ringan, putuskan sebelum 5.3.
4. **Session TTL & "remember me"** — default 30 hari satu tier. Perlu dua tier (short default + remember-me panjang)?
5. **Retensi audit_log sendiri** — append-only tanpa batas akan tumbuh. Ikutkan TTL audit (mis. 180 hari) ke GC, atau biarkan sampai M7.5/M8? (Belum disentuh spec.)
6. **Windows support** — spec §7.2 menyebut path `%APPDATA%\Enkaku`, tapi M7 menargetkan binary macOS/Linux saja (sesuai scope task). Kapan Windows masuk (butuh verifikasi USB/adb + Bun compile win-x64)?
7. **Nama & registry Docker image** (`ghcr.io/<org>/enkaku`?) dan kebijakan tag (`latest`, `vX.Y.Z`, `beta`) — keputusan rilis, berkaitan dengan Plan 10.
8. **URL endpoint manifest update** (domain rilis vs GitHub Releases) + kepemilikan signing key Tauri/Apple Developer — keputusan manusia sebelum rilis publik; build M7 cukup dengan mock/placeholder.
9. **`jobs.createdBy`** — dibutuhkan untuk `job.cancel.own` vs `any`. Kalau Plan 04 belum menambahkan kolom ini, plan ini menambah via migration (tahap 5.2) — konfirmasi tidak bentrok dengan asumsi Plan 04/05.
10. **Auto-create admin lokal memakai email `admin@localhost`** — perlukah bisa dikustom (mis. untuk transisi laptop→server membawa DB yang sama)? Saat transisi mode local→server, `local-admin` tanpa password tidak bisa login — flow yang diusulkan: setup page tetap muncul (karena tak ada admin ber-password) dan `local-admin` dinonaktifkan; konfirmasi UX ini.
