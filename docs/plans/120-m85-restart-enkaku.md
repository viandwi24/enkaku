# Plan 120 — M85 : Restart Enkaku

> Status: implemented — 120.1-120.6 all done, unit-tested. Not run: the real restart itself was deliberately never triggered against a live process this session (the owner has phones attached and a dev server live) — every branch is proven against fakes (a fake spawn, a fake HTTP health server, a fake supervision-mode env/fs) rather than a real self-respawn, a real Docker container, or a real systemd unit. See §7 for exactly what was and was not exercised.
> Depends on: plan 88 (M53) — `tools/adb-server-control.ts`'s `cycle()` is the draining discipline and file/naming convention this plan mirrors for a bigger blast radius.
> Spec references: none directly — this is a new operational feature, not something spec.md already claims; see §8 for why no spec.md edit accompanies this plan.
> Ships: packages/core/src/tools/app-restart-control.ts

A menu action to restart the whole core process — not just the shared adb server, which already has its own "Restart adb server" button (plan 88 §3.10). For when a plugin updated on disk but the running process is still serving the old in-memory version (`bun run packages/core/src/index.ts` has no `--watch`), or the operator's instinct is simply "just restart it."

---

## 1. Goals

- An operator can restart the whole core process from Studio's Tools page, with an honest, mode-aware confirmation dialog and a distinct blast-radius warning from the existing adb restart button.
- Three deployment shapes (Docker, systemd, a bare process with no supervisor) are each handled by the ONE mechanism that is actually safe for that shape — never a one-size-fits-all `process.exit()`.
- The single most important property: **a failed restart never takes the farm down.** In the one mode where this process can prove anything before acting (`bare`), it never stops the original process until a freshly spawned copy has already proven itself healthy.
- The action is drained (sessions, leases, and — only if the operator explicitly overrides — running jobs) before anything else happens, mirroring `adb-server-control.ts`'s own discipline, and audited as its own distinct action (`app.restart`), never folded into `adb.restart`.
- `deploy/enkaku.service` gains what systemd needs to actually relaunch a voluntary restart, and the install guide gets a copy-paste upgrade note for an already-deployed unit file.

## 2. Non-goals

