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

## Catatan

Halaman device memakai query param `/device?id=<deviceId>` (bukan route dinamis `[id]`) karena static export tidak bisa pre-render id dinamis.
