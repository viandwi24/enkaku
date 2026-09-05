# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Enkaku** (repo codename: `openpf`) — a self-hosted Android device farm platform: remote control plus script automation through one web UI. A Bun workspaces monorepo (`packages/*`, `apps/*`, `examples`).

## Reference documents (read as needed; do not duplicate their contents here)

- `docs/spec.md` — the MVP specification, rewritten by plan 202 from `docs/mvp/`. A section with decided text is the single source of truth: if a plan or the code contradicts it, the spec wins. A section marked `TBD by plan NNN` has no authority; until that plan lands, the `docs/mvp/` document it names is the decision of record.
- `docs/plans/200-mvp-program.md` — **required reading before touching any MVP plan**: the rules for an executing agent, the plan format (§0 goal checklist, §10 removed, §11 handoff), the wave table, the verified external references, and the vocabulary (§2.4).
- `docs/plans/00-overview.md` — still binding for §3 (immutable stack decisions), §4 (repo/TS/API/test/commit conventions), §6 (plan template), §7 (Definition of Done); its roadmap describes the archived prototype series.
- `docs/plans/201-*.md` to `154-*.md` — the MVP series, one plan per wave-table row in 200 §4.
- `docs/plans/300-flow-program.md` and `301-*.md` to `312-*.md` — the **Flow** programme: the workflow editor rebuilt as a real graph editor (explicit edges, stored positions, a node catalog plugins can extend, an expression engine, data panes, run replay). Read 300 first — it carries the twelve-interaction parity parameter and the eight decisions every other plan in the series depends on. D4 (expressions) was ratified 2026-09-04 and 301-307 are implemented; D5 (fan-out) is still open. Plans 309-312 are draft: simulate, the script palette, presets, and the `set` node.
- `docs/mvp/` — the decision documents the MVP is built from (01 to 16 plus the design handoff); `16-consolidated-plan.md` wins where they disagree.
- `docs/archive/` — the prototype spec (`spec-prototype.md`), plans 01 to 129 plus the five M95 to M99 plans that carried the numbers 130 to 134, and the audits. History, not authority; `docs/archive/README.md` says how to resolve an old citation.
- `docs/design.md` — the Studio design system: tokens, screen patterns, writing rules, quality floor (rewritten from the design handoff as the wave 3 screens land).
- `docs/guide/` — user guides: `install.md`, `cloud.md`, `enrollment.md`, `redroid.md`, `mikrotik-routing.md`.
- `LICENSES.md` — the redistribution audit (adb is NOT redistributed; it is downloaded on first run and sha256-verified).

