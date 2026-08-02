# Plan 00 — Overview, Conventions, and the Execution Roadmap

> The parent document for every plan in `docs/plans/`. Read this **before** working on any plan.
> The product source of truth is `docs/spec.md` (Enkaku draft v0.2). If a plan contradicts the spec, the spec wins — then update the plan.

---

## 1. How to use this plan series

- Each plan is one milestone from spec §20, worked **in order** (01 → 11). Plan N assumes every plan below N is finished and its acceptance criteria are met.
- Each plan is **self-contained as a working context**: it carries goals, non-goals, technical design, numbered implementation steps, acceptance criteria, and a test plan. An AI agent builder needs only `00-overview.md` plus the plan being worked on (plus the spec sections it references).
- Do not pull features forward from a later plan "while you are in there". If you find a need that is not covered, record it under **Open questions** in the relevant plan; do not improvise architecture.
- When a plan is finished → run every acceptance criterion → commit with `feat(mX): ...` → only then move to the next plan.

## 2. The plans

| # | File | Milestone | Summary |
|---|---|---|---|
| 00 | `00-overview.md` | — | This document: conventions, stack, repo structure, template. |
| 01 | `01-m0-foundation.md` | M0 | Monorepo, core daemon, `packages/adb` (client plus track-devices), device registry plus stableId, SQLite, WS broadcast, per-device queue plus semaphore. |
| 02 | `02-m1-toolchain.md` | M1 | Toolchain Manager: manifest, download plus sha256, versioning, active pointer, swappable flag, first-run auto-provisioning. |
| 03 | `03-m2-basic-control.md` | M2 | Basic control: `screencap-loop` plus `adb-input`, coordinate mapping, Studio live view and click, the enrollment wizard. |
| 04 | `04-m3-session-lease-queue.md` | M3 | The device state machine, lease plus heartbeat, a per-device queue in SQLite (with a dummy job). |
| 05 | `05-m4-script-framework.md` | M4 | `defineScript`, the subprocess runner, artifacts and logs, `@enkaku/sdk`, the first inspector (`uiautomator dump`). |
| 06 | `06-m4.5-ui-server.md` | M4.5 | A persistent on-device inspector (the uiautomator2 pattern): fast `find`/`waitFor`, `set_text`. |
| 07 | `07-m5-studio-complete.md` | M5 | Studio complete: script CRUD plus run form and publish, job detail, the Tools UI, settings, the schema-driven renderer, the registry, battery/thermal plus auto-quarantine. |
| 08 | `08-m6-scrcpy.md` | M6 | The scrcpy display (H.264 relay, version-locked) plus `scrcpy-uhid` input plus WebCodecs decoding plus a fallback decoder. |
| 09 | `09-m7-multiuser-packaging.md` | M7 | Auth/ACL plus TLS, a single binary, a Docker image, the Tauri shell, auto-update, artifact retention and GC. |
| 10 | `10-m7.5-business-plumbing.md` | M7.5 | Docs, licence/activation, opt-in telemetry, the AUP, support and update channels, `LICENSES.md`. |
| 11 | `11-m8-cloud.md` | M8 | The cloud tunnel agent, a split control plane, WebRTC video, a per-job security boundary, opt-in appium, redroid, `scrcpy-aoa`. |
| 12 | `12-m9-cloud-session.md` | M9a | Cloud mode fully working: `@enkaku/session`, remote sessions, input, and jobs. |
| 13 | `13-m9-webrtc-backend.md` | M9b | The WebRTC backend (werift), the RTP relay, TURN. |
| 14 | `14-m9-desktop-tauri.md` | M9c | The Tauri desktop application. |
| 15 | `15-m10-design-system.md` | M10a | **Design foundations**: Tailwind plus shadcn/ui, tokens, the layout frame, fixing functional UI defects. |
| 16 | `16-m10-screens.md` | M10b | **Rebuilding every screen** and user flow. |
| 17 | `17-m11a-realtime-and-wake-ux.md` | M11a | **Realtime UI contract**: ticking durations, session wake-up progress, keep-awake modes, standby (screen off while mirroring), keyframe on join. |
| 18 | `18-m11b-device-event-log.md` | M11b | **Device event log**: one `device_events` table with `main` and `input` streams, live tail, redaction, per-stream retention, the Logs tab. |
| 19 | `19-m11c-tags-and-device-picker.md` | M11c | **Tags and the device picker**: `device_tags`, normalisation, tag filtering, a picker that shows stableId and unavailable devices with reasons. |
| 20 | `20-m11d-clusters-and-batch-runs.md` | M11d | **Clusters and batches**: a cluster is a saved selector; batches with `(concurrency, order)`, an aggregate report, cancel and re-run failed. |
| 21 | `21-m11e-schedules-and-queue-policy.md` | M11e | **Schedules**: croner, overlap policy, queue timeout (`expired`), catch-up, jitter, priority, run history. |
| 22.0 | `22.0-clusters-as-device-field.md` | M11d-rev | **Clusters become a device field**: `devices.clusterId`, one device in at most one cluster (or none), a cluster is a container rather than a saved selector. Supersedes Plan 20 §3.1. |
| 22.1 | `22.1-m12a-adb-deadlines-and-queue-safety.md` | M12a | **adb deadlines**: layered timeouts, forced socket termination, output caps, queue depth cap, `AbortSignal`, coded errors. No user-facing change. |
| 23 | `23-m12b-adb-concurrency-and-device-health.md` | M12b | **Concurrency and health**: a semaphore that scales with fleet size (amends spec §10.4), parallel battery polling, auto-quarantine on adb failure with automatic recovery, `/api/adb/stats`. |
| 24 | `24-m12c-adb-stream-lane-and-monitor.md` | M12c | **Streaming lane and Monitor tab**: `execStream` outside the per-device queue, fixed read-only monitors (logcat/top/thermal), one stream fanned out to all viewers, save-as-artifact. |
| 25 | `25-m12d-shell-over-tunnel.md` | M12d | **Cloud parity**: correlated request/response over the tunnel, a `shell` binary channel, agent-side handlers, one `ShellPort` interface with local and remote implementations. |
| 26 | `26-m12e-interactive-terminal.md` | M12e | **The device terminal**: free-form commands gated by lease plus the `device.shell` permission, full audit, emulated cwd, exit codes, all viewers watch and only the lease holder types. |
| 27 | `27-m12f-local-adb-endpoint.md` | M12f | **Lease-scoped adb endpoint (local)**: an adbd-protocol shim so a user can `adb connect` to a farm device with their own tooling. Starts with a spike gate. |
| 28 | `28-m12g-cloud-adb-endpoint.md` | M12g | **adb endpoint for cloud devices**: the same shim with ADB streams carried over tunnel channels, with delivery-acknowledged flow control. |
| 29 | `29-m13-runtime-resilience.md` | M13 | ⚠️ **DRAFT — DO NOT EXECUTE.** Single-owner data-dir lock, stale `adb forward` sweep, bounded session auto-recovery, per-device reconnect. Design unsettled; §9 must be answered first. |
| 30 | `30-m14a-server-side-pagination.md` | M14a | **Pagination**: one keyset envelope for every list endpoint, a shared `PaginatedTable`, no unbounded fetches. |
| 31 | `31-m14b-viewer-presence-and-control.md` | M14b | **Presence**: who is watching a device and who holds control, live to every viewer. Starts by reproducing the reported two-browser symptom. |
| 32 | `32-m14c-fleet-topology-view.md` | M14c | **Topology**: the whole farm as grouped tiles — status, battery, temperature, running job — live, no graph library. |
| 33 | `33-m15-device-network.md` | M15 | **Network layer**: a fifth driver layer (spec §7.9). `adb-proxy` and `adb-reverse-proxy` engines, lease-scoped apply/revert, declared-vs-observed status, a Studio card, and `ctx.device.network.*` in the SDK. |

