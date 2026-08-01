# @enkaku/sdk

SDK untuk menulis script automation Enkaku. Ditulis di editor sendiri (autocomplete penuh), lalu di-publish ke farm.

```bash
bun add @enkaku/sdk zod
```

## Bentuk script

```ts
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'post-content',
  version: '2.0.0',
  params: z.object({ caption: z.string() }),
  timeout: 180_000,   // per attempt, default 300_000
  retries: 1,         // attempt tambahan setelah gagal, default 0

  async prepare(ctx) {          // siapkan device — boleh gagal & retry
    await ctx.device.app.forceStop('com.myapp')
    await ctx.device.app.launch('com.myapp')
  },

  async run(ctx) {              // kerjaan inti; return value → jobs.result
    await ctx.device.tap({ desc: 'Buat postingan' })
    await ctx.device.waitFor({ id: 'caption_input' })
    await ctx.device.type(ctx.params.caption)
    await ctx.artifact.screenshot('sebelum-post')
    return { ok: true }
  },

  async finish(ctx) {           // SELALU jalan — bersihkan state
    if (ctx.error) await ctx.artifact.screenshot('gagal')
    await ctx.device.app.forceStop('com.myapp')
  },
})
```

## Aturan penting

**`finish` harus stateless & idempotent.** Kalau attempt kena timeout dan process-nya sudah dibunuh paksa, core menjalankan `finish` di **process baru** (finish-only attempt) supaya janji "device balik clean" tetap ditepati. Process baru tidak berbagi memori dengan `run` yang mati: variabel closure, koneksi, dan file handle hilang. Jadi `finish` hanya boleh bergantung pada `ctx`.

**Selector berlapis** — dari stabil ke rapuh: `{ id }` → `{ desc }` → `{ text }` → `{ point }`. Satu selector berisi tepat satu kunci.

**`type()` di M4 hanya ASCII printable** (memakai `adb shell input text`). Teks unicode/IME menyusul lewat `ui-server.set_text` (M4.5) dan input UHID (M6).

**`waitFor` = polling inspector, bukan sleep.** Di M4 inspector-nya `uiautomator dump` (0,5–2 detik per query), jadi interval default 1 detik. M4.5 mengganti ke `ui-server` (<200 ms) tanpa mengubah API ini.

## Trust model — jujur

Tiap job berjalan di **child process** dengan hard-timeout. Yang dijamin hanya **crash containment**: script yang crash atau hang tidak menjatuhkan core, dan timeout selalu membebaskan device.

Ini **bukan security sandbox**. Bundle script punya akses filesystem dan network penuh sebagai OS user yang menjalankan core. Di mode local/self-host, script author diperlakukan sebagai **operator tepercaya**. Isolasi keamanan sungguhan (container/microVM per job) adalah pekerjaan mode cloud multi-tenant.

## Publish

```bash
bunx enkaku publish ./scripts/post-content.ts --farm http://localhost:7700
```

CLI mem-bundle script + seluruh dependency jadi satu file ESM (farm tidak pernah meng-install dependency), meng-import-nya untuk validasi, mengubah `params` Zod jadi JSON Schema (dipakai Studio untuk auto-generate form), lalu POST ke `/api/scripts`.

Tiap publish membuat row baru; kombinasi `(name, version)` unik — naikkan `version` untuk publish ulang. Job menyimpan `scriptId` row spesifik, jadi run lama tetap reproducible setelah versi baru terbit.

Token opsional lewat `--token` atau env `ENKAKU_TOKEN` (dibutuhkan kalau core dijalankan dengan `ENKAKU_PUBLISH_TOKEN`).