The MVP series (plans 200 to 154) is executed on branch `mvp`; read `docs/plans/200-mvp-program.md` first. `main` stays shippable for hotfixes until wave 3 lands.

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
bun test <path>             # ONLY the file or directory you changed, one invocation at a time. Backend packages only: Studio and @enkaku/ui have no tests (plan 200 §8.3)
bun test                    # OWNER AND CI ONLY until plan 224 retires this rule; device-dependent tests are gated behind ENKAKU_TEST_DEVICE=1
```

Tests run with `bun test`; `*.test.ts` files are colocated in `src/`, and anything needing a physical device is gated behind `ENKAKU_TEST_DEVICE=1`. **Studio and `@enkaku/ui` have zero tests, by decision (2026-09-03, `docs/plans/200-mvp-program.md` §8.3)**: never write a `*.test.tsx`, never add happy-dom or testing-library, never add a `[test].preload`. Backend tests exist only for the critical list in that section (protocol schemas and binary framing, the activity policy and target resolvers, migrations, queue and runs, demuxer and HID encoders, the plugin pipeline, the inspector lifecycle, toolchain verification). A test that asserts UI copy, route wiring, or a snapshot is deleted, not maintained. UI is verified by `bun run typecheck`, the design handoff (`docs/mvp/design_handoff_enkaku_openpf/`), and an owner smoke at each wave gate. There is still no linter or formatter — the observed code style is no semicolons, single quotes, two-space indent.


**After cloning, run `git submodule update --init --recursive`** — `apps/guest-agent` vendors `hev-socks5-tunnel`, and without it the Android build fails on a missing `Android.mk`.

### NEVER run a full test suite. Run only the tests for the files you changed.

**Measured by plan 224 at 140.66 s (root `bun test`, 5274 pass, 1 skip, 10 fail across 364 files; those 10 were `jobs/executors/script.test.ts`, repaired at the R8 gate — the timing stands, the failure count does not) — still over the 60 s target, so this rule stays in force.** `packages/core` alone accounts for 91.19 s of it (234 of the 364 files); the other nine backend packages together cost about 50 s. The owner runs the full suite manually at wave gates; an agent never does.

```bash
bun test packages/core/src/plugins/binding.test.ts          # yes — one file
bun test packages/core/src/plugins/                          # yes — the directory you touched
bun test                                                     # NO
```

**If you cannot scope a run to the files you touched, skip testing entirely and say so in your report.** A skipped test is a known gap; a suite that cooks the machine is a real cost paid every time, for coverage nobody asked for.

Why: the prototype's Studio suite (about 170 isolated processes, about 80 s) run by four agents at once took over six minutes, pinned every core, and overheated the laptop on 2026-08-17. That suite is deleted by plan 201; the rule stays for the backend until the measured suite is cheap.

Two corollaries that caused that incident and must not be repeated:

- **Do not put a full-suite command in a subagent's definition of done.** Scope every worker's verification to what it actually touched.
- **Never run two test invocations at once.** Besides the CPU cost, concurrent runs share `packages/sdk/src/cli/.test-fixtures` and report inflated, fictional failure counts (25 and 43 were observed for a tree that genuinely had 3).

`bun run typecheck` is cheap and is the exception — run it freely.

**Never run `git stash` (or any whole-tree operation) while other agents may be working.** One agent stashed the tree to establish a baseline and wiped 203 tracked modifications plus 121 untracked files out from under three concurrent workers; nothing was lost only because it popped the stash in time. Baseline against your own paths, never the tree.

## Rules that get broken when you do not know them

- **Immutable stack decisions** (detail in `docs/plans/00-overview.md` §3): Bun + Hono core, Next.js Studio, SQLite + Drizzle, Zod 4 at every boundary, version-locked scrcpy-server (`packages/scrcpy/src/version.ts` is the only source of that version — never fork the Java side).
- **Two TypeScripts — do not merge them**: the root uses TypeScript 7 with `tsconfig.base.json` (bun types, verbatimModuleSyntax); `packages/studio` is deliberately standalone with a local TypeScript 5 and a tsconfig that does NOT extend the base (Next needs the TS 5 compiler API). Both must coexist.
- **`adb kill-server` is forbidden everywhere except `packages/core/src/tools/adb-server-control.ts`'s `cycle()`** — the one function in the workspace that runs it, because port 5037 is shared with Android Studio and every other adb consumer on the machine. `cycle()` has exactly two audited entry points: the Toolchain Manager's version swap and the operator's "Restart adb server" button on the Tools page. Both drain sessions and activities (plus any running job the caller explicitly overrode) before the server stops, and reattach every remembered network address afterward. A workspace-wide test (`packages/core/src/tools/adb-server-control.test.ts`) asserts the literal command appears in exactly that one non-test file; the doctor package keeps its own narrower guard too.
- Cross-package imports always go through the package name (`@enkaku/...`), never a relative path across packages. WS message types and strings come only from `@enkaku/protocol` — never hardcode them elsewhere.
- Validate external input (WS, HTTP bodies, JSON DB columns, config files) through Zod; never `as`-cast. DB timestamps are integer unix **seconds** (Drizzle `mode: 'timestamp'`).
- Device identity is `stableId` (ro.serialno → ANDROID_ID fallback); the adb serial is only a transport address.
- Job isolation is **crash containment** — never call it a "sandbox". A script's `finish()` must be stateless and idempotent (after a timeout kill, the core runs it again in a fresh process).
- Studio: static export (`output: 'export'`) — the device page uses `/device?id=...` (not a dynamic route), internal links must use `next/link` (a plain `<a>` remounts React and kills the WS and video), and workspace packages go in `transpilePackages`.
- Tailwind v4 colour classes: write `bg-panel` and `text-faint`, never `bg-[--color-panel]`. The v3 bracket form compiles to nothing in v4 and fails silently. Never `dark:`; the palette switches, the class does not. See `docs/design.md`.
- The `/ws` protocol has no snapshot replay: a client must `GET /api/devices` first, then subscribe.
- The driver subsystem has **five** layers, not four: transport, display, input, inspector, and `network` (spec §5 and §9). The network layer is the only optional one — its default engine is `none`, and `vpn-helper` (a SOCKS5 full tunnel through the on-device guest agent) is the only engine an app under test cannot bypass. It advertises a `probe` capability (a real egress probe **through** the tunnel, added by plan 51) — but advertising it is not the same as passing it: `deriveHealth` reports `unverified` until an `egress` check actually passes, and `unverified` must never be worded as success.
- **Editing anything under `plugins/*/src/` means bumping that plugin's version — `bun run build:packs` alone ships nothing.** The bundled packs (`packages/core/packs/`, embedded in the release binary) are seeded **once, keyed on `${name}@${version}`**, with the record in `<dataDir>/seeded-packs.json` (`packages/core/src/plugins/seed-embedded.ts`). A version already in that file is **skipped entirely on every later boot**, so a rebuilt bundle at an unchanged version never reaches a farm that has already run — the change sits in the repo, fully tested, and never once reaches a browser. Bump all three sites together (`plugins/<name>/package.json`, `src/index.ts`'s `version:`, and `src/index.test.ts`'s assertion), add the reason to the changelog block in `src/index.ts` beside the previous bumps, then run `bun run build:packs`. Minor for anything an operator meets (a new control, a changed screen); patch only for something genuinely invisible. Note the seeded version is **staged, not activated** — the operator activates it on the Plugins page — so "bumped" and "the operator sees it" are still two different things, and a release note must say so. **This is not hypothetical**: plan 124 rebuilt two plugin UIs without renumbering them, and every fix in them was dormant on the owner's farm until the field report in plan 124 §11. Studio has no such gate — it ships inside the core binary — which is exactly why the omission is easy to miss: half a plan's UI work goes live on deploy and half stays dark, and no test in this repo can see the difference.
- The guest agent APK resolves in three tiers, first match wins: `ENKAKU_GUEST_AGENT_PATH`, then a local Gradle build under `apps/guest-agent/app/build/outputs/apk/`, then the sha256-pinned artifact from the Toolchain Manager. It is never auto-built.
- **The core never `adb connect`s a virtual device.** The adb server discovers local emulators itself by scanning odd ports 5555–5585, and `registry/reconcile.ts` admits what it finds; `packages/core/src/vm/` stops at "booted" and writes no endpoint (plan 400 D2). The Android SDK is resolved from the host, never downloaded, lazily on each VM mutation rather than at boot (`packages/core/src/vm/sdk.ts`) — a farm with no SDK still boots normally and only a create/start/destroy call returns `E_ANDROID_SDK_MISSING` (503). A system image is 1.5–3 GB under the Android SDK Terms (plan 400 D3).
- Config precedence is env > file > default; an invalid config fails the boot (`E_BAD_CONFIG`) and must never silently fall back. Auth mode derives from the bind address (non-loopback ⇒ server mode ⇒ TLS required unless `ENKAKU_ALLOW_INSECURE=1`).
- A value that does not differ between farms is a constant in `packages/core/src/config/constants.ts` with an `ENKAKU_*` override in `.env.example`, never a settings field (plan 212).

## Dev environment notes

- Local dev works with no env vars at all (`bun run dev`). `.env.example` at the root is the reference for every variable the code reads; `docs/guide/install.md` has the prose.
- Bun loads the root `.env` automatically for anything it runs as code (core, node, `scripts/`), but **does NOT expand it inside `package.json` script strings** — so `dev:studio`'s `${NEXT_PUBLIC_ENKAKU_CORE_URL:-…}` never sees it. Studio's variables belong in `packages/studio/.env`, which Next loads itself.
- First run downloads the tools (adb, scrcpy-server, ui-server) in under a minute; the system adb on PATH is never used.
- CORS for `localhost:*` is only active when `NODE_ENV !== 'production'` — that is what lets Studio dev on :3001 talk to the core on :7700.
- `.github/workflows/ci.yml` runs `bun run typecheck` and `bun test` on every push and PR (job `check`), plus a path-conditional `android` job that builds the guest agent APK (debug) whenever `apps/guest-agent/**` or `scripts/build-guest-agent.sh` changes. `.github/workflows/release.yml` is separate: it builds per-OS binaries on a `v*` tag, boots each one and checks `/api/health` before publishing. Neither CI job touches a physical device — that gap is `bun run smoke:guest-agent`, gated behind `ENKAKU_TEST_DEVICE=1` (docs/plans/50-m24a-ci-and-device-smoke-test.md). A green CI badge says the workspace typechecks and tests; it says nothing about whether the guest agent works on hardware.
- The release workflow **does** build, sign, upload and pin the guest agent APK — the `build-guest-agent` job (plan 90 §3.11/§4.8, extended by plan 221 §4.12's `scripts/pin-guest-agent.ts`). This line used to say the opposite; it was stale, corrected 2026-09-04. A `v*` tag derives the APK's `versionCode` from the tag itself, so the manifest's `deviceArtifact.versionCode` and the value baked into the signed APK are always the same release. A core with no local build therefore downloads the APK from the GitHub release and sha256-verifies it, with no configuration. **What that does NOT give you is the build you are working on**: the pinned artifact is whatever the last tag published, so anything landed since (plans 221 and 222's `ui-tree` inspector, for one) reaches a phone only after the next release, or from a local `bun run build:guest-agent --debug`.