Linear dependencies: `01 → … → 11 → 12 → 13 → 14`, then `15 → 16` for the interface layer. (07 and 06 can partly run in parallel, but the default is sequential.)

The M11 series is **not** a single chain. `17` and `18` are independent of everything after 16 and of each other. `19 → 20 → 21` is a hard chain: clusters select devices by tag, and schedules trigger batches.

```
17 (realtime + wake UX)   ─┐
18 (device event log)     ─┼─ independent, any order
19 (tags) → 20 (clusters/batches) → 21 (schedules)
```

The M12 series (remote shell and adb access) is a chain with one branch. Plan 22.1 is a hard prerequisite for everything after it: until adb calls have deadlines, any long-running command can park a per-device queue slot permanently, which is the failure already recorded in `packages/scrcpy/src/session.ts:90-98`.

Plan 22.0 is not part of that series — it revises the M11d cluster model — but it lands first because it changes `devices`, `clusters`, and every batch/schedule target path, and rebasing the M12 work onto it later would be wasteful.

```
22.0 (clusters as a device field)   ← independent; lands first to avoid a later rebase
22.1 (adb deadlines)  ← hard prerequisite for 23–28
 ├─ 23 (concurrency + health)   independent of 24–28; needed before a farm exceeds ~10 devices
 └─ 24 (stream lane + monitor) → 25 (cloud parity) → 26 (terminal)
                                              └────→ 27 (local adb endpoint) → 28 (cloud adb endpoint)
```

