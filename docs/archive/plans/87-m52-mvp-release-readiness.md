# Plan 87 — M52 : MVP Release Readiness

> Status: partial — most of the 14 steps landed and are unit-tested (`bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test` all green against the working tree this status describes), several landed narrower or structurally different from §4's design, a few were never built at all, and the release-blocking hardware verification this plan exists to gate is still outstanding. Every claim below was re-checked against the code directly, not copied from this plan's own implementation-steps section — see the per-step notes for exactly what was verified and what deviated.
>
> **Landed as designed.** 87.1 Studio login/setup (B1) — `AuthGate.tsx`/`AuthShell.tsx`, `lib/auth.ts`, `app/login`, `app/setup`; local self-host stays login-free. 87.5 `tapJitterMs` (S3) — wired end to end through `InputSink.tap`, tested; `adb-input` deliberately opts out, documented. 87.6 NFR honesty (S4) — the ui-server claim now reads as a target, plus a CI-runnable provisioning-budget regression test. 87.9 docs/language hygiene (S8/S9). 87.12 browser auto-open (S2) — three independent suppression gates plus `ENKAKU_NO_OPEN`.
>
> **Landed, but differently from §4's design (verified equivalent, or narrower — see each step).** 87.2 health honesty (B3) — the smoke gate now polls `/api/health` to a terminal `adb.state`, but `ok` itself was *deliberately* left hardcoded `true` (a reversed decision, pinned by a regression test), not derived from `adbState()` as designed. 87.3 CORS/rate-limit (S7) — CORS is fixed; the trust-proxy control shipped as `ENKAKU_TRUST_PROXY` (an env var), not the `auth.trustProxy` farm setting §4.9 specified. 87.4 ACL (S1) — job-cancel and device-ownership are genuinely gated and audited, enforced directly in the route/WS-handler layer via `canCancelJob`, not by threading an `actor` through `job-service.cancel()` as designed; `PATCH /api/devices/:id` has no blanket `requirePermission` call (harmless today — `device.settings` is already an OPERATOR permission in this two-role system — but a real gap from what was specified). 87.7 `agent_blobs` (S5) — real and tested, but narrower: only unreferenced orphans past `retention.blobOrphanGraceHours` are ever swept; there is no age/quota sweep of referenced blobs, no `BlobStore.delete` method, and no `VACUUM`/`auto_vacuum` (stated limitations, not omissions). 87.8 Windows in CI (S6) — a separate, conditional `check-windows` job (push to `main`, or a `windows` PR label), not the `check` matrix on every push §4.8 designed, and it has never once executed (this is all still uncommitted). 87.11 backup (B4) — `enkaku backup <dir>` is real (`VACUUM INTO` over a read-only connection, bundles `secrets.key`), documented, and `DIV-059` is corrected with the right reasoning — but there is no `POST /api/admin/backup` HTTP route (CLI only), and `doctor/checks/db.ts`'s remedy string was never updated to mention any of it. 87.13 AUP + tagging (B2) — the device-scoped `debug.enkaku.instrumented` marker is wired end to end and `instrumentation.tagTraffic` defaults on; `docs/acceptable-use.md` exists but as a full draft (not the scaffold-only §4.12 called for), is explicitly unratified, and is **not linked from Studio anywhere** — only reachable from the repo, which the acceptance criteria require and this does not meet.
>
> **Not done at all.** `docs/guide/release-checklist.md` (87.14) does not exist in any form — B5 is recorded nowhere outside this plan document itself. Plan 09's status line was never corrected as 87.1 specified (arguably moot, since 87.1's own work closed the gap that correction would have flagged, but the action itself did not happen). Option B (SOCKS5-level tagging, 87.13) was not built.
>
> **Explicitly unverifiable from this environment, and still open.** The Plan 85 §7.3 Windows hardware ladder has never run (B5, tracked as a release gate, not re-done here). `check-windows` has never executed even once. `debug.enkaku.instrumented` has never been checked against a real phone — the code's own comment says so. Studio does not hide any of the controls the 87.4 ACL sweep now returns 403 on for a non-admin operator (Tools, unquarantine) — a real, unaddressed UX consequence of shipping S1. Nothing described here is committed.
>
> **This status line was itself stale before this pass** — it read "not started" while 13 of 14 steps had substantially landed, the same failure this plan's own §1 goal 3 (health honesty) and §0's whole premise are about: a status claim nobody checks against the code. This is the third time in three consecutive plans (84, 85, 87) that a plan's own header drifted from its body — plan 84 added a Definition-of-Done item for exactly this (`docs/plans/00-overview.md` §7, item 6: "the plan's status line is updated, and `bash scripts/check-plan-status.sh` passes... so the check is mechanical rather than a memory exercise") specifically to stop it, and it kept happening anyway. The rule existing is not the same as anyone running the check before considering a plan closed.
> Ships: packages/studio/src/components/layout/AuthGate.tsx
> Depends on: Plan 09 (M7, auth/ACL backend — the login UI this plan builds has nothing to call otherwise), Plan 84 (M49, spec reconciliation — landed, `docs/spec-divergences.md` exists), Plan 85 (M50, Windows fleet scale — landed in code as of `v0.1.7`, but its own §7.3 hardware ladder has never run; tracked here as a release gate, not re-done). Plan 10 (M7.5, business plumbing) attempted the AUP and never finished it; this plan finishes that one piece without reopening the rest of Plan 10.
> Spec references: §2 (non-negotiable principles, incl. zero-config browser open), §5.1–5.2 (deployment modes), §9.4 (instrumentation/tagging on by default), §11.3 (lease-gating, rewritten 2026-08-09), §12 (`DeviceSettings.timing`), §14 (auth, TLS, audit), §16 (NFR targets), §17 (positioning and acceptable use), §19 (housekeeping / Settings)
>
> **A note on numbering.** This plan was commissioned as "86 — M51: MVP release readiness." While the six audits behind it were running, a concurrent commit (`675e409`, tagged `v0.1.7`) landed `docs/plans/86-m51-tiktok-account-switch-and-searched-follow.md`, claiming both that file number and that milestone number first — a real plan, already shipped, unrelated to release readiness. Rather than collide with landed work (the precedent `docs/plans/00-overview.md` already sets for `56-m26-device-admission.md` / `56-m26-ui-inspector-devtools.md`, later resolved by renumbering one of them to 58), this document takes the next free pair: file `87`, milestone `M52`. `docs/plans/00-overview.md`'s own table is not edited here — out of this plan's scope by its own instructions — so whoever lands this plan's first commit should add the row.

---

## 0. How this plan was built

Six independent, read-only audits ran in parallel against the repo (release mechanics, the plan backlog, security/auth/exposure, spec-vs-code promises, runtime robustness and data safety, and first-hour onboarding). This plan is their synthesis, re-verified: every citation below was re-read directly from the file at the path given, not copied from the source reports, and several had already drifted by the time this document was written (noted inline where that happened — see §1.1 "Corrections made while verifying").

**The repo moved under this audit.** The six reports were written against `v0.1.6` (commit `9820492`) with a large uncommitted working tree on top of it. Between the last report finishing and this plan being written, that working tree was committed and released as `v0.1.7` (commit `47cd848`, on top of `675e409`) — which means Plan 85 (Windows fleet scale) and Plan 84 (spec reconciliation) are no longer "uncommitted, might not ship" as several reports describe them; they are **shipped, in the tagged binary, still hardware-unverified**. This plan's evidence tables reflect the state as of `47cd848`, re-read at the time of writing, not the state the original audits saw.

---

## 1. Goals

1. Every deployment mode `docs/guide/install.md` presents as first-class (systemd/homelab, Docker, the cloud control plane) has a working login and first-admin setup screen in Studio — today the backend is complete and none of it has a front end.
2. `docs/acceptable-use.md` exists, is referenced from the product (not just linked from a README paragraph), and the concrete meaning of "farm traffic instrumentation and tagging, on by default" (spec §9.4) is decided and either built to the decided scope or explicitly narrowed in the spec to what is actually shipped — never left asserting a mechanism that does not exist.
3. The release smoke test (`.github/workflows/release.yml`) fails the build when the one tool that gates boot (`adb`) does not actually finish provisioning, instead of asserting only that Bun answers an HTTP request with a hardcoded `ok: true`.
4. A database backup procedure that is actually safe for this codebase's configuration (WAL mode, a separate `secrets.key`) exists, is documented, and `DIV-059` is revisited with the owner using the corrected reasoning — the current spec withdrawal was made on the premise that a SQLite backup is "copying one file," which is false here.
5. Plan 85's §7.3 Windows ladder (5 → 10 → 20 real devices, the release binary) is named explicitly as a release gate for this MVP tag — not re-run by this plan, which has no hardware, but recorded so cutting a release without it is a deliberate choice, not an oversight.
6. `POST /api/jobs/:id/cancel`, the WS `job.cancel` message, and `PATCH /api/devices/:id` are gated by the same permission-and-ownership model every sibling route in the same files already uses.
7. `DeviceSettings.timing.tapJitterMs` either changes device behaviour or is removed from the schema — Settings never again show a control that does nothing.
8. The one NFR number rendered verbatim in the product UI (`<200 ms per find`) is never asserted as fact with nothing behind it, and "first-run provisioning < 90 s" — the one §16 NFR that needs no hardware to check — has a real, CI-runnable test.
9. `agent_blobs` has a bounded growth path, matching every other growing table in this codebase.
10. `.github/workflows/ci.yml`'s `check` job runs on Windows as well as `ubuntu-latest` — the owner's stated deployment target has never run the test suite in CI.
11. The dev-only CORS escape hatch (`packages/core/src/server/http.ts:127-129`) cannot be silently live in a documented production deployment, and login-attempt rate limiting cannot be defeated by a caller-supplied header alone.
12. `README.md`, `docs/guide/install.md`, `docker-compose.yml`, `Dockerfile`, and `docs/spec.md` read as a stranger's first hour should: no unfilled `OWNER/REPO` placeholder, no non-English comments on a security-relevant line, no spec section contradicting another spec section that was already corrected once.
13. "Double-click → the core starts → the browser opens automatically" (spec §2, §5.1) either has an implementation for the plain release binary, or the spec is corrected to say what actually happens (manual navigation, exactly as `README.md`/`install.md` already document) — the two must agree.

