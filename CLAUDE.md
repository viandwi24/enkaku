# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Enkaku** (repo codename: `openpf`) — a self-hosted Android device farm platform: remote control plus script automation through one web UI. A Bun workspaces monorepo (`packages/*`, `apps/*`, `examples`).

## Reference documents (read as needed; do not duplicate their contents here)

- `docs/spec.md` — the product spec, the **single source of truth**. If a plan or the code contradicts the spec, the spec wins.
- `docs/plans/00-overview.md` — **required reading before touching any plan**: immutable stack decisions (§3), repo/TS/API/test/commit conventions (§4), Definition of Done (§7).
- `docs/plans/01..16-*.md` — milestone plans M0–M10 (a nine-section template, with acceptance criteria per plan).
- `docs/design.md` — the Studio design system: tokens, screen patterns, writing rules, quality floor.
- `docs/guide/` — user guides: `install.md`, `cloud.md`, `enrollment.md`, `redroid.md`.
- `docs/acceptable-use.md` and `LICENSES.md` — the AUP and the redistribution audit (adb is NOT redistributed; it is downloaded on first run and sha256-verified).

## Language

All documentation, code comments, identifiers, UI copy, and commit messages are written in **English**. Commit style: conventional (`feat(m8): ...`, `fix(studio): ...`).

## Commands

Runtime and package manager: **Bun** (not Node/npm). From the root:

```bash
bun run dev            # local core on :7700 (data in .dev-data/)
bun run dev:studio     # Next dev on :3001, pointing at the core on :7700
bun run dev:cloud      # control plane (ENKAKU_MODE=orchestrator, data in .dev-cloud/)
bun run dev:node       # cloud node (needs ENKAKU_CP_URL; plus ENKAKU_ENROLL_TOKEN on first run)
bun run dev:desktop    # Tauri (needs Rust; usually ENKAKU_CORE_BIN=<path>)
bun run typecheck      # every package — do NOT run scripts/typecheck.sh via `bun run <file.sh>` (Bun misreads the shebang); use this root script or `bash scripts/typecheck.sh`
bun run build:studio   # static export to packages/studio/out (served by the core = single origin)
bun run build:packs    # bundle examples/*-pack.ts into packages/core/packs/ (embedded in the release binary)
bun run reset          # delete .dev-data/.dev-cloud/.dev-node
bun run --cwd packages/core db:generate   # generate a Drizzle migration after changing src/db/schema.ts
bun run build:guest-agent   # on-device APK (needs JDK 17 + Android SDK; see apps/guest-agent/README.md)
bun run doctor              # environment check: toolchain integrity, adb, egress
bun run probe-server        # the self-hosted egress/geo/DNS probe endpoint (plan 51 §5.3); routes degrade to `skip` when it is unset, never to a false `ok`
bun test                    # every package EXCEPT studio (which bun test cannot see — read below); device-dependent tests are gated behind ENKAKU_TEST_DEVICE=1
bun run --cwd packages/studio test   # studio's own tests — a SEPARATE, REQUIRED command; see below before assuming a bare `bun test` covers Studio
```

Tests run with `bun test`; `*.test.ts` files are colocated in `src/`, and anything needing a physical device is gated behind `ENKAKU_TEST_DEVICE=1`. `packages/studio` and `examples` sit outside `bunfig.toml`'s `[test] root = "packages"` and each run as their own invocation (`bun run --cwd packages/studio test`, `bun run --cwd examples test`) — CI runs all three. There is still no linter or formatter — the observed code style is no semicolons, single quotes, two-space indent.

