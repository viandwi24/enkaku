# @enkaku/studio

Web UI Enkaku (Next.js App Router, static export).

## Mode dev

```bash
# terminal 1 — core
ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run --cwd packages/core dev
# terminal 2 — studio (hot reload)
NEXT_PUBLIC_ENKAKU_CORE_URL=http://localhost:7700 bun run --cwd packages/studio dev
# buka http://localhost:3001
```

Core mengizinkan CORS dari `localhost:*` hanya saat `NODE_ENV !== 'production'`.

## Mode prod (satu origin)

```bash
bun run --cwd packages/studio build     # → packages/studio/out
bun run --cwd packages/core dev         # core serve out/ di /
# buka http://localhost:7700
```

Lokasi build bisa di-override dengan `ENKAKU_STUDIO_DIST`.

## Konfigurasi

Konfigurasi package ini mengikuti keluaran `create-next-app` (TypeScript, App Router, tanpa Tailwind/ESLint) supaya tidak menyimpang dari konvensi Next:

- `tsconfig.json` **berdiri sendiri**, tidak meng-extend `tsconfig.base.json` repo. Base repo menyetel opsi untuk Bun/TypeScript 7 (`types: ["bun"]`, `verbatimModuleSyntax`) yang bertabrakan dengan toolchain Next.
- `typescript` dan `@types/*` dipasang sebagai devDependency **lokal package ini** pada versi 5.x. Root repo memakai TypeScript 7 untuk typecheck-nya sendiri; Next memanggil API compiler TS 5, jadi keduanya harus hidup berdampingan.
- `next-env.d.ts` dibuat ulang otomatis tiap `dev`/`build` dan tidak dilacak git.

## Catatan

Halaman device memakai query param `/device?id=<deviceId>` (bukan route dinamis `[id]`) karena static export tidak bisa pre-render id dinamis.