- **Not an auto-updater.** The bare-mode self-respawn relaunches the EXACT binary/entry already running — never a downloaded or different version. Swapping versions is the Toolchain Manager's job (plan 02/88), unrelated to this feature.
- **Not a change to adb server lifecycle.** This feature never calls the adb binary, never touches `adb-server-control.ts`'s `cycle()`, and the workspace-wide "exactly one `kill-server` call site" guard (`adb-server-control.test.ts`) still finds exactly the one call site plan 88 put there.
- **Not a health-check UI or uptime monitor.** Out of scope — this is a single, deliberate, confirmed operator action, never automatic (mirroring plan 88 §3.10's own "no automatic restart, ever" ruling for adb).
- **Not a fix for the Windows port-holder / doctor tooling** (plan 85) — unrelated subsystem.

## 3. Context and design decisions

### 3.1 The three deployment shapes, and the evidence for each

Read directly from the files in this repo, not assumed:

1. **Docker** (`docker-compose.yml`: `restart: unless-stopped`). A clean exit is caught and relaunched by Docker's own restart policy. The container is PID-1-sensitive: if the main process spawns a detached child and exits, Docker considers the container's main process gone and tears the whole cgroup down (the detached child included) — `Dockerfile`'s `CMD ["bun", "run", "packages/core/src/index.ts"]` never installs an init that would keep a cgroup alive for an orphaned grandchild. **A self-respawn is therefore actively wrong here.** Correct action: drain, `daemon.stop()`, `process.exit(0)`, trust the policy already declared in `docker-compose.yml`.
2. **systemd** (`deploy/enkaku.service`: `Type=simple`, `Restart=on-failure`). `Restart=on-failure` does not fire on a clean `exit(0)` — it fires on a non-zero exit, a signal death, or a failed start. A voluntary restart needs a distinct, documented exit code that systemd is told to (a) not count as a crash and (b) restart on anyway. Two systemd directives do this together: `SuccessExitStatus=75` (classifies exit 75 as success, so it is not misreported as a crash and does not consume the `StartLimitBurst` crash-loop budget) and `RestartForceExitStatus=75` (forces the restart regardless of the `Restart=` policy — needed BECAUSE `SuccessExitStatus` just took this exit code out of `on-failure`'s own trigger set). A self-respawn was considered and rejected for this mode: it would run the new process OUTSIDE systemd's cgroup and tracking, so `systemctl stop`/`restart`/`status` would stop controlling the actually-running process, `systemctl stop` would leave an orphan running, and any FUTURE crash of that orphan would never trigger `Restart=on-failure` again — a real regression, not a shortcut.
3. **Bare process** (`docs/guide/install.md`'s own "1. Local (easiest)" path, `bun install && bun run dev` — the owner's own current, actual setup — and a downloaded release binary run directly, `./enkaku`, no systemd unit). There is no external process watching this one at all. The only way "restart" can mean anything here is a self-respawn: spawn a detached child of the exact same binary/entry, verify it is genuinely healthy, and only THEN stop the original. This is the default when neither of the other two signals is present.

### 3.2 Detecting which mode applies

No existing detection code (confirmed by grep this session, zero hits before this plan). `packages/core/src/tools/supervision.ts`'s `detectSupervisionMode()`:

1. `/.dockerenv` exists → `docker`. The standard, widely-relied-on Docker signal, checked as a runtime file rather than a `Dockerfile`-baked build-time env flag: no `Dockerfile` change needed (confirmed no such flag exists today), survives an operator's own custom image built `FROM` this repo's image, and nothing to keep in sync with a build step. Known gap, recorded rather than silently assumed away: a DIFFERENT container runtime that does not create `/.dockerenv` (Podman, by default) is mis-detected as `bare` — which still degrades safely (bare mode's self-respawn still works, it just does not get Docker's own restart-policy framing).
2. `process.env.INVOCATION_ID` is set → `systemd`. systemd sets this for every unit it manages, `Type=simple` included, for the whole lifetime of that invocation — a process can always tell "I am running under systemd" from its own environment with no extra wiring.
3. Otherwise → `bare`, the explicit default, not a fallback assumed by omission.

A pure function, injectable seams (`dockerEnvExists`, `env`), independently unit-tested for every branch (`supervision.test.ts`).

### 3.3 The bare-mode handoff protocol — the load-bearing design decision

The hard problem the brief called out explicitly: the child needs the SAME port the parent is already listening on, but the parent must not stop until the child is proven healthy, and calling the parent's full `daemon.stop()` first is a one-way trip (it closes the database, releases the data-dir lock — nothing to come back from if the child never boots).

**Resolution:** `daemon.ts` gained two new narrow, reversible methods on `Daemon`, separate from `stop()`:

- `closeHttpPort()` — closes ONLY the HTTP/WS listener, via a GRACEFUL `server.stop(false)` (not the forced `server.stop(true)` `stop()` itself uses) — stops accepting new connections immediately (freeing the port), while letting the in-flight request that triggered the restart finish and send its own response. Every other subsystem (db, adb, sessions, plugins) keeps running.
- `reopenHttpPort()` — re-runs the EXACT bind `start()` used (the `Bun.serve()` call was extracted into a named `bindHttp` closure, called once at boot and stored as `relisten` for reuse), reusing the same handler closures. A pure network-layer toggle, safe to call any number of times.

`app-restart-control.ts`'s bare-mode sequence: drain → `closeHttpPort()` → spawn a detached child (same `process.execPath`/env/cwd, no downloaded binary) → poll the child's own `GET /api/health` for up to 15s (300ms interval) → on success, `daemon.stop()` then `process.exit(0)`; **on failure, kill the child, `reopenHttpPort()`, and throw `E_RESTART_FAILED`** — the original process's database, sessions, and adb subsystem were never touched, so it is exactly as alive as it was before the click.

The one case with no further safe fallback, named rather than hidden: if `reopenHttpPort()` ITSELF throws (the port genuinely cannot be reclaimed), that is logged at `error` level with the loudest possible wording and rethrown — there is no third mechanism to fall back to, and pretending otherwise would be worse than an honest failure.

**Self-respawn command construction** mirrors `packages/core/src/plugins/verify-child.ts`'s existing, production-tested pattern for spawning a copy of the running process (`isCompiledBinary()`, checking `Bun.main` for `$bunfs`/`~BUN`) rather than inventing a new one:

- Compiled binary: `[process.execPath]` — no extra argument, unlike `verify-child.ts`'s own `--plugin-verify` flag (which puts ITS child into a special isolated mode). This child needs no special flag: `index.ts`'s own CLI dispatch falls through to `startDaemon()` when no recognised flag is present, which is exactly the ordinary, full boot this feature wants.
- Not compiled (`bun run packages/core/src/index.ts`): `[process.execPath, entryPath]`, `entryPath` resolved via `fileURLToPath(new URL('../index.ts', import.meta.url))` from `tools/`, the same resolution style `verify-child.ts` uses for its own entry.
- `env: process.env, cwd: process.cwd()` unchanged — config precedence is env > file > default (CLAUDE.md); the child must see the identical environment the parent had.

`isCompiledBinary()` is duplicated locally in `app-restart-control.ts` rather than imported from `@enkaku/session`'s `isolation.ts` (the canonical copy) — the SAME precedent `verify-child.ts` already established: that helper is not part of `@enkaku/session`'s public export list, and duplicating two lines is cheaper and safer than widening that package's surface for one more caller.

### 3.4 Draining — reused, not reinvented

`AppRestartDeps.drain` mirrors `AdbServerControlDeps.drainSessions` exactly: sessions and leases are ALWAYS drained; a running job is force-failed only when the caller (the route) already decided to proceed despite it (`force`, checked by the route's own `E_APP_BUSY_FARM` guard before `restart()` is ever called). `DrainResult` (the return shape) is imported from `adb-server-control.ts` rather than redefined — it was already generic, not adb-specific, despite living in that file.

### 3.5 The HTTP response vs. the process exit — a real ordering hazard

For `docker`/`systemd`, the process that would send the confirmation response might already be gone by the time a client could receive it. `restart()` resolves its report SYNCHRONOUSLY (before the process ever stops) and defers the actual `daemon.stop()` + `process.exit()` a short beat later (`scheduleExit`, default `setTimeout(..., 150)`) — long enough for Bun/Hono to flush the HTTP response over the socket, nowhere near long enough to matter to an operator watching a toast. `bare` mode has no such problem: success is defined as "the original process is still here to answer," so it resolves normally once the handoff is proven, no deferral needed.

### 3.6 Permission and audit

`tool.manage` — the SAME gate `/adb/restart` uses, and already the strictest tier `auth/acl.ts`'s ACL has: `tool.manage` is absent from the `OPERATOR` set, so `can(role, 'tool.manage')` only ever admits `admin`. There is no stricter permission to reach for in this codebase (no super-admin tier exists), so reusing it is not a weakening — it is already the ceiling.

Audited as `app.restart`, a distinct `AuditAction` from `adb.restart` (never folded into it, per the brief's explicit instruction) — the blast radius is materially different: this drops every live session/stream farm-wide and interrupts every in-flight job, where `adb.restart` leaves the core process and every job's queue state untouched.

## 4. Technical design

### 4.1 New files

- `packages/core/src/tools/supervision.ts` — `detectSupervisionMode(deps?): 'docker' | 'systemd' | 'bare'`, pure, injectable `dockerEnvExists`/`env` seams.
- `packages/core/src/tools/app-restart-control.ts` — `createAppRestartControl(deps): AppRestartControl` (`restart(opts): Promise<AppRestartReport>`, `busy(): boolean`). `RESTART_SENTINEL_EXIT_CODE = 75` (BSD `sysexits.h`'s `EX_TEMPFAIL`, chosen for being outside every well-known exit-code range and reading sensibly in a log). `defaultSpawnChild`/`defaultPollHealth`/`defaultScheduleExit` are the real implementations, all individually injectable.
- `packages/protocol/src/api/app-restart.ts` — `SupervisionModeSchema`, `AppRestartPreviewSchema` (`{ mode, devicesTotal, sessionsActive, leasesHeld, jobsRunning }`), `AppRestartReportSchema` (`{ mode, outcome: 'initiated' | 'verified', durationMs, sessionsClosed, leasesReleased, jobsFailed }`).
- `packages/studio/src/components/AppRestartDialog.tsx` / `AppRestartCard.tsx` — the confirmation dialog and its trigger card, visually and textually distinct from `AdbRestartDialog`/`AdbServerCard`.

### 4.2 `daemon.ts` changes

- `Daemon` interface gains `closeHttpPort(): void` and `reopenHttpPort(): Promise<void>` (see §3.3).
- The `return { ... }` object literal became `const daemonHandle: Daemon = { ... }; return daemonHandle` — purely so `start()`'s own body can hand `daemonHandle.stop` to `appRestartControl` as a forward reference (safe: `start()`'s body only ever runs after the whole `const` statement finishes evaluating, since a caller must call `daemon.start()` separately).
- `appRestartControl` is constructed beside `adbServerControl`, reusing `sessions`/`leases`/`jobStore`/`host` the exact same way.
- `createApp({...})`'s deps gain `appRestart: { control: appRestartControl, preview: () => ({...}) }`.

### 4.3 `tools/routes.ts` / `server/http.ts` changes

- `createToolsRoutes`'s `deps` gains an optional `app?: AppRestartRouteDeps` field, mirroring `adb?: AdbControlRouteDeps` exactly.
- `GET /app/restart-preview` and `POST /app/restart`, mounted beside `/adb/restart-preview`/`/adb/restart`. `POST /app/restart` refuses with `E_APP_BUSY_FARM` (409) unless `force`, mirroring `E_ADB_BUSY_FARM`'s shape; `E_APP_RESTART_UNAVAILABLE` (503) when the dep is absent; `E_TOOL_IN_USE` (409) / other `EnkakuError`s (500) translated from `restart()`'s own throws.
- `HttpDeps` gains `appRestart?: AppRestartRouteDeps`, threaded into `createToolsRoutes` the same way `adbControl` already is.

### 4.4 Schema/type changes elsewhere (found only once construction started)

- `lease-manager.ts`'s `ManualReleaseReason` gained `'app-restart'` (alongside the pre-existing `'adb-server-restart'`).
- `@enkaku/protocol`'s `LeaseRevokedMessage.payload.reason` enum gained `'app-restart'` to match.
- `packages/studio/src/app/device/page.tsx`'s lease-revoked notice gained an `'app-restart'` branch ("Control was released — Enkaku itself just restarted...") rather than falling through to the generic `Control was released automatically (${reason})` message.
- `auth/audit.ts`'s `AuditAction` gained `'app.restart'`.

## 5. Implementation steps

1. **120.1 — `supervision.ts` + tests.** Pure `detectSupervisionMode()`, exhaustive branch coverage (`supervision.test.ts`, 5 tests).
2. **120.2 — `app-restart-control.ts` + tests.** The full docker/systemd/bare state machine, `RESTART_SENTINEL_EXIT_CODE`, the health-poll-then-cutover logic against a FAKE spawn and a real `Bun.serve()` fake HTTP server for `defaultPollHealth`'s own two tests (`app-restart-control.test.ts`, 14 tests: docker deferred-exit, systemd deferred-exit, bare success, bare failure (child killed + port reopened + original stays up), bare failure-to-reopen (the named no-safe-fallback case), drain force-threading, the mutex, and `defaultPollHealth`'s real poll-loop + real timeout).
3. **120.3 — `daemon.ts` wiring.** `closeHttpPort`/`reopenHttpPort`, the `bindHttp` extraction, `daemonHandle` forward-reference, `appRestartControl` construction, `createApp` deps. Verified via `bash scripts/typecheck.sh` (no dedicated daemon.ts unit test exists for this scale of file — it is exercised through `tools/routes.test.ts` and the app-restart-control tests, matching how `adbServerControl`'s own daemon.ts wiring is verified).
4. **120.4 — API route + tests.** `AppRestartRouteDeps`, `/app/restart-preview`, `/app/restart`, `E_APP_BUSY_FARM`, error translation. `tools/routes.test.ts` gained 12 new tests covering permission, the unavailable-dep 503, the busy-farm 409 and its `force` bypass, the audit record, and both `E_TOOL_IN_USE`/`E_RESTART_FAILED` error translations.
5. **120.5 — Studio UI + tests.** `AppRestartDialog.tsx` (mode-aware copy, busy-farm checkbox, mirrors `AdbRestartDialog`'s structure), `AppRestartCard.tsx` (danger-tinted border, distinct heading/button text), mounted on `app/tools/page.tsx` right after `AdbServerCard`. 11 component tests across `AppRestartDialog.test.tsx`/`AppRestartCard.test.tsx`, including explicit distinctness assertions (`queryByText(/adb server/)` returns null inside the app-restart dialog) and one test per supervision-mode's own copy branch.
6. **120.6 — `deploy/enkaku.service` + docs.** `SuccessExitStatus=75`/`RestartForceExitStatus=75` with a doc comment explaining why both lines are required together; `docs/guide/install.md` gained an upgrade snippet for an already-deployed unit file plus a Troubleshooting entry distinct from the existing adb-restart one.

## 6. Acceptance criteria

1. `detectSupervisionMode()` returns `docker`/`systemd`/`bare` correctly for every combination of its two injected signals, including the edge case where both are present (Docker wins) and an empty-string `INVOCATION_ID` (treated as unset). ✅ `supervision.test.ts`.
2. `restart()` in `docker`/`systemd` mode drains, returns `{ outcome: 'initiated' }` BEFORE the process stops, and only actually stops/exits after the caller has had the response. ✅ `app-restart-control.test.ts`.
3. `restart()` in `bare` mode NEVER stops the original process before a spawned child proves healthy; on failure the child is killed, the port is reclaimed, and `E_RESTART_FAILED` is thrown — the daemon is never torn down and the process never exits. ✅ `app-restart-control.test.ts` (two dedicated failure-path tests, one for the ordinary failure and one for "even the port cannot be reclaimed").
4. adb's own restart mechanism is untouched: `adb-server-control.test.ts`'s workspace-wide "exactly one `kill-server` call site" guard still passes with `app-restart-control.ts` in the tree. ✅ verified this session.
5. `POST /api/tools/app/restart` is `tool.manage`-gated (admin-only), refuses a busy farm unless `force`, audits as `app.restart`, and is unavailable (503, not 404) when the dep is absent. ✅ `tools/routes.test.ts`.
6. Studio's "Restart Enkaku" is visually and textually unmistakable from "Restart adb server" — distinct heading, distinct button label, distinct border colour, and the confirmation copy never mentions "adb server." ✅ `AppRestartCard.test.tsx`/`AppRestartDialog.test.tsx` assert this directly (`queryByText(/adb server/)).toBeNull()`).
7. The confirmation dialog states what ACTUALLY happens per detected mode, never a guarantee the backend cannot keep. ✅ three dedicated copy-branch tests, one per mode.
8. `deploy/enkaku.service` declares the sentinel exit code correctly (`SuccessExitStatus=75` AND `RestartForceExitStatus=75`, both required together per §3.1 point 2's reasoning). ✅ read back after the edit.
9. `bash scripts/typecheck.sh` is clean across all 17 workspace packages. ✅ verified this session (see §7).
10. Every new/changed test file passes when run scoped to itself (never the bare full-suite `bun test`, per CLAUDE.md's hard rule). ✅ see §7 for the exact commands and counts.

## 7. Test plan

Unit tests (all run scoped, never the bare full-suite form):

```bash
bun test packages/core/src/tools/supervision.test.ts packages/core/src/tools/app-restart-control.test.ts packages/core/src/tools/routes.test.ts packages/core/src/tools/adb-server-control.test.ts
bun test packages/core/src/lease/lease-manager.test.ts packages/protocol/src/messages/job.test.ts
bun run --cwd packages/studio test -- src/components/AppRestartDialog.test.tsx src/components/AppRestartCard.test.tsx
bash scripts/typecheck.sh
```

**What is proven by a fake, and what is not proven at all** (the owner's own instruction: never actually trigger the real restart against a live process this session):

- `detectSupervisionMode` — proven directly, every branch, against injected fakes. No gap.
- The health-poll-then-cutover logic (`pollHealth`/`spawnChild`/`closeHttpPort`/`reopenHttpPort`) — proven against FAKE implementations for the control-flow logic (both the success and failure paths), and `defaultPollHealth` itself (the one real-fetch implementation) is proven against a real, disposable `Bun.serve()` test server on an ephemeral port — but this is still not the same as a real `Bun.spawn()` self-respawn on the SAME port as a live core, which was never run.
- The `daemon.ts` `closeHttpPort`/`reopenHttpPort`/`bindHttp` wiring — proven only by typecheck and by the fact that `tools/routes.test.ts` and every other daemon-adjacent test still passes; there is no dedicated daemon.ts test exercising a real bind/release/rebind cycle (matching how `adbServerControl`'s own daemon.ts wiring has no dedicated test either — it is exercised transitively).
- systemd's `SuccessExitStatus`/`RestartForceExitStatus` pair — verified by reading systemd's own documented semantics and by re-reading the edited unit file, never by installing the unit and actually killing/restarting a real systemd-managed process.
- Docker's PID-1/cgroup teardown behaviour — asserted from `docker-compose.yml`'s own `restart: unless-stopped` and general Docker semantics, never exercised against a real container.
- The compiled-binary spawn path (`isCompiledBinary()` true, `[process.execPath]`) — never run against an actual `bun build --compile` artifact this session.

None of these gaps are silent: this section names every one of them, and the owner is the one who can run the real end-to-end smoke test (start a bare `bun run dev`, click Restart Enkaku, confirm the tab reconnects) when convenient, without an agent risking their live session to do it first.

## 8. Risks and mitigations

- **Risk: a mis-detected supervision mode picks the wrong mechanism.** Mitigated by `/.dockerenv`/`INVOCATION_ID` being the two most reliable, widely-used detection signals available, by every branch being independently unit-tested, and by `bare` mode's own protocol (health-verify before cutover) being safe EVEN IF it is wrongly selected for an actually-supervised process — worst case, the supervisor sees an extra brief connection-refused window on the old PID before the new one comes up, not data loss.
- **Risk: `closeHttpPort`/`reopenHttpPort` diverge from `start()`'s real bind over time** (someone edits the inline `Bun.serve()` call without noticing it is now inside `bindHttp`). Mitigated by there being only ONE bind implementation now (`bindHttp`), not two — `start()`'s normal boot path calls the exact same closure `reopenHttpPort()` calls, so any future edit to the bind logic is automatically inherited by both paths.
- **Risk: the 150ms `scheduleExit` deferral is too short on a slow machine, and the HTTP response never actually flushes before the process exits.** Not eliminated, only bounded: 150ms is generous for a same-machine HTTP response (typically sub-millisecond), and the cost of being wrong is a client seeing a dropped connection instead of a clean 200 — the RESTART itself still happens correctly either way (docker/systemd's own supervisor brings the process back regardless of whether the confirmation response made it out).
- **Risk: an operator confuses "Restart Enkaku" with "Restart adb server."** Directly mitigated in the design (§3.6, §4.1) and tested (`AppRestartCard.test.tsx`'s explicit `queryByText(/adb server/)` assertion) — not merely hoped for.

## 9. Open questions

1. **Podman (and other non-Docker container runtimes without `/.dockerenv`)** are mis-detected as `bare`. Degrades safely (see §3.2), but an operator running Enkaku under Podman gets bare-mode's self-respawn framing in the confirmation dialog rather than a container-restart-policy framing. Left open rather than guessed at — no evidence this repo is deployed under Podman today.
2. **The real end-to-end smoke test** (bare mode's actual self-respawn, a real systemd unit relaunch, a real Docker container restart) has never been run — see §7's own accounting. This is the owner's to run when convenient; running it during this session would have meant deliberately killing the owner's own live dev server, which the brief explicitly forbade.
3. **Whether `deploy/enkaku.service`'s `RestartSec=5` is still the right value** now that a voluntary restart can also land in that 5-second window (alongside a genuine crash) — not changed by this plan, recorded here only because it is the kind of interaction a future reader might wonder about.