Plans 27 and 28 are the largest in the series and are gated: **Plan 27 opens with a throwaway spike against a real `adb` client, and the plan stops there if the spike fails.** Do not start 28 before 27's shim is proven.

One plan is one working session. Do not start a later plan in the same session as an earlier one — the point of the split is that the context stays small enough to hold accurately.

The M14 series is independent of M12 and M13. `30` and `31` do not depend on each other; `32` reads best after `31` (a device tile can then show its viewer count), but does not require it.

Plan `33` is independent of M12–M14. It needs Plan 18 (the device event log it writes to), Plan 22.1 (adb deadlines, since a hung `adb reverse` would otherwise park a queue slot), and the permission-gating pattern established in Plan 26. Its §9 Q4 names a smaller bug fix — honouring `HTTPS_PROXY` for the core's own outbound requests — that should land **before** it and is not part of it.

**Plan 29 is a draft, not a work item.** Its status line says `DRAFT — NEEDS DISCUSSION. DO NOT EXECUTE`, and it deliberately has no implementation steps or acceptance criteria. It becomes executable only when a human answers its §9 and changes the status line. "Work the plans in order" does not include it.

## 3. Stack and decisions that must NOT change

These are settled in the spec (§4, §10.3, and the §21 closing note). No plan may change them without revising the spec:

| Area | Decision |
|---|---|
| Core runtime | **Bun** (not Node). The core daemon is Bun plus **Hono**. |
| Web UI | **Next.js** (Studio), reached through a browser; either served by the core (static export) or hosted. |
| DB | **SQLite** (zero setup) plus **Drizzle ORM**. The DB driver stays abstracted, but SQLite is the default. |
| Validation/schema | **Zod** at every boundary (protocol messages, script params, engine config, DeviceSettings). The JSON Schema for UI forms is generated from Zod. |
| Monorepo | Bun workspaces, laid out exactly as spec §4 (`packages/core|studio|sdk|protocol|adb|scrcpy|toolchain|drivers|agent`, `apps/desktop`). |
| scrcpy-server | **Genymobile's official vanilla .jar**, pinned to the core version (`swappable: false`). Never fork the Java. (spec §7.6) |
| Default input | `scrcpy-uhid`; falling back to `scrcpy-sdk`; `adb-input` is only a crude MVP fallback. (spec §9) |
| Default inspector (final) | A persistent on-device `ui-server`; `uiautomator dump` is only a bridge in M4. (spec §7.4) |
| Core⇄Studio communication | Message-based over **WebSocket** for realtime and streaming; REST for CRUD. The contract lives in `packages/protocol` (Zod). (spec §13) |
| adb serialisation | A per-device command queue (unchanged: one device, one command at a time) plus a **global** semaphore that scales with fleet size — `min(24, max(6, ceil(nonOfflineDeviceCount * 0.75)))`, so 6 is the floor (≤4 devices, same as before Plan 23) and 24 is the ceiling; the farm setting `adb.maxConcurrent` (default `0` = auto) can pin it instead. **`adb kill-server` is forbidden** except in the Toolchain Manager's adb version swap. (spec §10.4, amended by plan 23) |
| Local trust model | Crash containment (child process plus a hard-timeout kill), **not** a security sandbox. Never claim "sandbox". (spec §11.3) |
| Device identity | `stableId` (ro.serialno → ANDROID_ID fallback) is the identity; the adb serial is a transport address. (spec §7.5) |

## 4. Repo and code conventions

### 4.1 Monorepo structure (the final target; built up gradually from Plan 01)

```
openpf/
  package.json                # workspaces: ["packages/*", "apps/*"]
  bunfig.toml
  tsconfig.base.json
  packages/
    core/                     # the Bun + Hono daemon
    studio/                   # the Next.js web UI
    sdk/                      # @enkaku/sdk — defineScript, public types
    protocol/                 # @enkaku/protocol — Zod message schemas, shared types
    adb/                      # @enkaku/adb — adb client, track-devices, scrcpy-server push
    scrcpy/                   # @enkaku/scrcpy — the protocol client (demux, meta decode), version-locked
    toolchain/                # @enkaku/toolchain — tool provisioning (download, sha256, versions)
    drivers/                  # @enkaku/drivers — Transport/DisplaySource/InputSink/Inspector implementations
    agent/                    # @enkaku/agent — the cloud tunnel mini-core (Plan 11)
  apps/
    desktop/                  # the Tauri shell (Plan 09)
  docs/
    spec.md
    plans/
```

- Internal npm package names use the `@enkaku/*` scope. `sdk` and `protocol` are designed to be publishable; everything else is `"private": true`.
- TS path aliases: cross-package imports always go through the package name (`@enkaku/protocol`), never a relative path across packages.

### 4.2 TypeScript conventions

