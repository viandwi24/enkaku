# @enkaku/studio

The Enkaku web UI (Next.js App Router, static export).

## Dev mode

```bash
# terminal 1 — core
ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run --cwd packages/core dev
# terminal 2 — studio (hot reload)
NEXT_PUBLIC_ENKAKU_CORE_URL=http://localhost:7700 bun run --cwd packages/studio dev
# open http://localhost:3001
```

The core only allows CORS from `localhost:*` while `NODE_ENV !== 'production'`.

## Prod mode (single origin)

```bash
bun run --cwd packages/studio build     # → packages/studio/out
bun run --cwd packages/core dev         # the core serves out/ at /
# open http://localhost:7700
```

The build location can be overridden with `ENKAKU_STUDIO_DIST`.

## Configuration

This package's configuration follows what `create-next-app` produces (TypeScript, App Router, no Tailwind or ESLint scaffolding) so it does not drift from Next's conventions:

- `tsconfig.json` **stands alone** and does not extend the repo's `tsconfig.base.json`. The base sets options for Bun and TypeScript 7 (`types: ["bun"]`, `verbatimModuleSyntax`) that collide with Next's toolchain.
- `typescript` and `@types/*` are devDependencies **local to this package**, pinned to 5.x. The repo root uses TypeScript 7 for its own typecheck; Next calls the TS 5 compiler API, so both have to coexist.
- `next-env.d.ts` is regenerated on every `dev` and `build` and is not tracked by git.

## Design system

Tokens, screen patterns, and writing rules live in [`docs/design.md`](../../docs/design.md). One rule worth repeating: write Tailwind v4 colour classes as `bg-surface` and `text-fg-muted`, never `bg-[--color-surface]` — the v3 bracket form compiles to nothing in v4 and fails silently.

## Notes

The device page uses the query param `/device?id=<deviceId>` rather than a dynamic `[id]` route, because a static export cannot pre-render dynamic ids.

## Tab lifecycle and the Wall (plan 42)

The device page's tabs stay mounted and are hidden with the `hidden` HTML attribute (`TabPanel` in `app/device/page.tsx`) instead of being conditionally rendered — a tab switch no longer unmounts `LiveView`, which is what makes returning to Control instant instead of replaying the wake-up sequence. **Monitor and Crashes are the deliberate exception**: each holds a device-side `logcat` stream, so they stay mount-on-demand exactly as before, with their own cleanup effect stopping the stream on unmount. A gated panel like `FilesPanel` renders its controls disabled with one explanatory line rather than an empty panel, so "Take control" from any tab takes effect immediately without a tab switch.

The devices list's **Wall** mode (`components/wall/`) shows every device's screen live in a grid — the same `LiveView` component in a `compact`, read-only mode, subscribed at the `wall` quality profile. `TileGrid` is the one responsive grid layout, reused by the topology page's `ClusterSection` too. At most `wall.maxTiles` (a farm setting) tiles stream at once; the rest render a placeholder with a "Show live" action. Offline and quarantined devices always render a static card with the reason, never a blank tile.