## 2. Non-goals

- **Not fixing B5 by running it.** Plan 85's Windows hardware ladder needs real Windows hosts with real USB-attached phones; this plan has neither. §5's step for B5 is a checklist entry and a release-process note, not code.
- **Not the missing `ctx.device.network.*` SDK surface, `adb-proxy`/`adb-reverse-proxy` engines, guest-agent bulk install/CI publishing, GPS mock-location hardware verification, or multi-tenant cloud isolation.** These are real, documented gaps (Plan 33/43's own `partial` status, Plan 11 §"cloud isolation") but were not in the finding set this plan was commissioned to close, and each is large enough to be its own plan.
- **Not a full Settings-screen backup/restore UI.** §4.4 below designs a minimal, safe, scriptable/`doctor`-integrated backup instead — a UI panel is a scope question for the owner (see Open questions §9.2), not assumed here.
- **Not rewriting Plan 10's licensing enforcement, `/api/updates/check`, or `CHANGELOG.md`.** Those are separate `partial` items in the same plan the AUP came from; only the AUP and traffic-tagging half is in scope here.
- **Not touching `docs/spec.md`'s content wholesale.** Two narrow, cited corrections are proposed (§17's stale "lease-scoped" wording, §5.1/§2's browser-auto-open claim) — not a second reconciliation pass.
- **Not touching `plugins/tiktok-automation-pack` or `docs/plans/86-m51-tiktok-account-switch-and-searched-follow.md`.** Unrelated, already shipped, out of scope.
- **Not measuring the six hardware-bound §16 NFRs** (glass-to-glass latency, FPS, devices-per-host, the 334–584 ms dump figure). They need real devices and real network conditions; this plan adds the one NFR that is CI-checkable (provisioning time) and stops the one that is asserted as fact in the UI without backing.

---

## 3. Context and evidence

### 3.1 Blockers (re-verified; all CONFIRMED as of `47cd848`)

| # | Finding | Evidence (re-read at time of writing) | Correction vs. the source audits |
|---|---|---|---|
| **B1** | Studio has a fully-built, tested auth backend and **zero** frontend for it. `find packages/studio/src -iname "*login*" -o -iname "*setup*"` returns nothing; `packages/studio/src/app/layout.tsx` has no auth gate; `packages/studio/src/lib/api.ts` and `lib/actions.ts` have no `checkAuth`/`setupNeeded` consumer. Every non-loopback deployment (`docs/guide/install.md` §2 systemd, §3 Docker; `docs/guide/cloud.md`'s control plane, whose very first command at line 13 is `ENKAKU_MODE=orchestrator ENKAKU_BIND=0.0.0.0 ...`) lands the user on `GET /api/devices → 401` with an infinite "Try again" retry (`packages/studio/src/components/states.tsx:45-61`, wired at `page.tsx:558-559`). The backend exists in full: `packages/core/src/auth/routes.ts` — `GET/POST /setup` (:50,52), `POST /login` (:63), `POST /logout` (:92), `GET /me` (:101), `POST /ws-ticket` (:104), `POST /password` (:106), `GET/POST /users`, `DELETE /users/:id` (:115,120,129), `GET /audit` (:136). `docs/guide/install.md:64` promises "the setup page asks for the first admin's email and password" — no such page exists. | None — every citation held exactly. Plan 09's own status line (`docs/plans/09-m7-multiuser-packaging.md:3`) still claims `implemented`, which is itself wrong and worth fixing alongside the code (§5, step 87.1). |
| **B2** | `docs/acceptable-use.md` does not exist (`ls docs/acceptable-use.md` → no such file). Spec §9.4 (`spec.md:446-449`): *"Because you hold both sides... 1. Tag all traffic from the farm (an internal header or marker) — on by default."* Restated at §17 (`spec.md:848`): *"The acceptable-use policy is a product default, not just a document. Farm traffic instrumentation and tagging is on by default (§9.4)."* Neither half exists: no header/marker/tag mechanism anywhere in `packages/core`, `packages/drivers/src/network`, `packages/protocol`, or the guest agent's Kotlin sources; `packages/protocol/src/network.ts`'s `NetworkCapabilitiesSchema` (:32-38) has no such field. `plugins/tiktok-automation-pack` ships as a real, working automation pack in the same release. | The task brief's citation `spec.md:840` for the §17 sentence has moved to `spec.md:848` — an 8-line drift, likely from Plan 84/85's edits to `00-overview.md`/`spec.md` landing between when the finding was first written and now. §9.4's own citation (`spec.md:449`) held exactly. |
| **B3** | `HealthResponseSchema`'s `ok` field is hardcoded (`packages/core/src/server/http.ts:143`, inside the `/api/health` handler at :141-151): `ok: true` unconditionally, while `adb: { state: deps.adbState() }` sits right next to it, unread by anything. `daemon.ts`'s `adbState` closure variable (:186) starts `'provisioning'`, becomes `'ready'` (:2178) or `'error'` (:2181) only after `provisionRequiredTools()` (:1795) runs — which happens **after** `Bun.serve()` starts listening (:1554), by design, so Studio can show live progress. `.github/workflows/release.yml`'s `smoke` job (:82-91 unix, :100-115 windows) polls `/api/health` until *any* 200 response and never inspects `adb.state`. A release whose first-run adb download fails (dead URL, rotated artifact, sha256 mismatch, a CI runner with restricted network) still passes `smoke` and gets published. | None — `daemon.ts:1554` vs `:1795` and `http.ts:143` all held exactly as cited in the task brief. |
| **B4** | `packages/core/src/db/index.ts:19-22`: `sqlite.exec('PRAGMA journal_mode = WAL;')` runs unconditionally on every `openDb()` call, no opt-out. In WAL mode, `enkaku.db` alone does not contain recent commits — they live in `enkaku.db-wal` until a checkpoint, and a plain filesystem copy of even all three files (`.db`, `-wal`, `-shm`) taken while the core is live is exactly the uncoordinated-copy case SQLite's own documentation warns produces a torn, corrupt copy. `packages/core/src/secrets/store.ts:33` (`const KEY_FILE = 'secrets.key'`) is a fourth, separate file: every network/connector/webhook/KV credential is AES-256-GCM encrypted under it, and the module's own comment (:35-43) records a real incident where a rename of this exact file silently minted a fresh key and made every stored secret undecryptable, observed in the wild. `docs/spec-divergences.md`'s `DIV-059` row (:229) records the owner's decision: *"Enkaku is self-hosted on SQLite, where a backup is copying one file — operator territory, not a product feature."* That premise is false for this configuration on two independent counts (WAL, `secrets.key`), and nothing in `docs/guide/install.md` or `enkaku doctor` (`packages/core/src/doctor/checks/db.ts:15`, a remedy string that only says "restore ... from a backup ... outside the product") documents the safe procedure that does exist: stop the core cleanly (`daemon.ts:2239`, `sqlite.close()` checkpoints a WAL database on last-connection close), then copy the whole data directory. | None — every citation held exactly, including the exact `DIV-059` decision text. |
| **B5** | Plan 85 (M50) is now **committed and tagged** (`v0.1.7`), not "uncommitted" as the source audits describe — repo state moved during this audit, see §0. Its own status line (`docs/plans/85-m50-windows-fleet-scale.md:3`) still reads: *"the §7.3 Windows ladder itself (5/10/20 real devices, the release binary) has not been run at all... implemented-and-unit-tested but not hardware-verified."* `.github/workflows/ci.yml` runs `check` only on `ubuntu-latest` (:26,75,94) — the full suite has never executed on Windows in any automated form; `release.yml`'s `smoke` job does boot the Windows binary but only checks `/api/health` returns 200 and Studio's root page contains `<html>` (see B3 — a shallow check). | **Material correction**: the source reports (`mvp-1-release.md` finding 4, `mvp-2-backlog.md` A2) both call this "uncommitted," treating that as part of the risk. It is no longer true. What has NOT changed: the hardware ladder is still blank. This plan reclassifies B5 from "uncommitted code" to "committed code, unverified on the hardware it was written for" — a narrower but still real release gate (§5, step 87.13). The two source reports also disagreed on severity for the underlying fact (mvp-1: blocker; mvp-2: serious) — both are folded into B5 here as a release gate, which is the more actionable framing than either label alone. |

### 3.2 Serious findings (re-verified; all CONFIRMED as of `47cd848`)

| # | Finding | Evidence (re-read at time of writing) | Correction vs. the source audits |
|---|---|---|---|
| **S1** | `POST /api/jobs/:id/cancel` (`packages/core/src/api/jobs.ts:155-158`) calls `service.cancel(c.req.param('id'), {cancelDescendants})` directly — no `requirePermission`, no actor. The WS `job.cancel` (`packages/core/src/server/ws-handlers.ts:1514-1519`) calls `deps.jobs.cancel(msg.payload.jobId)` — same shape. `job-service.ts`'s `cancel()` (:101-125) takes no `actor` parameter at all, unlike `enqueue()` (:78-84), which takes `input.actor` and calls `canUseDevice`. The capability-layer equivalent (`packages/core/src/capability/job.ts:103-116`, reached via `POST /api/v1/cap/job.cancel` or MCP) correctly declares `permission: 'job.cancel.any'` — and that permission is confirmed **absent** from the `OPERATOR` set (`packages/core/src/auth/acl.ts:104-122`; it only appears in `ALL_PERMISSIONS` at :147, i.e. admin-only). Separately, `PATCH /api/devices/:id` (`devices.ts:465-519`) has no `requirePermission` call at all and writes `ownerId` straight to the row (:471, :509) with zero audit trail — `changedKeys` (:499, used for the audit/event write at :510-517) is derived only from `body.data.settings`, never from `label`/`ownerId`, so a bare `{"ownerId": "x"}` PATCH produces no `device_events`/`audit_log` row. Every sibling route in the same file (`/blocked/:stableId`, `/discovered/:stableId/admit`, `/rescan`, `/:id/tags`, `/:id/cluster`, `/:id` DELETE, `/:id/block`) does call `requirePermission('device.settings')`. | None — every line cited held exactly, including the `OPERATOR` set boundary (confirmed by reading `acl.ts:104-122` in full: `job.cancel.any` is genuinely absent from it). |
| **S2** | Spec §5.1 (`spec.md:96`): *"Double-click → the core starts → Studio is served on `localhost` → the browser opens automatically."* §2's non-negotiable principles table makes the same claim. No code anywhere in `packages/core`, `scripts/`, or root `package.json` spawns a browser — confirmed by grep for `xdg-open`/`open`/a browser child-process launch, all empty. The only thing that opens a *window* is the separate Tauri desktop shell (`apps/desktop/src-tauri/src/main.rs:82`), an embedded native webview, not the user's actual browser, and only for users who build/run that separate app. `README.md:11` and `docs/guide/install.md:16,44` correctly say "open http://localhost:7700" — the docs a real user follows are accurate; only the spec overclaims. | None on the code side. **Severity note**: the source report that raised this (`mvp-4-spec-promises.md`) rated it a **blocker** on its own ("the second sentence of the whole product's Summary"); this plan's finding set (given by the commissioning task) rates it **serious**. Both are kept visible — see §9.1. |
| **S3** | `packages/protocol/src/settings.ts:40-44`: `tapJitterMs: z.tuple([z.number(), z.number()]).default([40, 120])`, rendered as a real Settings control by Studio's schema-driven form. Nothing reads it: grep for `tapJitterMs` outside its declaration and the schema-form label generator returns nothing. The actual tap-hold duration is a hardcoded literal, `await Bun.sleep(40 + Math.random() * 80)`, present verbatim at `packages/drivers/src/input/scrcpy-input.ts:29` and `:155` — coincidentally overlapping the default range, which is what hides the disconnect. `InputSink.tap(p: Point): Promise<void>` (`packages/protocol/src/driver.ts:94`) has no duration parameter, so the setting cannot flow through even in principle as currently typed. By contrast, `timing.betweenActionMs` and `timing.coordJitterPx` genuinely are read (`packages/session/src/device-executor.ts:121-125`). | None — every citation held exactly. |
| **S4** | None of spec §16's seven NFR numbers (`spec.md:823-831`ish, the table ending at "job overhead < 3 s") is measured or tested anywhere in `packages/*` — confirmed by search for a benchmark/CI assertion tied to any of the seven. `packages/drivers/src/descriptors.ts:43` sets the `ui-server` engine's Studio-facing `displayName` to literally `'UI server (persistent on-device, <200 ms per find)'`, served through `GET /api/registry` into the product UI itself — not just the spec. `docs/plans/34-m16-shipped-defect-repairs.md` records that engine failing to start at all for a real shipped period (wrong instrumentation class name), silently falling back to `uiautomator dump` (0.5–2 s, ~10× worse than the claimed figure) while the UI kept showing "<200 ms" the whole time. That specific defect is fixed now, but nothing prevents the same silent-drift failure again — no timing test exists post-fix either. | None — held exactly. |
| **S5** | `packages/core/src/db/schema.ts:698-707` (`agentBlobs` table): `data: blob('data', { mode: 'buffer' })` stores the full-resolution image bytes **inside `enkaku.db` itself**. `packages/core/src/agent/blob/store.ts`'s `BlobStore` interface (:31-42) exposes exactly `put`/`get`/`info` — confirmed no `delete` method exists anywhere in the file, and no `.delete(agentBlobs)` call exists anywhere in the codebase. Content-addressing (`id` is the sha256 of the bytes) dedupes identical images for free, but two screenshots of a live UI are essentially never byte-identical, so in practice every agent tool call that captures a screen adds a new row that lives forever. This also compounds B4: the file every operator is tempted to `cp` as a "backup" keeps growing without bound. | None — held exactly. |
| **S6** | `.github/workflows/ci.yml`: three `runs-on: ubuntu-latest` lines (:26, :75, :94) — `check`, `changes`, and `android` all run only on Linux. The full `bun test` suite, `bun run --cwd packages/studio test`, and both plugin-pack test suites have never executed on Windows through any automated path. `release.yml`'s `smoke` job does boot a real Windows binary, but only checks HTTP 200 + an `<html>` substring (see B3) — not a functional test of the device farm itself. | None — held exactly. |
| **S7** | `packages/core/src/auth/routes.ts:66-67`: `const ip = c.req.header('x-forwarded-for') ?? 'local'; const key = \`${ip}|${body.data.email}\`` — the only defense against online password guessing (`auth.loginMaxAttempts`/`auth.loginLockoutSeconds`) is keyed on a header any direct caller fully controls, with no fallback to a verified peer address. The same forgeable value lands in `sessions.ip` via `createSession`'s `meta.ip` (:83-86), which is what the audit trail would show for a session. Separately, `packages/core/src/server/http.ts:127`: `if (process.env.NODE_ENV !== 'production')` gates the dev-only CORS grant (:126-129) — and `NODE_ENV` is confirmed **never set** anywhere in this repo's shipped deployment paths: not in `scripts/build-release.sh`, not in `deploy/enkaku.service`, not in `docker-compose.yml`, not in `.github/workflows/release.yml`. A server-mode instance built and run exactly as `docs/guide/install.md` describes still has the "dev-only" grant live. Bounded impact (re-confirmed): the `cors()` call at :128 does not set `credentials: true`, so the session cookie cannot be read across origins this way — the gap is real but not a full auth bypass. | None — held exactly, including the `credentials: true` absence that bounds the impact. |
| **S8** | `README.md`: grep for "release\|binary\|download" (case-insensitive) returns only toolchain-manager/guest-agent-APK mentions — no release-binary quickstart; `docs/guide/install.md` is linked exactly once, inside a guest-agent-specific paragraph. `docs/guide/install.md:13`: `curl -LO https://github.com/OWNER/REPO/releases/latest/download/...` — a literal, unfilled placeholder (`git remote -v` shows the real path is `viandwi24/enkaku`). `docker-compose.yml:9,13,15-16` and `Dockerfile` carry comments in Indonesian (*"Bind non-loopback ⇒ mode server ⇒ login wajib"*, *"Uji cepat tanpa TLS (JANGAN untuk produksi)"*) — on exactly the lines explaining why login becomes mandatory and warning against the insecure flag, i.e. the security-relevant lines. `CLAUDE.md` states: *"All documentation, code comments, identifiers, UI copy, and commit messages are written in English."* | None — every citation held exactly, including the specific Indonesian phrases. |
| **S9** | `docs/spec.md` §17 (`spec.md:845-853`) says twice, unchanged by the 2026-08-09 reconciliation: *"The network layer (§7.9) is a single operator-set route **per lease**"* and *"A route that is explicit, **lease-scoped**, and written to the device event log..."* §7.9 rule 1 (`spec.md:380`, "revised in v0.6" per the reconciliation's own note) says the opposite: *"Configuration is bound to the device, never to the lease... tying a network identity to whoever happens to be holding control turned out to be the wrong model."* The code matches §7.9 (device-scoped), not §17: `packages/core/src/api/guest-agent.ts`'s `restoreDeviceRoute` and its callers restore per-device, independent of any lease. | None — held exactly. This is the one item the 2026-08-09 reconciliation pass should have caught while it was in §7.9 fixing the identical claim, and did not — pre-existing staleness, not new drift. |

**Also observed while verifying (outside the commissioned finding set, flagged for awareness, not a required deliverable of this plan):** `docs/plans/00-overview.md` §9's tracked-removal row for Plan 61's `agent.hello`/`agent.json`/`/agent/ws` compatibility shims sets a removal deadline of **"by v0.1.7."** `v0.1.7` is now tagged (`47cd848`) and all three shims are still present (`daemon.ts:1561-1565`, `packages/node/src/state.ts:34-39`, `package.json:15`). This is an independent, already-dated compliance gap this plan happened to notice while checking `daemon.ts` and `package.json` for other reasons — it is not one of B1–S9 and this plan does not schedule work for it, but it is worth the owner's attention the next time `00-overview.md` §9 is touched.

### 3.3 What the six source reports disagreed about

The task asked this plan to note contradictions across the six audits, not just within the code:

1. **Windows fleet hardware verification (B5).** `mvp-1-release.md` rated the gap a **blocker** ("Windows is the stated deployment target"); `mvp-2-backlog.md` rated the same underlying fact **serious** ("no single-operator core promise is broken"). Both were written when Plan 85 was uncommitted, which no longer applies (§3.1). This plan resolves the disagreement by treating it as a named release gate rather than picking a severity label — see §5, step 87.13.
2. **Browser auto-open (S2).** `mvp-4-spec-promises.md` independently rated this its own **blocker** ("the second sentence of the product's Summary... one of six non-negotiable principles"). The commissioning task's finding set (drawn from a synthesis across all six reports) rates it **serious**. This plan keeps the task's severity for its own acceptance criteria but implements the fix regardless — it is cheap (§4.7) — so the disagreement does not change what gets built, only how it is prioritized against the blockers.
3. **No factual (as opposed to severity) contradictions were found** between the six reports on any of B1–S9 — where two reports touched the same finding (e.g. `mvp-1`/`mvp-2` on the guest-agent APK gap, `mvp-4`/`mvp-5` on `DIV-059`), they agreed on the underlying facts and differed only in framing or emphasis.

---

## 4. Technical design

### 4.1 B1 — Studio login and setup

New files under `packages/studio/src/app/`:

```
app/setup/page.tsx    — shown when GET /api/auth/setup → { needed: true }
app/login/page.tsx    — email + password form, error state, redirect back to the origin page
```

A new `packages/studio/src/lib/auth.ts`:

```ts
export interface AuthState {
  status: 'checking' | 'setup-needed' | 'unauthenticated' | 'authenticated'
  user: { id: string; email: string; role: 'admin' | 'operator' } | null
  authMode: 'local' | 'server'
}

/** Calls GET /api/auth/me; on 401 reads `setupNeeded` off the error body
 *  (already returned by packages/core/src/auth/middleware.ts:36-44) to
 *  decide setup vs. login without a second round trip. */
export async function checkAuth(): Promise<AuthState>
```

`packages/studio/src/components/layout/AppShell.tsx` (the file `ProvisioningBanner` already hooks into at :140) gains an auth gate: `checking` renders nothing extra (existing loading state), `setup-needed`/`unauthenticated` render only `{children}` for `/setup`/`/login` and redirect everywhere else, `authenticated` renders normally. In `local` auth mode (the existing implicit-admin path), `checkAuth()` always resolves `authenticated` immediately — this plan changes nothing about local self-host, only server mode.

`/login` posts to `POST /api/auth/login` through the existing `api()` helper (`packages/studio/src/lib/actions.ts:53`), which already does schema-validated response parsing — no new fetch pattern. `/setup` posts to `POST /api/auth/setup`. Both use the existing session cookie flow (`setSessionCookie`, `packages/core/src/auth/routes.ts:40-48`) — no new client-side token storage.

`docs/plans/09-m7-multiuser-packaging.md`'s status line is corrected from `implemented` to reflect this was never built (small doc edit, same commit).

### 4.2 B3 — Health honesty and a real smoke gate

`packages/core/src/server/http.ts:141-151`:

```ts
app.get('/api/health', async (c) => {
  const adb = { state: deps.adbState(), serverVersion: await deps.adbServerVersion() }
  const isOrchestrator = process.env.ENKAKU_MODE === 'orchestrator'
  return typedJson(c, HealthResponseSchema, {
    ok: isOrchestrator || adb.state === 'ready',
    version: deps.version,
    adb,
    mode: isOrchestrator ? 'orchestrator' : 'local',
    deviceCount: deps.deviceCount(),
    uptimeMs: Date.now() - deps.startedAt,
  })
})
```

`.github/workflows/release.yml`'s `smoke` job (unix :82-91, windows :100-115) changes its poll loop from "any 200" to "200 AND `ok === true`," with a bounded wait (matching the §16 target: 90 s for first-run provisioning, plus margin) before failing loudly with `health.json`'s contents — which it already captures, just does not gate on.

### 4.3 S1 — job.cancel and device ownership

`job-service.ts`'s `cancel()` gains the same `actor` parameter `enqueue()` already has, reusing the already-injected `getDeviceOwner` dependency (`daemon.ts:516`, already wired into `createJobService` at :1028-1038):

```ts
cancel(jobId, opts) {
  const job = deps.jobStore.get(jobId)
  if (!job) throw new EnkakuError('job_not_found', ...)
  if (opts?.actor) {
    const device = deps.getDeviceOwner?.(job.deviceId)
    if (device && !canUseDevice(opts.actor, device)) {
      throw new EnkakuError('auth.forbidden', 'this job belongs to a device you do not own')
    }
  }
  // ... unchanged from here
}
```

`jobs.ts:155` and `ws-handlers.ts:1514` both gain `requirePermission('job.view')` (the existing floor every authenticated user already has for their own jobs) and pass `{ id: state.userId ?? '', role: deps.roleOf(state.userId) }` as the actor — the exact pattern `job.run`/`enqueue` already uses at `ws-handlers.ts` a few lines above (`deviceId: msg.payload.deviceId, ..., actor: {...}`). An admin (who already holds `job.cancel.any`, and for whom `canUseDevice` always returns `true` per `acl.ts:215`) is unaffected; an operator can now only cancel jobs on devices they own or that are unowned — closing the gap without inventing a new permission.

`devices.ts:465` (`PATCH /:id`) gains `requirePermission('device.settings')`, matching every sibling route in the file. Because `device.settings` is already granted to every operator (§3.2's own note on why Finding 3 in the source security audit is lower severity), `ownerId` specifically gets one more check: only `admin` may include `ownerId` in the patch body — a non-admin request that sets it is rejected with `E_FORBIDDEN`, mirroring how `kv.manage` is deliberately kept outside `OPERATOR` (`acl.ts:95-101`). `changedKeys` (:499) is extended to include `label`/`ownerId` when present, so a `device.settings`-audited change to those two fields is no longer invisible in `device_events`.

*(Same file, lower priority, not required by this step's acceptance criteria but cheap to fold in while a worker is already in `devices.ts`: `/:id/drivers`, `/:id/unquarantine`, `/:id/monitor/save` are missing the same `requirePermission('device.settings')` their siblings have — see mvp-3's Finding 3, rated `polish`. Optional.)*

### 4.4 B4 — A safe backup procedure

`bun:sqlite`'s `Database` exposes `.serialize()`; `VACUUM INTO` is also available via `.exec()`/`.run()` and writes a single, coherent, non-WAL snapshot file directly, without loading the whole database into process memory first — the better choice for a farm's DB, which can hold years of job history and (per S5) growing blob rows.

New `packages/core/src/db/backup.ts`:

```ts
export interface BackupResult { dbPath: string; secretsKeyPath: string | null; bytes: number }

/** Snapshots the live database with VACUUM INTO (safe to run while the core
 *  is serving requests — unlike a filesystem copy, this goes through
 *  SQLite's own locking) and copies secrets.key alongside it, because a
 *  database without its key is a farm's worth of undecryptable credentials
 *  on restore (packages/core/src/secrets/store.ts's own documented incident). */
export function backupTo(sqlite: Database, dataDir: string, outDir: string): BackupResult
```

Wired as `POST /api/admin/backup` (`admin`-scoped, `requirePermission('settings.manage')`) returning a downloadable archive path, **and** as a `enkaku backup <dir>` CLI subcommand for operators who prefer cron over clicking a button — both call the same function, so there is exactly one implementation to trust.

`packages/core/src/doctor/checks/db.ts:15`'s remedy string is corrected from "restore enkaku.db from a backup ... outside the product" to name the actual safe procedure and the CLI subcommand.

**The decision to revisit:** `DIV-059`'s recorded reasoning ("a backup is copying one file") is factually wrong for this codebase's own configuration (§3.1, B4). This plan does not silently re-flip the decision — see §9.2 (Open questions) for what the owner needs to decide, now with the corrected facts in front of them.

### 4.5 S3 — tapJitterMs

Two options, both technically small; the choice is a product one (see §9.3), but this plan builds toward the wiring option as the default recommendation because it costs less than explaining to a user why a control they can see does nothing:

- **Wire it**: `InputSink.tap` (`packages/protocol/src/driver.ts:94`) gains an optional `holdMs?: number` parameter; `ScrcpySdkInput.tap`/`ScrcpyUhidInput.tap` (`scrcpy-input.ts:29,155`) replace their hardcoded `40 + Math.random() * 80` with `holdMs ?? (40 + Math.random() * 80)`; `device-executor.ts` (already computing `timing.coordJitterPx` at :121-122) computes `randBetween(timing.tapJitterMs[0], timing.tapJitterMs[1])` and passes it through, next to where it already applies `coordJitterPx`.
- **Remove it**: delete `tapJitterMs` from `TimingSettingsSchema` (:40-44) and its Studio label, since `adb-input.ts` never modeled tap as a down/up pair to begin with (mvp-4's own note) and the feature may not be worth the surface area.

### 4.6 S4 — NFR honesty

`descriptors.ts:43`'s `displayName` is softened from a flat claim to a labeled target: `'UI server (persistent on-device, target <200 ms per find)'` — small, but "target" is not "measured," and the product should not say a number it has never checked.

New `packages/core/src/tools/provision.test.ts` addition (or a sibling file): a CI-runnable, network-mocked test asserting the *code path's own timeout/retry budget* stays under the 90 s target when every download succeeds on the first attempt — not a real network benchmark (impossible in CI), but a real regression guard against the budget silently growing past the number in `spec.md`.

### 4.7 S5 — agent_blobs bounded

`packages/core/src/maintenance/retention.ts` gains an `agentBlobs` sweep, **not gated by `retention.enabled`** — the same reasoning already applied to device-event retention (`retention.ts:47-53`'s own comment: *"an unbounded input stream is a disk-filling bug, not an opt-in convenience"*), because a screenshot table growing inside `enkaku.db` itself is exactly that. New settings under `retention`:

```ts
agentBlobMaxAgeDays: z.number().int().min(1).max(3650).default(90),
agentBlobMaxTotalMb: z.number().int().min(100).default(2048),
```

Deletion only removes a blob row once it is older than the age bound **and** unreferenced by any `tool_result`/`agent_message` row still within its own retention window — a orphan-safety join, not a blind age sweep, so an in-progress conversation never loses an image it is still showing.

### 4.8 S6 — Windows in CI

`.github/workflows/ci.yml`'s `check` job becomes a matrix: `runs-on: ${{ matrix.os }}`, `matrix: { os: [ubuntu-latest, windows-latest] }`. `bash scripts/check-plan-status.sh` and `bash scripts/check-harness-provenance.sh` need a shell-compatible invocation on Windows runners (GitHub's `windows-latest` ships Git Bash; both scripts are already POSIX `sh`-shaped per their shebangs) — verified to run, not assumed, as part of this step (§5, step 87.8's own verification).

### 4.9 S7 — Rate limiting and CORS

`auth/routes.ts:66`: prefer Bun's own verified peer address over the header when the deployment is not explicitly configured to trust a proxy — a new `auth.trustProxy: boolean` farm setting (default `false`) controls which source `ip` uses: `false` → `server.requestIP(req)` (the real socket peer, unforgeable); `true` → `X-Forwarded-For` (for the documented reverse-proxy path, where the header is trustworthy because the proxy sets it). `http.ts:126-129`: the CORS grant becomes unconditional-except-server-mode rather than `NODE_ENV`-gated — it already checks `isLoopbackOrigin`, so gating on `deps.authMode !== 'server'` (a value the app already threads through, unlike an env var nothing sets) is both safer and matches what the comment already claims.

### 4.10 S8/S9 — Docs and spec hygiene

- `README.md` gains a short "Download a release" section near the top, before "Running it (dev)," pointing at the release binary.
- `docs/guide/install.md:13`'s `OWNER/REPO` becomes `viandwi24/enkaku` (confirmed via `git remote -v`).
- `docker-compose.yml` and `Dockerfile` comments are translated to English, preserving meaning exactly (the security-relevant ones — "non-loopback bind ⇒ server mode ⇒ login required," "quick test without TLS, NOT for production" — are the ones that matter most to get right).
- `docs/spec.md` §17 (`spec.md:848-850`): "per lease" → "per device"; "lease-scoped" → "device-scoped," matching §7.9's already-corrected text exactly.
- `docs/spec.md` §2/§5.1: the browser-auto-open claim either gets an implementation (§4.11 below) or is corrected to describe what ships. This plan does the former, so no spec edit is needed here — see §4.11.

### 4.11 S2 — Browser auto-open

`packages/core/src/index.ts`, after the daemon reports it is listening, guarded to **local self-host mode only** (loopback bind, not server mode — opening a browser on a headless server or inside a Docker container is meaningless and would fail silently, which is fine, but should not be attempted):

```ts
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url]
  try { Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] }) } catch { /* no GUI available — silent, matches today's behaviour */ }
}
```

A new `ENKAKU_NO_OPEN=1` escape hatch (documented in `.env.example`) for anyone who finds the behaviour unwanted — e.g. running the binary inside a devcontainer with no display.

### 4.12 B2 — AUP and traffic tagging

**The document.** `docs/acceptable-use.md`, scaffolded from spec §17's own bullets (QA/test-automation framing, "testing your own app," no rotation/proxy-pool abstractions, instrumentation over blind evasion) plus `LICENSES.md`'s existing structure as a template for tone and section layout. The plan scaffolds the required sections; **the policy content itself (what is permitted, what is prohibited, liability language) is not written by this plan** — see §9.4, an explicit owner decision.

**The tagging mechanism — the design question the task asked this plan to answer.** The architecture rules out a literal "HTTP header injected into every outbound request": `vpn-helper` (the only implemented network engine besides `none`) is a TUN-level SOCKS5 tunnel (`apps/guest-agent/.../route/Tun2Socks.kt`) — it relays TCP/UDP, not parsed HTTP, and rewriting an HTTPS request in flight requires terminating TLS, which is a MITM proxy: a much larger, more invasive feature than "tag traffic," and one that breaks certificate pinning in the very apps a QA farm is testing. Two scoped, buildable options that satisfy the spirit of §9.4 without that scope, so the owner can pick a scope rather than face an all-or-nothing choice:

- **Option A — device-scoped marker (default recommendation).** On session start, when a new `instrumentation.tagTraffic` farm setting (default `true`) is on, the core writes a device-readable marker via `adb shell setprop` — the exact mechanism `prep.rotation` (plan 85) and device identity spoofing (plan 58) already use with no guest agent required — e.g. `enkaku.farm.instrumented 1`. An app under test that wants to recognize farm traffic (the "testing your own app" case §17 is written for) reads this property itself. Recorded to the device event log, same as every other session-start action. Works regardless of which network engine is active, including `none` — the common case — because it does not depend on the network path at all.
- **Option B — SOCKS5-level tagging, layered on top of Option A when `vpn-helper` is active.** `Socks5RouteConfigSchema` (`network.ts:149`) already carries upstream credentials; a distinguishing username (e.g. `enkaku-farm-<deviceId>`) on the SOCKS5 CONNECT is visible to whoever operates the configured upstream proxy — which for the on-your-own-network case is the operator themselves — and covers 100% of the TCP traffic that actually flows through that engine. It does not reach the destination server (no MITM), only the proxy hop.

Both are cheap, both are honest about what they do and do not cover, and — critically — **neither makes "on by default" true when `engine: 'none'` and Option A is off**, which is the common case today (guest-agent APK has no shipped tier-3 resolution path per the source audit's separate finding). This plan's recommendation is: ship Option A on by default (it has no dependency on the guest agent or a configured route), layer Option B when `vpn-helper` is active, and narrow spec §9.4's "on by default" to describe Option A precisely rather than implying wire-level coverage of arbitrary third-party traffic it cannot provide. The exact wording of that narrowing is an owner call (§9.4).

### 4.13 B5 — Windows fleet: record, do not re-do

No new code. §5's step for this is a checklist item in this plan's own acceptance criteria (§6) and a note added to whatever release-process document exists — this plan proposes creating `docs/guide/release-checklist.md` naming the §7.3 ladder as a required gate before any MVP tag ships, rather than embedding the requirement only in a plan document nobody re-reads at cut time.

---

## 5. Implementation steps

**Concurrency map.** Grouped by which files each step touches, because two agents editing the same file at the same time is the only real serialization hazard here — nothing in this plan has a logical/data dependency on another step finishing first.

```
Standalone (any order, any subset in parallel):
  87.1  Studio auth UI              — packages/studio/src/app/{login,setup}/**, lib/auth.ts, AppShell.tsx
  87.4  ACL: job.cancel + ownerId   — job-service.ts, jobs.ts, ws-handlers.ts, devices.ts
  87.5  tapJitterMs                 — driver.ts, scrcpy-input.ts, device-executor.ts, settings.ts
  87.6  NFR honesty                 — descriptors.ts, tools/provision.test.ts
  87.7  agent_blobs bounded         — schema.ts, blob/store.ts, maintenance/retention.ts, settings.ts
  87.8  Windows in CI               — .github/workflows/ci.yml
  87.11 Backup mechanism + doctor   — db/backup.ts (new), doctor/checks/db.ts, a new CLI subcommand
  87.12 Browser auto-open           — index.ts, .env.example

Touch packages/core/src/server/http.ts — land as ONE step or serialize:
  87.2  Health honesty              — http.ts (the /api/health handler only)
  87.3  CORS + rate-limit hardening — http.ts (the CORS block) + auth/routes.ts
        (different functions in the same file; safe as one combined commit,
         or the second agent to touch http.ts rebases onto the first)

Touch shared docs (README.md / install.md / spec.md) — serialize on these three files:
  87.9  Docs + language hygiene     — README.md, docker-compose.yml, Dockerfile, spec.md §17
  87.13 AUP + tagging               — docs/acceptable-use.md (new — no collision), settings.ts,
                                       session start code, spec.md §9.4 (small, same file as 87.9's §17 edit)
  87.14 Release checklist           — docs/guide/release-checklist.md (new — no collision), install.md
        (87.9 and 87.14 both touch install.md; 87.13 and 87.9 both touch spec.md — pick one worker
         for whichever pair lands closer together, or take the small merge conflict)

Record-only, no file conflicts with anything:
  87.10 Windows fleet: record as a release gate — this plan's own §6, plus 87.14's new checklist file
```

### 87.1 — Studio login and setup (B1)

- [x] `packages/studio/src/lib/auth.ts`: `checkAuth()`, `AuthState`, per §4.1. **Landed differently:** the module exports `fetchMe()` (not `checkAuth()`) returning a discriminated `MeResult`, plus `AuthState` as a React-context shape (`user`, `authMode`, `setupNeeded`, `refresh`, `logout`) consumed via `useAuth()` — the same job, a different shape than the single async function §4.1 sketched.
- [x] `packages/studio/src/app/login/page.tsx`: email+password form, `auth.invalid_credentials`/`auth.rate_limited` error states, redirect back to the page the user was on.
- [x] `packages/studio/src/app/setup/page.tsx`: first-admin creation, disabled once `GET /api/auth/setup` reports `needed: false`.
- [x] `packages/studio/src/components/layout/AppShell.tsx`: the auth gate described in §4.1. **Landed differently:** the gate itself lives in two new files, `AuthGate.tsx` (route enforcement, `/login`↔`/setup`↔app redirects, a `AuthContext.Provider`) and `AuthShell.tsx`, which wrap `AppShell` — `AppShell.tsx` itself only consumes `useAuth()` for the header menu, it does not contain the gate logic §4.1 described living there.
- [x] Header user menu (email, role, logout) — hidden in `local` mode, matching `docs/plans/09-m7-multiuser-packaging.md:488`'s original spec. Confirmed at `AppShell.tsx:249` (`{authMode === 'server' && user && (...)}`).
- [ ] Correct `docs/plans/09-m7-multiuser-packaging.md`'s status line (`implemented` → `partial`, naming this gap) in the same commit. **Not done** — plan 09's status line is unchanged (`docs/plans/09-m7-multiuser-packaging.md:3` still reads `implemented`, no mention of the login UI ever being missing). Arguably moot now that 87.1 itself closed the gap that correction would have flagged, but the specific action this box asked for did not happen.
- **Verifiable result:** `ENKAKU_BIND=0.0.0.0 bun run dev`, open Studio from a second machine — the setup form appears, creating the first admin logs in and lands on the dashboard; a second browser session with no cookie is redirected to `/login`, not shown a 401 card. Component/unit tests for this flow (`lib/auth.test.ts`, `AuthGate.test.tsx`, `app/login/page.test.tsx`, `app/setup/page.test.tsx`) all pass (35/35).

### 87.2 — Health honesty (B3)

- [ ] `packages/core/src/server/http.ts:141-151`: compute `ok` from `adbState()`/orchestrator mode, per §4.2. **Deliberately not done, and reversed on purpose, not an oversight:** `http.ts`'s `/api/health` handler keeps `ok: true` unconditionally, with a comment explaining why — `ok` is redefined as a liveness signal only (`doctor/checks/port.ts` and `doctor/context.ts`'s `probeCore` both read it to distinguish "our core, still provisioning or even adb-broken" from "some other process on this port," and both would misreport a live, recoverable core if `ok` went `false`). Readiness moved entirely to `adb.state`, which is what `release.yml`'s poll below actually gates on. A regression test (`http.test.ts`, `'ok stays true regardless of adb.state'`) pins this so a future change cannot silently reintroduce §4.2's design by accident.
- [x] `.github/workflows/release.yml`: the `smoke` job (both unix and windows variants) polls until `ok === true` or a bounded timeout, failing the build and printing `health.json` on timeout. **Landed differently from the literal wording, same effect:** it polls up to 150×1s for `adb.state` to reach a terminal value (not literally `ok === true`, since `ok` no longer varies — see above), printing `health.json` and failing loudly on timeout, on both the unix and windows job variants.
- **Verifiable result:** deliberately point `ENKAKU_DATA_DIR` at a location where the adb download 404s (or mock the toolchain manager to fail) — `/api/health` reports `adb.state: 'error'`, and a `smoke` run against that build fails instead of publishing (not `ok: false` — see the deviation above).

### 87.3 — CORS and rate-limit hardening (S7)

- [x] `packages/core/src/server/http.ts:126-129`: gate on `deps.authMode !== 'server'` instead of `NODE_ENV`. Written as the equivalent positive form, `if (deps.authMode === 'local') { app.use(...) }` — same truth table for this two-mode enum.
- [x] `packages/core/src/auth/routes.ts:66-67`: `auth.trustProxy` farm setting; `server.requestIP(req)` fallback per §4.9. **Landed differently:** `trustProxy` is `ENKAKU_TRUST_PROXY=1` (an env var, documented in `.env.example` and `docs/guide/install.md`'s reverse-proxy path), not a farm setting read from `packages/protocol/src/settings.ts`. `server.requestIP(req)` fallback, and honouring only the rightmost `X-Forwarded-For` hop, are both exactly as designed.
- [ ] `packages/protocol/src/settings.ts`: the new `auth.trustProxy` field. **Not done** — no such field exists anywhere in `settings.ts`; see the deviation above, this is the same gap stated the other way.
- **Verifiable result:** boot in server mode with the shipped `deploy/enkaku.service` (no `NODE_ENV` set) — a cross-origin `fetch` from a loopback origin is now rejected; five failed logins from a spoofed `X-Forwarded-For` with `trustProxy: false` (the default, since `ENKAKU_TRUST_PROXY` is unset) still lock out the real caller's real IP. Confirmed by `auth/routes.test.ts` (both `trustProxy: false`/`true` describe blocks).

### 87.4 — ACL: job.cancel and device ownership (S1)

- [x] `packages/core/src/services/job-service.ts`: `cancel()` gains `actor`, per §4.3. **Landed differently:** `cancel()`'s signature is unchanged (no `actor` parameter) — the ownership check happens one layer up instead, directly in the route (`jobs.ts`) and the WS handler, both calling `canCancelJob(user, device)` (`auth/acl.ts`) before ever calling `service.cancel()`. Same security guarantee, different layer than §4.3 designed.
- [x] `packages/core/src/api/jobs.ts:155`, `packages/core/src/server/ws-handlers.ts:1514`: pass the actor through, add `requirePermission('job.view')`. **Landed differently:** neither route adds a `requirePermission('job.view')` middleware call — both instead call `canCancelJob(user, device)` inline (see above), which is the actual enforcement `job.cancel.any` vs. ownership needs; `job.view` was never separately checked.
- [x] `packages/core/src/api/devices.ts:465`: `requirePermission('device.settings')`, admin-only `ownerId`, `changedKeys` extended to `label`/`ownerId`. **Landed partly differently:** `PATCH /:id` has no blanket `requirePermission('device.settings')` call at all (a real gap from what this box asked for, though inert today — `device.settings` is already an OPERATOR permission in this codebase's two-role model, so no caller who could patch before lost or gained access). The part S1 actually flagged — an admin-only `ownerId` transition via the new `device.owner.set` permission, plus a `device.owner` audit record naming old and new owner — is built exactly as designed, and `changedKeys` correctly stays scoped to `settings`-derived keys (ownerId/label are audited separately, not folded into `changedKeys`, a sensible refinement of the box's wording).
- [x] Unit tests: an operator cannot cancel another operator's job on an owned device; can cancel their own; admin can cancel any; a non-admin `PATCH .../ownerId` is rejected and produces no silent success. Confirmed present and passing: `jobs.test.ts` (17 tests) and `ws-handlers-job.test.ts` (6 tests) each carry all four cases verbatim; `devices.test.ts` carries the ownerId-reject/accept/audit/no-op-idempotent cases. All green.
- **Verifiable result:** two operator accounts, one device owned by each — operator A's `POST /api/jobs/:id/cancel` against operator B's job returns 403, not 200. Verified by test, not by hand against a running server.

### 87.5 — tapJitterMs (S3)

- [x] Per §4.5's chosen option (wire vs. remove — see §9.3 for why this needs a quick owner nod before either lands, though both are small enough to redo if the wrong one ships first). **Wire** was chosen and shipped.
- [x] If wired: `driver.ts`, `scrcpy-input.ts`, `device-executor.ts` per §4.5; a unit test asserting a session with `tapJitterMs: [500, 600]` produces a tap hold in that range (mockable, no device needed — the input driver's own unit tests already stub the transport). Confirmed: `InputSink.tap` gained `opts.holdMs`, `sampleHoldMs()`, `ScrcpySdkInput`/`ScrcpyUhidInput` both honour it, `device-executor.ts` passes `timing.tapJitterMs` through. `input-engines.test.ts` covers sampling bounds, determinism under a seeded RNG, and both engines' real hold duration — all passing.
- [ ] If removed: `settings.ts`, the schema-form label, and a migration note in `docs/plans/00-overview.md` §9 (a genuine removal, not a version — per §4.3's own "replace, never version" rule, no compatibility shim is needed since this was never functional). **Not applicable** — the wire option shipped instead (previous box); this alternative was never going to be built alongside it.
- **Verifiable result:** Settings no longer contains a control with zero observable effect, either way. Confirmed — `tapJitterMs` now measurably changes tap-hold duration; `adb-input.ts` documents in its own docstring why it deliberately does not honour `opts.holdMs`.

### 87.6 — NFR honesty (S4)

- [x] `packages/drivers/src/descriptors.ts:43`: softened `displayName` per §4.6. Confirmed: `'UI server (persistent on-device, target <200 ms per find)'`.
- [x] New provisioning-time regression test per §4.6. Confirmed: `packages/toolchain/src/manager.bench.test.ts` (download+sha256+extract+activate, against a loopback fixture, explicitly scoped to "our own code's overhead, not GitHub's") and `packages/core/src/jobs/spawn-overhead.bench.test.ts` (the device-free half of the job-overhead NFR). A third file, `scripts/bench-device-nfrs.ts`, exists for the hardware-bound half but is correctly gated behind `ENKAKU_TEST_DEVICE=1` and was never run against real hardware here.
- **Verifiable result:** the test fails if a future change adds, say, a third download attempt with a long backoff that would blow the 90 s budget — today it passes.

### 87.7 — agent_blobs bounded (S5)

- [x] `packages/protocol/src/settings.ts`: `retention.agentBlobMaxAgeDays`, `retention.agentBlobMaxTotalMb`, per §4.7. **Landed differently and narrower:** the field that shipped is `retention.blobOrphanGraceHours` (default 24h) — a single grace period for unreferenced blobs, not an age bound on every blob plus a separate total-size quota. There is no size-based (`...MaxTotalMb`) control at all.
- [x] `packages/core/src/maintenance/retention.ts`: the orphan-safe sweep. **Landed differently:** the sweep lives in a new, dedicated module, `packages/core/src/agent/blob/gc.ts` (`createBlobGc`), not inside `maintenance/retention.ts` — wired into `daemon.ts` alongside `retention.start()`, sharing its sweep interval but not its file or its opt-in gate (deliberately always-on, matching `retention.ts`'s own precedent for device-event retention).
- [ ] `packages/core/src/agent/blob/store.ts`: a `delete(id)` method the sweep calls. **Not done** — `BlobStore`'s interface still exposes only `put`/`get`/`info`; `gc.ts` deletes rows with its own inline Drizzle `delete(agentBlobs).where(inArray(...))` query rather than going through the store.
- [ ] Unit tests: a blob referenced by a recent message survives an age-eligible sweep; an orphaned one does not; the byte-quota path evicts oldest-first like the existing artifact retention sweep it mirrors. **Partly landed:** the first two cases are thoroughly tested in `gc.test.ts` (13 tests — top-level and nested `tool_result` references, dedupe-shared blobs, grace-period boundaries, mixed-state sweeps, idempotency, start/stop) and all pass. The third case does not exist and cannot: there is no byte-quota mechanism to test (see the settings-field deviation above).
- **Verifiable result:** seed 200 synthetic blobs past the age bound with no referencing message rows, run the sweep, confirm the table shrinks and no `tool_result` in the last N days lost its image. Verified at unit-test scale (not 200 rows, but the same shape) — real-world growth from a live, never-deleted thread's own referenced screenshots is explicitly NOT bounded by this sweep, a stated limitation in `gc.ts`'s own doc comment, not a silent gap.

### 87.8 — Windows in CI (S6)

- [x] `.github/workflows/ci.yml`: matrix per §4.8. **Landed differently:** `check` itself stayed `runs-on: ubuntu-latest`, unchanged. A new, separate `check-windows` job runs on `windows-latest`, but only on a push to `main` or a PR carrying a `windows` label — not on every push/PR the way a `check` matrix would, with a comment citing `windows-latest` runner cost as the reason. It runs `typecheck`, `bun test`, Studio's tests, both plugin packs' tests, and `scripts/spec-check.test.ts` — a real, if narrower-than-designed and gated, Windows CI presence. **It has never executed even once**: this whole plan is still an uncommitted working tree (nothing has been pushed to `main`), so the job has never had a trigger fire.
- [ ] Confirm `scripts/check-plan-status.sh` and `scripts/check-harness-provenance.sh` actually run under `windows-latest`'s Git Bash — fix their shebangs/path handling if they do not (verify, do not assume). **Not done as asked — a different call was made instead:** the job's own comment states both scripts (plus `spec:check`) are *deliberately excluded* from `check-windows`, reasoning that they inspect committed text with no OS-dependent behaviour and that a Windows checkout's CRLF/LF translation could fail them "for the wrong reason." That is a considered decision, not an oversight, but it is not the verification this box asked for — nobody has confirmed either way whether the scripts actually run under Git Bash.
- **Verifiable result:** a PR shows two green `check` runs, `ubuntu-latest` and `windows-latest`, both actually executing `bun test` (not skipped). Not met as written — see the deviations above; `check-windows` exists but is conditional and unproven.

### 87.9 — Docs and language hygiene (S8, part of S9)

- [x] `README.md`: the release-binary section per §4.10. Confirmed: `## Running it (prebuilt binary)` near the top, before `## Running it (dev)`, with a real `curl`/`tar` walkthrough and a Windows note.
- [x] `docs/guide/install.md:13`: fill `OWNER/REPO`. Confirmed: `https://github.com/viandwi24/enkaku/releases/...`, matching `git remote -v`.
- [x] `docker-compose.yml`, `Dockerfile`: translate comments to English, preserving the security warnings' exact meaning. Confirmed: no Indonesian text remains (`grep -P '[^\x00-\x7F]'` only matches an ASCII-art `⇒` arrow inside an English comment); the two security-relevant lines cited in S8 (bind-mode ⇒ login required; the no-TLS quick-test warning) read in English with the same meaning.
- [x] `docs/spec.md` §17 (`:848-850`): "lease-scoped"/"per lease" → "device-scoped"/"per device". Confirmed (drifted slightly to `:852` by the time of this check, content matches): "a single operator-set route per device... A route that is explicit, device-scoped, and written to the device event log..." — §7.9 and §17 no longer disagree.
- **Verifiable result:** `grep -riP '[^\x00-\x7F]' docker-compose.yml Dockerfile README.md docs/guide/install.md` finds nothing beyond intentional non-ASCII (there should be none); `curl` against the filled-in release URL 404s only because no such tag exists yet, not because the path is a placeholder. Verified by grep.

### 87.13 — AUP and traffic tagging (B2)

- [x] `docs/acceptable-use.md`: scaffolded per §4.12, sections filled by the owner (§9.4). **Landed differently and beyond what §4.12 asked for:** the file exists (246 lines) with full policy prose already written — not just section scaffolding left for the owner to fill, which §4.12 explicitly said this plan should NOT do ("the policy content itself... is not written by this plan"). It is headed `> **Draft — awaiting the owner's ratification.**`, so it is presented as unfinished, but the actual text goes further than the plan's own stated boundary.
- [x] `packages/protocol/src/settings.ts`: `instrumentation.tagTraffic` (default `true`). Confirmed: `DeviceInstrumentationSchema`, `tagTraffic` default `true`.
- [x] Session-start code (`packages/session/src/session.ts`, next to where `prep.rotation`/identity spoofing already apply device-scoped `setprop` writes): Option A's marker write, reverted on session close the same idempotent way rotation already is. Confirmed: `packages/session/src/farm-tag.ts` (`FARM_TAG_PROPERTY = 'debug.enkaku.instrumented'`, `applyFarmTag`), called from `session.ts`. The module's own doc comment is explicit that `debug.*`-prefix writability was reasoned from Android's SELinux `property_contexts` model, not observed — "No physical device was reachable in the environment this module was written in... Verify it yourself on a real device."
- [ ] If Option B is approved: `Socks5RouteConfigSchema` username tagging in the `vpn-helper` apply path. **Not done** — no `enkaku-farm-<deviceId>`-style username tagging exists anywhere in the SOCKS5 route code; only Option A shipped.
- [x] `docs/spec.md` §9.4: narrowed wording matching whichever option(s) ship (small edit, coordinate with 87.9's §17 edit in the same file). Confirmed: §9.4 (`spec.md:448-451`) carries a dated "Mechanism note" describing exactly the shipped device-scoped-property mechanism and explicitly disclaiming the old "internal header or marker" wording as something "the architecture cannot honestly provide without a MITM proxy."
- **Verifiable result:** a fresh farm has `docs/acceptable-use.md` reachable from the product (linked from Settings or the setup flow, not just the repo root); a session on a device with `tagTraffic: true` shows the marker via `adb shell getprop enkaku.farm.instrumented`. **Not met on the first half:** grepping all of `packages/studio/src` for any reference to `acceptable-use` finds nothing — the document is reachable only from the repository, not from the product, which is what this line and acceptance criterion 2 both require. The second half (the marker itself) is real but hardware-unverified, and the property name in the running code is `debug.enkaku.instrumented`, not `enkaku.farm.instrumented` as this line literally names it — the spec's own §9.4 text uses the correct, matching name.
- **Reverted, 2026-08-12, owner direction — the AUP half only.** The gap this step recorded above (unratified, un-linked from Studio) was never actually a gap: `docs/acceptable-use.md`'s absence from the repository, before this plan's first checklist item created it, was a deliberate decision (added `ecdc24a`, deliberately deleted `d184063`), not an oversight this plan was right to fill. This step, and the six-audit process behind this plan, misread that absence as missing scope. The owner has now confirmed the original deletion was correct and ordered `docs/acceptable-use.md`, `packages/studio/public/acceptable-use.md`, the Studio sidebar link, and the drift test that kept the two copies in sync all removed again — the first checklist item above is therefore withdrawn, not delivered, regardless of how it reads. **The tagging half stands, delivered, unaffected:** `packages/protocol/src/settings.ts`'s `instrumentation.tagTraffic` (default `true`), `packages/session/src/farm-tag.ts`'s `debug.enkaku.instrumented` marker, and the session-start/close wiring are all still real, tested, and shipped — only their doc comments and `.describe()` text were reworded to explain the marker on its own terms (a device-under-automation disclosure) rather than as the mechanism behind a policy that no longer exists. `docs/spec.md` §9.4 and §17 carry their own dated withdrawal notes recording the same reversal.

### 87.11 — A safe backup procedure (B4)

- [x] `packages/core/src/db/backup.ts`: `backupTo()` per §4.4. **Landed differently:** the module is `packages/core/src/backup/index.ts` (a new `backup/` directory, alongside `backup/tar.ts` for the `.tar.gz` bundling), and the function is `createBackup`/`runBackup`, not `backupTo()` — same mechanism (`VACUUM INTO` over a read-only connection, `secrets.key` bundled alongside), different file and name.
- [ ] `POST /api/admin/backup` and an `enkaku backup <dir>` CLI subcommand, both calling it. **Half landed:** `enkaku backup <dir>` is real, dispatched from `packages/core/src/index.ts`, documented, and tested (`backup/index.test.ts`). There is no `POST /api/admin/backup` HTTP route — grepping the whole of `packages/core/src` for `admin/backup` finds nothing. Backup is CLI-only.
- [ ] `packages/core/src/doctor/checks/db.ts:15`: corrected remedy text. **Not done** — the remedy string is byte-for-byte the original: `'restore enkaku.db from a backup, or move it aside and let the core create a fresh one (local history is lost)'`. It still does not mention `enkaku backup` or the safe procedure that now exists.
- [x] `docs/guide/install.md`: a short "Backing up your farm" section — the safe procedure, and why a plain `cp` of `enkaku.db` is not it. Confirmed: `## Backup and restore` section, including a `### Why not \`cp enkaku.db backup.db\`` subsection naming both reasons (WAL, `secrets.key`).
- [x] Update `docs/spec-divergences.md`'s `DIV-059` row with the corrected reasoning, per the owner's decision (§9.2) — either a new feature description if the owner reinstates a scoped version, or an amended withdrawal note that no longer claims "copying one file." Confirmed, thoroughly: `DIV-059`'s row now carries a dated "Correction, 2026-08-11" paragraph reversing the withdrawal, explaining exactly why "copying one file" was wrong for this codebase, and describing what `enkaku backup` actually does — including flagging, in its own text, that `spec.md`'s corresponding line was consequently stale too (which was then also fixed — see §19's table).
- **Verifiable result:** `enkaku backup ./out` while the core is live under write load produces a database that `sqlite3 ./out/enkaku.db "PRAGMA integrity_check"` reports `ok` on, paired with a `secrets.key` that decrypts a known test secret after a simulated restore. Covered at unit-test scale (`backup/index.test.ts`); not hand-verified against a live, concurrently-writing core in this pass.

### 87.12 — Browser auto-open (S2)

- [x] `packages/core/src/index.ts`: `openBrowser()` per §4.11, local-mode-only, `ENKAKU_NO_OPEN` escape hatch. **Landed as designed, with a more thorough gate than §4.11 sketched:** `packages/core/src/util/open-browser.ts`'s `shouldOpenBrowser()` checks three independent signals (not orchestrator mode, loopback bind, an attached TTY) rather than just the loopback check §4.11's snippet showed, plus the `ENKAKU_NO_OPEN` escape hatch. Windows gets the `cmd /c start "" <url>` quoting fix for the empty-title pitfall.
- [x] `.env.example`: document the new variable. Confirmed: `# ENKAKU_NO_OPEN=1`.
- **Verifiable result:** `bun run dev` with no flags opens the default browser to `localhost:7700`; `ENKAKU_BIND=0.0.0.0 bun run dev` does not attempt it; `ENKAKU_NO_OPEN=1 bun run dev` does not either.

### 87.14 — Release checklist, naming B5 as a gate

- [ ] `docs/guide/release-checklist.md` (new): the Plan 85 §7.3 ladder as a named, required step before any MVP tag, alongside a short "what CI does NOT prove" list (drawn from `.github/workflows/ci.yml`'s own header comment, which already says this about the guest agent — extend the same honesty to the Windows fleet ladder). **Not done — the file does not exist.** `ls docs/guide/release-checklist.md` and a repo-wide search for "release checklist" both come up empty outside this plan document itself. B5 (the Windows hardware ladder as a named release gate) is therefore recorded nowhere a release-cutter would actually see it.
- [ ] One line in `docs/guide/install.md` pointing at it. **Not done** — there is nothing to point at (see above); `install.md` has no reference to a release checklist.
- **Verifiable result:** the checklist exists and is linked from somewhere a release-cutter would actually see it, not only from this plan document. **Not met.**

---

## 6. Acceptance criteria

1. `POST /api/auth/setup` and `/login` are reachable through real Studio pages; a fresh server-mode boot with no admin yet redirects every route to `/setup`, and a logged-out session to `/login`. (B1)
2. `docs/acceptable-use.md` exists and is linked from the product (not only the repo). The traffic-tagging mechanism actually shipped matches what `docs/spec.md` §9.4 claims — no gap between the sentence and the code. (B2) **Reverted, 2026-08-12, owner direction: the first half of this criterion is withdrawn** — `docs/acceptable-use.md` is deliberately absent again (see 87.13's own reverted note above), and this document does not claim otherwise. The second half stands: the device-under-automation marker still matches what `docs/spec.md` §9.4 claims, unaffected by the AUP's removal.
3. `GET /api/health` reports `ok: false` while adb is provisioning or has failed, `ok: true` only once `adbState === 'ready'` (or the process is in orchestrator mode). `release.yml`'s `smoke` job fails the build on a simulated provisioning failure. (B3)
4. `enkaku backup <dir>` (or the equivalent HTTP route) produces a database that passes `PRAGMA integrity_check` and a `secrets.key` that decrypts correctly after a simulated restore, documented in `docs/guide/install.md`. `DIV-059`'s decision reflects the corrected reasoning. (B4)
5. `docs/guide/release-checklist.md` exists and names the Plan 85 §7.3 ladder as a required, unstarted gate for this MVP tag. (B5)
6. Neither `POST /api/jobs/:id/cancel` nor the WS `job.cancel` message can be used by an operator to cancel a job on a device they do not own. `PATCH /api/devices/:id` is permission-gated, and an `ownerId` change is both admin-only and produces a `device_events` row. (S1)
7. `packages/core/src/index.ts` attempts to open the user's default browser on a plain `bun run dev`/release-binary local boot; `docs/spec.md` §2/§5.1 remains accurate. (S2)
8. `DeviceSettings.timing.tapJitterMs` either measurably changes tap-hold duration on a real (or mocked) input driver call, or no longer exists in the schema. (S3)
9. `packages/drivers/src/descriptors.ts:43`'s inspector claim reads as a target, not a measured fact; a CI-runnable test bounds first-run provisioning time. (S4)
10. `agent_blobs` has a working, tested delete path that never removes a blob a live message still references. (S5)
11. `.github/workflows/ci.yml`'s `check` job runs on `windows-latest` in addition to `ubuntu-latest`, and both actually execute the full suite. (S6)
12. A server-mode boot via `deploy/enkaku.service` (no `NODE_ENV` set) does not grant the loopback-origin CORS exception; login rate limiting cannot be defeated by a spoofed `X-Forwarded-For` when `auth.trustProxy` is `false` (the default). (S7)
13. `README.md` documents the release binary; `docs/guide/install.md:13` names the real repository; `docker-compose.yml`/`Dockerfile` comments are in English. (S8)
14. `docs/spec.md` §17 no longer contradicts §7.9 on lease- vs. device-scoped network routes. (S9)
15. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test` are green. `bash scripts/check-plan-status.sh` passes with this plan's status line updated.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| Auth gate | `packages/studio/src/lib/auth.test.ts` | `checkAuth()` maps `{needed:true}` → `setup-needed`, a 401 with `setupNeeded:false` → `unauthenticated`, a 200 → `authenticated` |
| Health honesty | `packages/core/src/server/http.test.ts` | `ok` follows `adbState()` exactly across `provisioning`/`ready`/`error`/`orchestrator` |
| job.cancel ownership | `packages/core/src/services/job-service.test.ts` | an operator cannot cancel another operator's owned-device job; can cancel their own; admin bypasses via `canUseDevice`'s admin branch |
| devices PATCH | `packages/core/src/api/devices.test.ts` | non-admin `ownerId` patch rejected; admin patch succeeds and is audited; `label`-only patch by an operator still succeeds |
| tapJitterMs | `packages/drivers/src/input/scrcpy-input.test.ts` (or session-level) | a configured `tapJitterMs` range is honored by the tap call |
| agent_blobs sweep | `packages/core/src/maintenance/retention.test.ts` | age+quota eviction; a referenced blob is never deleted regardless of age |
| backup | `packages/core/src/db/backup.test.ts` | `VACUUM INTO` output passes `PRAGMA integrity_check`; `secrets.key` is copied byte-for-byte |
| rate limiting | `packages/core/src/auth/routes.test.ts` | `trustProxy: false` ignores `X-Forwarded-For`; `trustProxy: true` uses it |
| CORS | `packages/core/src/server/http.test.ts` | server-mode never grants the loopback-origin exception regardless of `NODE_ENV` |

### 7.2 Manual smoke

```bash
bun run typecheck
bun test
bun run --cwd packages/studio test

# B1 — server mode setup/login
ENKAKU_BIND=0.0.0.0 ENKAKU_TLS_MODE=self ENKAKU_ALLOW_INSECURE=1 bun run dev
# open Studio from another device on the LAN — expect /setup, then /login on a second session

# B3 — health honesty
curl -s localhost:7700/api/health | jq '.ok, .adb.state'

# B4 — backup
bun run --cwd packages/core -- enkaku backup /tmp/enkaku-backup-test
sqlite3 /tmp/enkaku-backup-test/enkaku.db "PRAGMA integrity_check;"

# S1 — ACL
curl -s -X POST localhost:7700/api/jobs/<other-operators-job-id>/cancel -b "session=<operator-A-cookie>"
# expect 403, not 200

# S2 — browser open
bun run dev   # expect the default browser to open localhost:7700 unattended
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| B1's auth gate breaks local self-host if the "authenticated always in local mode" branch has a bug. | `checkAuth()`'s local-mode short-circuit is unit-tested in isolation from the server-mode path; manual smoke covers both explicitly. |
| The tagging mechanism (B2) is built to a scope the owner did not actually intend, and ships as the "on by default" claim before the owner reviews it. | §9.4 is an explicit go/no-build gate — 87.13 does not land until the owner picks Option A, B, both, or neither. |
| S1's `job.view` requirement on cancel accidentally blocks a caller who could cancel before but never had `job.view` explicitly checked. | `job.view` is already in the `OPERATOR` set (`acl.ts:118`) and every authenticated user is at least `operator` — no real caller loses access; verified by the unit test in 7.1. |
| B4's `VACUUM INTO` on a large database (growing per S5 until that ships) could be slow enough to matter on a live farm. | It reads through normal SQLite locking rather than blocking writers exclusively; documented as "safe to run live" not "free to run live" — an operator with a very large DB is told to expect it to take time, not surprised by a stall. |
| Windows-in-CI (S6) surfaces pre-existing platform bugs unrelated to this plan, expanding its scope unpredictably. | 87.8's own verification step checks the two `bash` scripts run under Git Bash *before* flipping the matrix on for the whole `check` job — if something deeper breaks, that becomes its own follow-up rather than blocking this plan's other 13 items. |
| The browser-auto-open feature (S2) is unwanted in some local-dev workflows (CI, devcontainers, `bun run dev` in a headless sandbox). | `ENKAKU_NO_OPEN=1`; also gated to local mode only, so it never fires in the sandboxed/CI paths that already set a non-loopback bind or run headless. |
| Several steps touch `docs/spec.md` (87.9's §17 fix, 87.13's §9.4 narrowing) — a real collision if both run concurrently. | Flagged explicitly in the concurrency map (§5); the fix is two one-line edits in different sections, trivially rebased if it does collide. |

## 9. Open questions

### 9.1 Severity of the browser-auto-open gap (S2)

One of the six source audits rated this a blocker on its own reasoning (§3.3). This plan keeps the commissioning task's `serious` label for its acceptance criteria but implements the fix regardless, so the disagreement does not change scope — only whether it is treated as release-blocking on its own. **Owner call**: does a missing zero-config browser-open block the MVP tag by itself, independent of everything else in this plan?

### 9.2 B4 — what shape does the corrected backup story take?

Now that "copying one file" is known to be wrong for this configuration (§3.1, §4.4), the owner has more choices than "withdraw" or "build the original Settings-screen feature":
- Ship §4.4's minimal CLI/API backup helper and call the promise kept (this plan's default assumption, §5 step 87.11).
- Ship the CLI helper but keep the spec's claim withdrawn, documenting the procedure only in `docs/guide/install.md` as an operator-run recipe (closer to the original "operator territory" framing, but now with a correct recipe instead of a `cp`).
- Build the full Settings-screen UI Plan 09's original design implied.
**This plan defaults to the first option in its implementation steps** but does not commit `DIV-059`'s final wording — that edit happens after the owner picks.

### 9.3 S3 — wire tapJitterMs or delete it?

Both are small. Wiring it delivers on an existing spec promise (§9.3, "tap jitter... resemble a human"); deleting it is honest about a feature that was never fully designed for the UHID input path (`adb-input.ts` never modeled tap as down/up at all). **Owner call**, cheap to reverse either way.

### 9.4 B2 — the AUP's actual content, and the tagging option(s) to ship

The two items in this whole plan that are not an agent's decision to make:
- **The AUP's policy text** — what is permitted, what is prohibited, what liability language applies. §4.12 scaffolds sections; the words are the owner's, likely with legal review given `LICENSES.md`'s own open `PERLU REVIEW HUKUM` item suggests this repo is already tracking at least one pending legal pass.
- **Which tagging option(s) actually ship** (§4.12: device-scoped marker, SOCKS5-level tagging, both, or a narrowed spec claim instead of new code). This is a product-positioning decision as much as a technical one — it decides what "on by default" is allowed to mean in the sentence a customer reads.

### 9.5 The tracked-removal deadline observed in passing (§3.1's aside)

Not part of this plan's scope, but flagged: Plan 61's `agent.hello`/`agent.json`/`/agent/ws` compatibility shims were due for removal "by v0.1.7" (`docs/plans/00-overview.md` §9), and `v0.1.7` has now shipped with all three still present. Whoever next touches that table should decide whether to extend the deadline or remove the shims in a follow-up, small commit — separate from this plan.