- `"strict": true` and `"noUncheckedIndexedAccess": true` in `tsconfig.base.json`.
- All data crossing a boundary (WS messages, HTTP bodies, JSON DB columns, config files) **must** pass through Zod `.parse()`/`.safeParse()` — no `as` casting of external input.
- Errors: use coded error classes (`EnkakuError` with `code: string`) in the core; the API consistently returns `{ error: { code, message } }`.
- Logging: one logger utility in the core (levels debug/info/warn/error, a subsystem prefix, optional JSON-lines output). Every subsystem uses it; no stray `console.log`.
- Entity IDs: use `nanoid()` or `crypto.randomUUID()` — pick one consistently from Plan 01 onward (we use `crypto.randomUUID()`, built into Bun).
- DB timestamps: integer unix epoch **seconds** (Drizzle `{ mode: 'timestamp' }`), consistently across every table.

### 4.3 API and protocol conventions

- REST: the `/api/...` prefix, JSON, semantic status codes. Tool endpoints follow spec §7.7 exactly.
- WS: one `/ws` endpoint for control-plane messages (a JSON envelope), with binary video streams as binary messages carrying a channel prefix (details in Plans 03 and 08). The JSON envelope:
  ```ts
  { type: string; id?: string; payload: unknown }   // id correlates request and reply
  ```
- Every message type is declared in `packages/protocol` as a Zod discriminated union; core and studio import from there. There are **no** hardcoded message type strings outside the protocol package.

### 4.4 Testing conventions

- Test runner: `bun test`. `*.test.ts` files colocated in `src/`.
- Every plan has a **Test plan** section; at minimum: unit tests for pure logic (queue, parsers, checksums, state machine) plus a scripted manual smoke test (with the exact commands written into the plan).
- Tests needing a physical device are marked and skippable via the `ENKAKU_TEST_DEVICE=1` env var.

### 4.5 Commit and branch conventions

- One plan may span many commits; messages read `feat(m0): ...`, `fix(m2): ...`, `chore: ...`.
- This repo is not yet a git repo — Plan 01's first step includes `git init`.

## 5. App-data and runtime paths (used across plans)

Per spec §7.2:

- macOS: `~/Library/Application Support/Enkaku`
- Windows: `%APPDATA%\Enkaku`
- Linux: `~/.local/share/enkaku` (as a service: `/var/lib/enkaku`)
- Dev/test override: the `ENKAKU_DATA_DIR` env var.

Contents: `enkaku.db`, `tools/<toolId>/<version>/...` plus an `active` pointer, `artifacts/<job-id>/...`, `logs/`.

## 6. Plan template (the required structure for documents 01–11)

Every plan follows this structure, at a depth where "the AI builder just follows it":

```markdown
# Plan XX — <Milestone> : <Title>

> Status / Depends on / Spec references (§...)

## 1. Goals            — what must be TRUE once the plan is done (measurable bullets)
## 2. Non-goals        — what is deliberately NOT done here (and which plan does it)
## 3. Context and design decisions — a design summary plus reasoning, referencing the spec
## 4. Technical design — TS interfaces, DB/Zod schemas, endpoints, file structure, flows and sequences
## 5. Implementation steps — numbered stages (X.1, X.2, ...) with concrete sub-checklists,
##                       each naming the files created or changed and a verifiable result
## 6. Acceptance criteria — the final checklist; everything must pass
## 7. Test plan         — unit tests plus a manual smoke test (with explicit commands)
## 8. Risks and mitigations
## 9. Open questions    — spec ambiguities needing a human decision (do not decide unilaterally)
```

## 7. Global Definition of Done (applies to every plan)

1. Every acceptance criterion in the plan passes.
2. `bun test` is green across the workspace.
3. No new unjustified TODOs or `any` in the code you touched.
4. New behaviour is documented at least in the relevant package README.
5. The spec §16 NFR targets relevant to that milestone are checked (Plan 06: inspector find < 200 ms; Plan 08: glass-to-glass < 150 ms on a LAN).

## 8. Short glossary

- **Core** — the Bun + Hono daemon, orchestrator of everything.
- **Studio** — the Next.js web UI.
- **Engine** — an implementation of one of the four driver layers (Transport/DisplaySource/InputSink/Inspector).
- **DeviceSession** — the four engines assembled for one device (spec §7).
- **Lease** — the exclusive right to use a device (manual or job), with a heartbeat and an expiry.
- **stableId** — the stable device identity (ro.serialno / ANDROID_ID), not the adb serial.
- **Toolchain Manager** — the subsystem that provisions binaries (adb, scrcpy-server, ui-server, and so on).
- **swappable** — a tool flag: whether users may freely pick a version (scrcpy-server: `false`).