**A bare `bun test` from the repo root never runs `packages/studio`'s tests — this is intentional, and `packages/studio` must be tested with the separate command above.** The root `bunfig.toml` excludes it via `[test].pathIgnorePatterns = ["packages/studio/**"]` (matched from the repo root, not from `[test].root` above it — that setting only changes where Bun *scans*, not what the ignore pattern is relative to). This exists because Studio's component/page tests render through `@testing-library/react` against a real DOM (`happy-dom`, registered by `packages/studio/bunfig.toml`'s own `[test].preload`), and Bun's preload is a single global list for the WHOLE invocation — there is no per-directory scoping within one `bun test` run. Preloading happy-dom globally was tried and broke core tests that stub `globalThis.fetch` themselves, because happy-dom's registration installs its own `fetch`/`WebSocket`/etc. `packages/studio/package.json`'s `test` script also passes `--isolate`, which is required, not cosmetic: several component tests use `mock.module('@/lib/ws', ...)`, and without `--isolate` a mock installed by one test FILE leaks into every file that runs after it in the same process (a documented Bun behavior), silently poisoning unrelated tests depending on file execution order. `.github/workflows/ci.yml` runs both commands — a green `check` job means both.

**After cloning, run `git submodule update --init --recursive`** — `apps/guest-agent` vendors `hev-socks5-tunnel`, and without it the Android build fails on a missing `Android.mk`.

## Rules that get broken when you do not know them

- **Immutable stack decisions** (detail in `docs/plans/00-overview.md` §3): Bun + Hono core, Next.js Studio, SQLite + Drizzle, Zod 4 at every boundary, version-locked scrcpy-server (`packages/scrcpy/src/version.ts` is the only source of that version — never fork the Java side).
- **Two TypeScripts — do not merge them**: the root uses TypeScript 7 with `tsconfig.base.json` (bun types, verbatimModuleSyntax); `packages/studio` is deliberately standalone with a local TypeScript 5 and a tsconfig that does NOT extend the base (Next needs the TS 5 compiler API). Both must coexist.
- **`adb kill-server` is forbidden** except inside the Toolchain Manager's adb swap flow (port 5037 is shared with Android Studio).
- Cross-package imports always go through the package name (`@enkaku/...`), never a relative path across packages. WS message types and strings come only from `@enkaku/protocol` — never hardcode them elsewhere.
- Validate external input (WS, HTTP bodies, JSON DB columns, config files) through Zod; never `as`-cast. DB timestamps are integer unix **seconds** (Drizzle `mode: 'timestamp'`).
- Device identity is `stableId` (ro.serialno → ANDROID_ID fallback); the adb serial is only a transport address.
- Job isolation is **crash containment** — never call it a "sandbox". A script's `finish()` must be stateless and idempotent (after a timeout kill, the core runs it again in a fresh process).
- Studio: static export (`output: 'export'`) — the device page uses `/device?id=...` (not a dynamic route), internal links must use `next/link` (a plain `<a>` remounts React and kills the WS and video), and workspace packages go in `transpilePackages`.
- Tailwind v4 colour classes: write `bg-surface` and `text-fg-muted`, never `bg-[--color-surface]`. The v3 bracket form compiles to nothing in v4 and fails silently. See `docs/design.md`.
- The `/ws` protocol has no snapshot replay: a client must `GET /api/devices` first, then subscribe.
- The driver subsystem has **five** layers, not four: transport, display, input, inspector, and `network` (spec §7.9). The network layer is the only optional one — its default engine is `none`, and `vpn-helper` (a SOCKS5 full tunnel through the on-device guest agent) is the only engine an app under test cannot bypass. It deliberately does not advertise a `probe` capability, so its status is reported `unverified`, never `ok`.
- The guest agent APK resolves in three tiers, first match wins: `ENKAKU_GUEST_AGENT_PATH`, then a local Gradle build under `apps/guest-agent/app/build/outputs/apk/`, then the sha256-pinned artifact from the Toolchain Manager. It is never auto-built.
- Config precedence is env > file > default; an invalid config fails the boot (`E_BAD_CONFIG`) and must never silently fall back. Auth mode derives from the bind address (non-loopback ⇒ server mode ⇒ TLS required unless `ENKAKU_ALLOW_INSECURE=1`).

## Dev environment notes

- Local dev works with no env vars at all (`bun run dev`). `.env.example` at the root is the reference for every variable the code reads; `docs/guide/install.md` has the prose.
- Bun loads the root `.env` automatically for anything it runs as code (core, node, `scripts/`), but **does NOT expand it inside `package.json` script strings** — so `dev:studio`'s `${NEXT_PUBLIC_ENKAKU_CORE_URL:-…}` never sees it. Studio's variables belong in `packages/studio/.env`, which Next loads itself.
- First run downloads the tools (adb, scrcpy-server, ui-server) in under a minute; the system adb on PATH is never used.
- CORS for `localhost:*` is only active when `NODE_ENV !== 'production'` — that is what lets Studio dev on :3001 talk to the core on :7700.
- `.github/workflows/ci.yml` runs `bun run typecheck`, `bun test`, and (separately, per the note above) `bun run --cwd packages/studio test` on every push and PR (job `check`), plus a path-conditional `android` job that builds the guest agent APK (debug) whenever `apps/guest-agent/**` or `scripts/build-guest-agent.sh` changes. `.github/workflows/release.yml` is separate: it builds per-OS binaries on a `v*` tag, boots each one and checks `/api/health` before publishing. Neither CI job touches a physical device — that gap is `bun run smoke:guest-agent`, gated behind `ENKAKU_TEST_DEVICE=1` (docs/plans/50-m24a-ci-and-device-smoke-test.md). A green CI badge says the workspace typechecks and tests; it says nothing about whether the guest agent works on hardware.
- The release workflow does **not** build the guest agent APK yet; publishing and pinning it is plan 43 §5.11.
