# Plan 224 — MVP wave 5 : Retention, first run and packaging, the test-strategy reset, and the spec finalised

> Status: implemented (software) — G10 is the only row open, and it needs the owner's hardware (see §11)
> Depends on: plan 202 (docs reset — the `docs/spec.md` skeleton this plan finalises; the three `TBD by plan 224` markers), plan 219 (Plugins and Settings — the Settings page that renders `FarmSettingsSchema.storage`, plan 212's Retention section). Transitively also complete by the time this plan executes: plan 211 (jobs and runs — ships the `RunRetentionPolicy`/`RunRetentionSweeper` interface this plan implements, at `packages/core/src/jobs/runs/sweeper.ts`), plan 212 (Settings — the `storage.*` fields this plan reads and the constants file `packages/core/src/config/constants.ts`), plan 201 (housekeeping — deletes the Studio/`@enkaku/ui` test suites this plan's measurement depends on being gone), plan 221 (guest agent — the release workflow's APK pin, which this plan verifies rather than repeats), plan 213 (Studio shell — `AppShell.tsx`, `StatusBar.tsx`, `AuthGate.tsx`'s existing `/setup` route, which this plan's first-run work must not collide with).
> Spec references: `docs/spec.md` §16 (Retention), §17 (non-functional targets), §18 (Release and packaging) as plan 202 wrote them — quoted verbatim in §3 below; §0 ("Measured, not promised"); §21 (section map). This plan closes the three `TBD by plan 224` markers those sections carry.
> Ships: packages/core/src/retention/sweeper.ts

---

## 0. Goal checklist

Every command runs from the repo root, on the `mvp` branch, after every plan this one depends on has landed. `GREP_224` is defined once in §10 and copied verbatim wherever cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The retention sweeper implements plan 211's interface and deletes runs, orphan jobs, trace directories, artifacts, device/job events and stale audit rows | one `createRetentionSweeper` in `packages/core/src/retention/sweeper.ts`; `packages/core/src/maintenance/` is gone | `bun test packages/core/src/retention/sweeper.test.ts` passes; `test ! -d packages/core/src/maintenance` | [x] |
| G2 | A dry run and the real sweep agree on exactly what is removed | a seeded database with 5 expired runs, 2 fresh runs, 1 orphan job, 3 stale artifacts, 1 farm-owned job whose only run is 40 days old | `bun test packages/core/src/retention/sweeper.test.ts` → the test named `sweepOnce deletes exactly what dryRun reported` passes | [x] |
| G3 | A job whose runs are all expired and that no schedule owns is deleted; a schedule-owned job's last run is never deleted | two seeded jobs, one with `scheduleId` set | `bun test packages/core/src/retention/sweeper.test.ts` → tests `an orphan job with zero runs is swept` and `a schedule-owned job never loses its last run` pass | [x] |
| G4 | `GET /api/storage/usage` answers per kind without touching the filesystem on the request path | 4 kinds: `jobsAndLogs`, `traceFrames`, `artifacts`, `audit` | `bun test packages/core/src/api/storage.test.ts` passes; the route handler contains no `readdir`/`stat`/`rmSync` call (`rg -n "readdir\|statSync\|readdirSync" packages/core/src/api/storage.ts` → empty) | [x] |
| G5 | The retention defaults match MVP 09 §6 exactly | jobs/logs 30 days, trace frames 7 days, artifacts 30 days or 20 GB, audit 90 days | `bun test packages/protocol/src/settings.test.ts` → the existing plan-212 defaults test still passes unmodified (this plan changes no default); `rg -n "AUDIT_RETENTION_DAYS = 90" packages/core/src/config/constants.ts` → one line | [x] (grep discrepancy — see §11) |
| G6 | The release workflow's guest-agent pin is intact (plan 221's work, verified not repeated) | `pin-guest-agent` step present, `TODO-M55` absent | `rg -n "pin-guest-agent" .github/workflows/release.yml` → at least one line; `rg -n "TODO-M55" packages/toolchain/manifest/enkaku-tools.json` → empty | [x] |
| G7 | The packaging decision is recorded as a step, not a comment: single binary plus browser, desktop parked | `docs/spec.md` §18's packaging line carries the decision, no `TBD` | `rg -n "TBD by plan 224" docs/spec.md \| rg -n "packaging"` → empty; `rg -n "single binary plus a browser" docs/spec.md` → at least one line | [x] |
| G8 | The desktop app is untouched: not built, not deleted, not wired to CI | `apps/desktop/` unchanged | `git diff --stat main -- apps/desktop` → empty | [x] |
| G9 | `bun run doctor`'s checks are reachable from Studio's first screen, not only the CLI | the status bar's health indicator opens a popover rendering `GET /api/doctor` | owner smoke §7.4 step 3; `rg -n "api/doctor" packages/studio/src/components/shell` → at least one line | [x] software; owner smoke step still open |
| G10 | A fresh install reaches the first device in under five minutes | itemised numbered procedure, owner-timed | §7.4, owner-run, timed with a stopwatch | owner |
| G11 | The backend `bun test` duration is measured and recorded, and the retirement decision follows the measured number | one number, one branch taken (retire or defer) | §5 step 224.9's transcript in the plan's own §11 handoff report | [x] |
| G12 | `docs/spec.md` carries zero `TBD by plan 224` markers | 0 matches | `rg -n "TBD by plan 224" docs/spec.md` → empty | [x] |
| G13 | Every remaining `TBD by plan NNN` marker in the spec is listed in this plan's §3.6 with its owner | the list matches the spec exactly | `rg -o "TBD by plan [0-9]+" docs/spec.md \| sort -u` output equals §3.6's table, by eye (owner cross-check at handoff) | [x] |
| G14 | The workspace typechecks | 0 errors | `bun run typecheck` exits 0 | [x] |
| G15 | Forbidden vocabulary (plan 200 §2.4) is absent from this plan's new files | 0 matches | `GREP_224` (§10) → empty | [x] |

## 1. Goals

1. Implement the retention sweeper at the interface plan 211 shipped (`packages/core/src/jobs/runs/sweeper.ts`'s `RunRetentionPolicy`/`RunRetentionSweeper`/`CreateRunRetentionSweeper`), reading the defaults plan 212 wrote into `FarmSettingsSchema.storage` (MVP 09 §6, MVP 14 §5).
2. Replace `packages/core/src/maintenance/retention.ts` — today's artifact-and-event-only sweep — with one consolidated module, `packages/core/src/retention/sweeper.ts`, that also expires job/run history, deletes orphan jobs, and expires audit rows, so a farm has exactly one nightly sweep rather than two.
3. Ship `GET /api/storage/usage`, a per-kind usage readout (jobs and logs, trace frames, artifacts, audit) computed from a cache the sweeper maintains, never from a per-request filesystem walk, and render it in Settings → Storage (plan 219's Retention section, extended with a bespoke usage row the same way that plan splices in Access and Toolchain).
4. Record the packaging decision (MVP 09 §4, MVP 16 §4 open decision 6) as fact in `docs/spec.md` §18: single binary plus a browser for the MVP; the desktop app stays parked, outside the MVP definition of done, untouched by this plan.
5. Make `bun run doctor`'s checks reachable from Studio's first screen (MVP 09 §4: "`bun run doctor` becomes the first screen, not a CLI") by resolving plan 213's own open question 2 (§9 of that plan) with one of the options it names: a popover on the status bar's health dot.
6. Write the numbered, owner-run procedure that measures "first device in under five minutes" (MVP 09 §4, MVP 16 §5.2) and record its steps in this plan so the owner can run it verbatim.
7. Measure the full backend `bun test` once, record the number, and take the branch plan 200 §8.3 sets up: under 60 s retires `CLAUDE.md`'s "never run a full test suite" rule and plan 200 §8.2's testing-policy table (exact replacement text given in §5 step 224.9); at or over 60 s, name what is slow and defer with the number recorded.
8. Close every `TBD by plan 224` marker in `docs/spec.md` (§16 Retention, §18 packaging, §18 test strategy) and list every other open `TBD by plan NNN` marker with its owner, so the spec states its own completeness honestly (MVP 09 §1, plan 202 §3.4 rule 2).

## 2. Non-goals

| Not done here | Done by |
|---|---|
| The guest-agent APK build, sign, sha256, and the release workflow's pin-writing step | plan 221 (this plan only verifies G6, does not repeat the work) |
| Device lifecycle hardening, the 20-device and 100-device scale runs, the measured wall-tile ceiling | plan 223 (MVP 09 §2, §7) — not a dependency of this plan; if 223 has not landed when this plan executes, this plan's NFR rows stay `not measured` for the metrics 223 owns, and §9 records it |
| Building `apps/desktop` (Tauri), wiring it to CI or the release workflow, or deleting it | never in the MVP definition of done (MVP 16 §4 open decision 6, MVP 13 Part B.2's own note); this plan records the decision that keeps it parked and touches no file under `apps/desktop/` |
| The Agents page (roster, runs, approvals, files) and its settings tab | plan 220 (design pending, MVP 16 §4 open decision 1) — its `TBD by plan 220` markers stay open, listed in §3.6, not decided here |
| The Retention section's schema-driven field rendering (labels, hints, the `SchemaForm` wiring) | plan 219 (already lands the `storage` section's 3 visible fields); this plan only adds the bespoke usage readout beside them |
| Rewriting `docs/design.md` | MVP 15 §3 step 6, as the screens land; unaffected by this plan |
| A second, farm-configurable retention window for the audit log | §9 Q1 (inherited from plan 212 §9 Q1, still open); this plan ships the 90-day constant plan 212 already named |
| Raising the Bun SQLite trace-tree walk to an incremental, write-time-tracked byte counter | §8 R3; this plan's once-a-day full walk is the shipped design, not a stopgap awaiting a follow-up plan |

## 3. Context and design decisions

### 3.1 The spec skeleton this plan closes

`docs/spec.md` does not yet exist in its MVP form on disk — plan 202 is `draft — not started` as of this writing, and the file at that path today is still the 1 198-line prototype spec. Plan 202's own document (`docs/plans/202-mvp-docs-reset.md:198-614`) contains the skeleton it will write verbatim; this plan cites that text as the spec's content, because by the time this plan executes plan 202 (wave 0) has already landed. Three lines carry the marker this plan closes:

- `docs/plans/202-mvp-docs-reset.md:548` (spec §16, Retention): `"Per kind, with defaults: jobs and logs 30 days, trace frames 7 days, artifacts 30 days or a size cap, audit 90 days. Retention applies per run: old runs of a job expire individually; the job row stays while it has any run or while a schedule owns it, and is deleted by the same nightly sweeper otherwise. A Storage row in Settings shows usage per kind. TBD by plan 224 (source: MVP 09 §6, MVP 14 §5)."`
- `docs/plans/202-mvp-docs-reset.md:582` (spec §18, packaging): `"Packaging for the MVP: single binary plus a browser is the CTO's recommendation; the desktop app (\`apps/desktop\`, Tauri) is parked outside the MVP definition of done, not deleted. Decision: CEO, \`docs/mvp/README.md\` Open decisions 6 and MVP 09 §4. TBD by plan 224 (source: MVP 09 §4)."`
- `docs/plans/202-mvp-docs-reset.md:583` (spec §18, test strategy): `"Test strategy: colocated unit tests; Studio component tests in one process with per-file mock hygiene or shrunk to the components with logic; one hardware smoke suite on the lab device on every merge to \`main\`. TBD by plan 224 (source: MVP 09 §5)."`

These are the *only* three `TBD by plan 224` markers in the skeleton (verified `grep -n "TBD by plan" docs/plans/202-mvp-docs-reset.md` on 2026-09-03: matches at lines 365 → plan 220, 470 → plan 219, 548/582/583 → plan 224; every other match is prose describing the marker convention itself, not an instance of it). §5 step 224.10 rewrites all three in place.

### 3.2 The retention interface plan 211 ships

`docs/plans/211-mvp-jobs-and-runs.md:835-871` (§4.9, quoted in full because this plan implements it verbatim):

```ts
export interface RunRetentionPolicy {
  /** Runs finished longer ago than this are candidates. */
  runDays: number
  /** Never sweep the latest run of a job, whatever its age. */
  keepLatest: boolean
  /** Rows per transaction, so a first sweep after an upgrade cannot hold the write lock. */
  chunk: number
}

export interface RunRetentionSweeper {
  sweepOnce(): { runs: number; jobs: number }
}

export const NO_OP_RUN_SWEEPER: RunRetentionSweeper = { sweepOnce: () => ({ runs: 0, jobs: 0 }) }

export type CreateRunRetentionSweeper = (deps: { db: Db; runs: RunStore; policy: RunRetentionPolicy }) => RunRetentionSweeper
```

Plan 211 ships this type and `NO_OP_RUN_SWEEPER` only, at `packages/core/src/jobs/runs/sweeper.ts`, with **zero callers in `daemon.ts`** (its own G12). It says, in its own comment: *"Plan 224 writes the policy (the defaults, the nightly cadence, the Storage row in Settings) and wires this into `maintenance/retention.ts`."* This plan does exactly that, with one correction recorded here per plan 200 §2.2 ("the file wins for facts, the plan wins for intent"): `maintenance/retention.ts` is not merely edited, it is **replaced** by `packages/core/src/retention/sweeper.ts`, because the run/job sweep this plan adds cannot sit beside the artifact-and-event sweep as a second, uncoordinated module without the audit trail, the storage-usage cache, and the sweep cadence all drifting independently. §10 records the deletion.

`RunStore` (`packages/core/src/jobs/runs/store.ts`, plan 211 §4.3) exposes `deleteRuns(runIds: string[]): { runs: number; jobsTouched: string[] }` as "the ONLY delete path for a run", but its own import list (`jobRuns`, `jobs` only) shows it touches exactly those two tables: it removes `job_runs` rows and recomputes `jobs.latest_run_id`/`jobs.run_count` for every job it touched. It does **not** touch `job_events`, `artifacts`, or the trace directory on disk. This plan's sweeper is the caller responsible for those three, in this order, mirroring `packages/core/src/jobs/purge.ts`'s existing job-level cascade (`deleteJobsWithHistory`, read in full on 2026-09-03) at run granularity instead of job granularity:

1. Delete `job_events` rows for the candidate run ids.
2. Delete the trace directory for each candidate run id (`<dataDir>/traces/<runId>/`, plan 211 §4.10 point 8 renames these from `<dataDir>/traces/<jobId>/` during its migration).
3. Delete artifact files then `artifacts` rows for the candidate run ids (`artifacts.runId`, renamed from `jobId` by plan 211 §4.1.5).
4. Call `runs.deleteRuns(runIds)`.
5. Delete every job `deleteRuns` reported in `jobsTouched` whose `run_count = 0 AND schedule_id IS NULL AND parent_workflow_job_id IS NULL` (the exact predicate `RunRetentionSweeper.sweepOnce`'s own doc comment names, `docs/plans/211-mvp-jobs-and-runs.md:861`).

### 3.3 What exists today (verified 2026-09-03, before plans 205–222 land)

`packages/core/src/maintenance/retention.ts` (257 lines, read in full) is the current whole-of-retention module, wired once at `packages/core/src/daemon.ts:3505-3513`:

```ts
retention = createRetentionGc({
  db,
  dataDir: cfg.dataDir,
  settings: settingsStore,
  log: log.child('retention'),
  intervalMinutes: cfg.retention.sweepIntervalMinutes,
  onSwept: (r) => audit.record({ userId: null, action: 'retention.gc', meta: r }),
})
retention.start()
```

It runs four sweeps today, three of them deliberately ungated by `policy.enabled` (its own comments explain why: an unbounded append-only stream is a disk-filling bug, not an opt-in convenience):

- `sweepEvents()` — `device_events`, keyed on `deps.settings.get().retention.eventMainDays`/`eventInputDays`/`eventMaxRowsPerDevice`.
- `sweepCommandRuns()` — `command_runs`/`command_run_members`, keyed on `retention.commandRunDays`. **These two tables are deleted by plan 207** (`docs/mvp/13-removal-register.md` A.6a: "command runs and their history" — `commandRuns`/`commandRunMembers` — replaced by the `adb` action in the generic set). By the time this plan executes the function and its tables no longer exist; this plan does not port it.
- `sweepTraces()` — `job_events` plus `<dataDir>/traces/<jobId>/`, keyed on `retention.traceDays` (default 30 today; plan 212 F13 changes the default to **7** and the reader to `storage.traceDays`). Plan 211 renames the directory and the column to `runId`; this plan's ported version reads `runId` throughout.
- `sweepOnce()`'s own artifact pass — `artifacts`, age (`retention.maxAgeDays`) then quota (`retention.maxTotalGb`), gated by `policy.enabled` (default `false` today). Plan 212 F6 deletes `enabled` outright: **retention is always on** (MVP 09 §6 says "a nightly sweeper", not an opt-in), and F7/F8 rename the readers to `storage.artifacts.maxAgeDays`/`maxTotalGb`.

`cfg.retention.sweepIntervalMinutes` (`packages/core/src/config.ts:30`, `z.number().int().min(1).default(60)`) is a **process-level** config constant, not a farm setting, and this plan does not touch it: the sweep already runs hourly (looser than "nightly", which is the floor MVP 09 §6 names, not a ceiling) and `retention.start()` already calls `sweepOnce()` once synchronously before the first interval, so a fresh farm gets its first sweep — and, per §4.4 below, its first usage snapshot — within the boot sequence rather than up to an hour later.

`packages/core/src/maintenance/retention.ts` has exactly one real importer, `daemon.ts`; `packages/core/src/agent/blob/gc.ts:10` names it only in a comment (`"the shape maintenance/retention.ts already applies to artifacts"`), not an import. Deleting the module and its test (`retention.test.ts`, 12.6 KB) orphans no other file.

### 3.4 The Settings fields this plan reads (plan 212, already landed by execution time)

`docs/plans/212-mvp-settings.md:470-498` (§4.1, quoted verbatim — the executor must read the real `packages/protocol/src/settings.ts` for line numbers, since plan 212 lands first and this plan does not repeat its own citations):

```ts
storage: z
  .object({
    historyDays: z
      .number().int().min(1).max(3_650).default(30)
      .describe('Jobs, runs and device logs older than this are deleted by the nightly sweep.')
      .meta(ui({ title: 'Keep job history and logs for', kind: 'count' })),
    traceDays: z
      .number().int().min(1).max(3_650).default(7)
      .describe('Job traces older than this are deleted, with their captured frames and UI snapshots. Traces are the largest thing on disk.')
      .meta(ui({ title: 'Keep trace frames for', kind: 'count' })),
    artifacts: z
      .object({
        maxAgeDays: z.number().int().min(1).max(3_650).default(30).describe('Artifacts older than this are deleted.').meta({ title: 'Maximum age (days)' }),
        maxTotalGb: z.number().min(0.1).max(10_000).default(20).describe('Once the total passes this, the oldest are deleted first.').meta({ title: 'Maximum size (GB)' }),
      })
      .default({ maxAgeDays: 30, maxTotalGb: 20 })
      .describe('Screenshots, recordings and downloads a job produced. Whichever limit is reached first applies.')
      .meta(ui({ title: 'Keep artifacts' })),
  })
  .default({ historyDays: 30, traceDays: 7, artifacts: { maxAgeDays: 30, maxTotalGb: 20 } })
  .meta({ title: 'Retention', 'x-enkaku': { group: 'Storage' } }),
```

Plan 212 F118 (`docs/plans/212-mvp-settings.md:298`) adds the fourth kind as a **constant**, not a farm field, because MVP 12 §1's visible list does not include it and plan 212's own open question 1 (§9) leaves visible-vs-advanced to a later human call: `AUDIT_RETENTION_DAYS = 90` in `packages/core/src/config/constants.ts`, overridable with `ENKAKU_AUDIT_RETENTION_DAYS`. This plan reads that constant directly; it does not resolve plan 212's open question (§9 Q1 below restates it rather than deciding it, per plan 200 §2.1).

`retention.enabled`, `retention.commandRunDays`, `retention.eventInputDays`, `retention.eventMaxRowsPerDevice`, `retention.blobOrphanGraceHours` are all gone from the farm schema by the time this plan executes (plan 212 F6, F10, F11, F12): the first three constants stay live inside the sweeper as fixed values (`INPUT_EVENT_RETENTION_DAYS`, `EVENT_MAX_ROWS_PER_DEVICE`, `BLOB_ORPHAN_GRACE_HOURS`, all defined by plan 212 in `packages/core/src/config/constants.ts`), read by this plan exactly the way it reads `AUDIT_RETENTION_DAYS`.

### 3.5 Packaging and the desktop app, verified 2026-09-03

`apps/desktop/src-tauri/tauri.conf.json` (read in full): `"externalBin": []`, `"resources": []` — the sidecar mechanism the app exists for is not configured. `apps/desktop/src-tauri/src/main.rs` resolves the core binary from `ENKAKU_CORE_BIN` or a bare `enkaku-core` `PATH` lookup (`std::env::var("ENKAKU_CORE_BIN").unwrap_or_else(|_| "enkaku-core".to_string())`), never a Tauri sidecar. `.github/workflows/release.yml` and `.github/workflows/ci.yml` (both read in full) contain zero references to `apps/desktop`, `tauri`, or any Rust toolchain step. This matches `docs/mvp/13-removal-register.md` Part B.2 exactly ("not wired to CI or release at all... if the MVP ships as binary plus browser, the desktop app is parked outside the MVP definition of done, not deleted") and is not re-verified further; this plan's G8 only proves the plan itself made no edit there.

`.github/workflows/release.yml` (read in full, 2026-09-03) already does everything the MVP packaging decision needs for "single binary plus a browser": `build-nix`/`build-darwin` compile `packages/core/src/entry-release.gen.ts` (which `scripts/gen-embedded-entry.ts` generates, embedding the Studio static export, the drizzle migrations and the plugin packs) via `bun build --compile`; the `smoke` job boots the real artifact on Linux, macOS and Windows and polls `GET /api/health` until `adb.state` reaches a terminal value before `publish` runs. This is the "release workflow publishes a binary that boots and answers `/api/health`" goal-checklist line from the brief — already true today, unrelated to this plan's own changes, and reverified by G6/G8 rather than rebuilt.

`build-guest-agent` (read in full) builds, signs, size-budgets (4 MiB) and uploads `guest-agent.apk`, and `publish` attaches it plus a `SHA256SUMS.txt` line. **What it does not yet do, as of 2026-09-03, is write the sha256/versionCode pin into `packages/toolchain/manifest/enkaku-tools.json`** — this is exactly the gap plan 221 §4.12/§5 step 221.11 closes (`scripts/pin-guest-agent.ts`, a new workflow step gated on `startsWith(github.ref, 'refs/tags/v')`, committing the manifest to the default branch). Since plan 221 is a dependency of this wave (MVP 16 §3: wave 4 before wave 5) and this plan's own G6 only asserts the step exists, this plan does not touch `release.yml` at all unless G6 fails — in which case §9 Q2 records the discrepancy and blocks nothing else in §5.

### 3.6 Every `TBD by plan NNN` marker in the spec, and its owner

From `grep -n "TBD by plan" docs/plans/202-mvp-docs-reset.md` (the skeleton plan 202 writes verbatim), read on 2026-09-03. This table is what G13 checks against the real `docs/spec.md` at execution time.

| Spec section | Marker | Owner | Closed by this plan? |
|---|---|---|---|
| §4.9 Agent and files | `TBD by plan 220 (source: MVP 06 §3, MVP 15 §2)` | plan 220 | No — Agents design is pending (MVP 16 §4 open decision 1); this plan does not decide it |
| §10 Plugins | `TBD by plan 219 (source: MVP 13 Part B, plugin surface)` | plan 219 | No — plan 219 is a dependency of this plan, and by the time 219 lands it either closes its own marker or does not; this plan neither owns nor touches §10 |
| §16 Retention | `TBD by plan 224 (source: MVP 09 §6, MVP 14 §5)` | this plan | **Yes** — §5 step 224.10 |
| §18 Release and packaging (packaging line) | `TBD by plan 224 (source: MVP 09 §4)` | this plan | **Yes** — §5 step 224.10 |
| §18 Release and packaging (test strategy line) | `TBD by plan 224 (source: MVP 09 §5)` | this plan | **Yes** — §5 step 224.9/224.10 |

If, at execution time, `docs/spec.md` carries a `TBD by plan 224` marker not listed above (plan 202 having drifted since this plan was written) or is missing one of the three listed here, plan 200 §2.2 applies: the file wins for facts. The executor updates this table in the committed plan and proceeds; it does not invent a fourth marker to close.

## 4. Technical design

### 4.1 `packages/core/src/retention/sweeper.ts` (new — the shipped artefact)

```ts
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { changedRows } from '../db'
import type { Db } from '../db'
import { artifacts, auditLog, deviceEvents, jobEvents, jobRuns, jobs, storageUsage } from '../db/schema'
import {
  AUDIT_RETENTION_DAYS,
  BLOB_ORPHAN_GRACE_HOURS,
  EVENT_MAX_ROWS_PER_DEVICE,
  INPUT_EVENT_RETENTION_DAYS,
} from '../config/constants'
import { createTraceFrameStore, type TraceFrameStore } from '../jobs/trace/frame-store'
import type { RunStore } from '../jobs/runs/store'
import type { CreateRunRetentionSweeper, RunRetentionPolicy } from '../jobs/runs/sweeper'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { Logger } from '../util/logger'

/** Rows per `deleteRuns` transaction — plan 211's own `chunk` field, sized like `purge.ts`'s `BATCH_SIZE`. */
const RUN_SWEEP_CHUNK = 500

/** How often the storage-usage cache is recomputed, independent of the deletion cadence (§4.4). */
const USAGE_RECOMPUTE_MS = 24 * 60 * 60 * 1000

export interface RetentionSweepResult {
  runsDeleted: number
  jobsDeleted: number
  artifactsDeleted: number
  artifactBytesFreed: number
  eventsDeleted: number
  tracesDeleted: number
  auditDeleted: number
}

export interface RetentionSweeper {
  start(): void
  stop(): void
  /** One pass: run/job sweep, trace sweep, artifact sweep, event sweep, audit sweep — in that order. */
  sweepOnce(): RetentionSweepResult
  /**
   * The same computation `sweepOnce()` would perform, without deleting or
   * writing anything — G2's dry run. Exists so an operator (or a test) can
   * ask "what would this remove" before it happens.
   */
  dryRun(): RetentionSweepResult
}

/**
 * The retention sweeper (MVP 09 §6, MVP 14 §5, plan 211 §4.9's interface).
 * Replaces `packages/core/src/maintenance/retention.ts` in full (§10) — one
 * module owns every deletion the farm performs on a schedule, so the audit
 * trail, the sweep cadence and the storage-usage cache cannot drift apart.
 *
 * Ungated sweeps (device events, job/run history, trace frames, audit) never
 * had, and never gain, an `enabled` switch: an unbounded append-only stream
 * is a disk-filling bug, not an opt-in convenience (the reasoning
 * `maintenance/retention.ts` already stated for events and traces, extended
 * here to the two new sweeps). The artifact sweep loses its own `enabled`
 * flag in this plan (plan 212 F6): retention is always on.
 */
export function createRetentionSweeper(deps: {
  db: Db
  dataDir: string
  settings: FarmSettingsStore
  runs: RunStore
  createRunRetentionSweeper: CreateRunRetentionSweeper
  log: Logger
  intervalMinutes: number
  onSwept?: (result: RetentionSweepResult) => void
}): RetentionSweeper {
  let timer: ReturnType<typeof setInterval> | null = null
  let usageTimer: ReturnType<typeof setInterval> | null = null
  const traceStore = createTraceFrameStore({ dataDir: deps.dataDir })

  function runPolicy(): RunRetentionPolicy {
    return { runDays: deps.settings.get().storage.historyDays, keepLatest: true, chunk: RUN_SWEEP_CHUNK }
  }

  /** Candidate run ids: terminal, older than the cutoff, and not their job's latest run. */
  function candidateRunIds(cutoffMs: number): string[] {
    return deps.db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
      .where(
        and(
          inArray(jobRuns.status, ['success', 'failed', 'cancelled', 'expired']),
          or(ne(jobs.latestRunId, jobRuns.id), isNull(jobs.latestRunId)),
          lt(sql`coalesce(${jobRuns.finishedAt}, ${jobRuns.createdAt})`, new Date(cutoffMs)),
        ),
      )
      .all()
      .map((r) => r.id)
  }

  function cascadeDeleteRuns(runIds: string[]): { events: number; traceDirs: number; artifactsDeleted: number; bytesFreed: number } {
    if (runIds.length === 0) return { events: 0, traceDirs: 0, artifactsDeleted: 0, bytesFreed: 0 }
    let traceDirs = 0
    for (const runId of runIds) {
      const dir = traceStore.jobDir(runId) // renamed to run-keyed by plan 211 §4.10 point 8; the store's own accessor name is unchanged
      if (!existsSync(dir)) continue
      try {
        rmSync(dir, { recursive: true, force: true })
        traceDirs += 1
      } catch (err) {
        deps.log.warn(`failed to remove trace directory for run ${runId}: ${String(err)}`)
      }
    }
    const events = changedRows(deps.db.delete(jobEvents).where(inArray(jobEvents.runId, runIds)).run())
    const artifactRows = deps.db.select().from(artifacts).where(inArray(artifacts.runId, runIds)).all()
    let bytesFreed = 0
    for (const row of artifactRows) {
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        bytesFreed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact file ${row.path}: ${String(err)}`)
      }
    }
    const artifactsDeleted = changedRows(deps.db.delete(artifacts).where(inArray(artifacts.runId, runIds)).run())
    return { events, traceDirs, artifactsDeleted, bytesFreed }
  }

  /** The run/job sweep — plan 211's interface, chunked so a first sweep after upgrade cannot hold the write lock. */
  function sweepRunsAndJobs(): { runs: number; jobs: number; events: number; traceDirs: number; artifactsDeleted: number; bytesFreed: number } {
    const policy = runPolicy()
    const cutoffMs = Date.now() - policy.runDays * 86_400_000
    const ids = candidateRunIds(cutoffMs)
    let runsTotal = 0
    let jobsTotal = 0
    let events = 0
    let traceDirs = 0
    let artifactsDeleted = 0
    let bytesFreed = 0
    for (let i = 0; i < ids.length; i += policy.chunk) {
      const batch = ids.slice(i, i + policy.chunk)
      const cascade = cascadeDeleteRuns(batch)
      events += cascade.events
      traceDirs += cascade.traceDirs
      artifactsDeleted += cascade.artifactsDeleted
      bytesFreed += cascade.bytesFreed
      const sweeper = deps.createRunRetentionSweeper({ db: deps.db, runs: deps.runs, policy })
      // `sweepOnce()` here re-derives its own candidate set from `policy` and
      // deletes exactly `batch` plus recomputes latest_run_id/run_count —
      // constructed fresh per chunk because the interface takes a plain
      // policy object, not a live getter (§3.2); cheap, stateless, no
      // behaviour differs from calling it once outside the loop.
      const outcome = sweeper.sweepOnce()
      runsTotal += outcome.runs
      jobsTotal += outcome.jobs
    }
    if (runsTotal > 0 || jobsTotal > 0) {
      deps.log.info(`run/job retention: deleted ${runsTotal} run(s), ${jobsTotal} orphan job(s)`)
    }
    return { runs: runsTotal, jobs: jobsTotal, events, traceDirs, artifactsDeleted, bytesFreed }
  }

  /** Device event log GC (plan 18 §3.3/§4.4), unchanged in shape from `maintenance/retention.ts`, reading the renamed field. */
  function sweepDeviceEvents(): number {
    const mainDays = deps.settings.get().storage.historyDays
    let deleted = 0
    const mainCutoff = new Date(Date.now() - mainDays * 86_400_000)
    const inputCutoff = new Date(Date.now() - INPUT_EVENT_RETENTION_DAYS * 86_400_000)
    deleted += changedRows(deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'main'), lt(deviceEvents.at, mainCutoff))).run())
    deleted += changedRows(deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'input'), lt(deviceEvents.at, inputCutoff))).run())
    const counts = deps.db
      .select({ deviceId: deviceEvents.deviceId, stream: deviceEvents.stream, cnt: sql<number>`count(*)`.as('cnt') })
      .from(deviceEvents)
      .groupBy(deviceEvents.deviceId, deviceEvents.stream)
      .all()
    for (const row of counts) {
      const excess = row.cnt - EVENT_MAX_ROWS_PER_DEVICE
      if (excess <= 0) continue
      const oldestIds = deps.db
        .select({ id: deviceEvents.id })
        .from(deviceEvents)
        .where(and(eq(deviceEvents.deviceId, row.deviceId), eq(deviceEvents.stream, row.stream)))
        .orderBy(asc(deviceEvents.at))
        .limit(excess)
        .all()
        .map((r) => r.id)
      deleted += changedRows(deps.db.delete(deviceEvents).where(inArray(deviceEvents.id, oldestIds)).run())
    }
    return deleted
  }

  /** Age- then quota-based artifact sweep — no longer gated by `enabled` (plan 212 F6). */
  function sweepArtifactQuota(): { deleted: number; bytesFreed: number } {
    const policy = deps.settings.get().storage.artifacts
    const rows = deps.db.select().from(artifacts).orderBy(asc(artifacts.createdAt)).all()
    const cutoff = Date.now() - policy.maxAgeDays * 86_400_000
    const expired = rows.filter((r) => (r.createdAt?.getTime() ?? 0) < cutoff)
    let bytesFreed = 0
    for (const row of expired) {
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        bytesFreed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact ${row.path}: ${String(err)}`)
      }
    }
    let deleted = expired.length
    if (expired.length > 0) deps.db.delete(artifacts).where(inArray(artifacts.id, expired.map((r) => r.id))).run()

    const remaining = rows.filter((r) => !expired.includes(r))
    const quotaBytes = policy.maxTotalGb * 1024 ** 3
    let total = remaining.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)
    const overflow: string[] = []
    for (const row of remaining) {
      if (total <= quotaBytes) break
      overflow.push(row.id)
      total -= row.sizeBytes ?? 0
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        bytesFreed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact ${row.path}: ${String(err)}`)
      }
    }
    if (overflow.length > 0) deps.db.delete(artifacts).where(inArray(artifacts.id, overflow)).run()
    deleted += overflow.length
    return { deleted, bytesFreed }
  }

  /** Audit log GC (MVP 09 §6: 90 days) — new; nothing swept this table before this plan. */
  function sweepAudit(): number {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000)
    return changedRows(deps.db.delete(auditLog).where(lt(auditLog.at, cutoff)).run())
  }

  function sweepOnce(): RetentionSweepResult {
    const ranj = sweepRunsAndJobs()
    const eventsDeleted = sweepDeviceEvents() // device-event age/ceiling sweep; independent of the run sweep's own job_events deletion above
    const artifactQuota = sweepArtifactQuota()
    const auditDeleted = sweepAudit()
    const result: RetentionSweepResult = {
      runsDeleted: ranj.runs,
      jobsDeleted: ranj.jobs,
      artifactsDeleted: ranj.artifactsDeleted + artifactQuota.deleted,
      artifactBytesFreed: ranj.bytesFreed + artifactQuota.bytesFreed,
      eventsDeleted: ranj.events + eventsDeleted,
      tracesDeleted: ranj.traceDirs,
      auditDeleted,
    }
    const any = Object.values(result).some((n) => n > 0)
    if (any) deps.log.info(`retention sweep: ${JSON.stringify(result)}`)
    deps.onSwept?.(result)
    return result
  }

  function dryRun(): RetentionSweepResult {
    // Read-only mirror of sweepOnce's SELECTs, computing counts without a
    // single DELETE or rmSync. Kept as its own function (not sweepOnce with
    // a flag threaded through six helpers) so neither can accidentally
    // delete on a dry-run call or skip counting on a real one.
    const policy = runPolicy()
    const cutoffMs = Date.now() - policy.runDays * 86_400_000
    const runIds = candidateRunIds(cutoffMs)
    const jobsTouched = new Set(
      deps.db.select({ jobId: jobRuns.jobId }).from(jobRuns).where(inArray(jobRuns.id, runIds)).all().map((r) => r.jobId),
    )
    const orphanJobs = [...jobsTouched].filter((jobId) => {
      const row = deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get()
      return row && row.runCount - countRunIdsForJob(runIds, jobId) <= 0 && row.scheduleId === null && row.parentWorkflowJobId === null
    })
    // ...artifact/event/audit dry counts computed with the same SELECTs
    // sweepOnce's own helpers use, minus every DELETE/rmSync call.
    return {
      runsDeleted: runIds.length,
      jobsDeleted: orphanJobs.length,
      artifactsDeleted: 0, // full implementation mirrors sweepArtifactQuota's SELECT-only half
      artifactBytesFreed: 0,
      eventsDeleted: 0,
      tracesDeleted: runIds.length,
      auditDeleted: 0,
    }
  }

  function countRunIdsForJob(runIds: string[], jobId: string): number {
    return deps.db.select({ id: jobRuns.id }).from(jobRuns).where(and(eq(jobRuns.jobId, jobId), inArray(jobRuns.id, runIds))).all().length
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void sweepOnce(), deps.intervalMinutes * 60_000)
      sweepOnce()
      // Usage computation is decoupled from the deletion cadence (§4.4): a
      // full trace-tree walk on every hourly sweep would cost real boot-path
      // latency on a mature farm, for a number nothing reads more than once
      // a day. Deferred one tick so it never blocks the synchronous boot
      // sequence the line above is part of.
      queueMicrotask(() => recomputeStorageUsage(deps, traceStore))
      usageTimer = setInterval(() => recomputeStorageUsage(deps, traceStore), USAGE_RECOMPUTE_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
      if (usageTimer) clearInterval(usageTimer)
      timer = null
      usageTimer = null
    },
    sweepOnce,
    dryRun,
  }
}
```

`dryRun`'s full body (elided above for length — the implementation step names every SELECT it must mirror) computes the artifact/event/audit counts with the same read-only queries `sweepArtifactQuota`/`sweepDeviceEvents`/`sweepAudit` use internally, never calling `rmSync` or a `.delete()` statement; G2's test asserts the two agree field-for-field on one seeded database.

### 4.2 `packages/core/src/retention/storage-usage.ts` (new — the cache writer, kept separate from the sweeper's deletion logic)

```ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Db } from '../db'
import { artifacts, auditLog, deviceEvents, jobEvents, jobRuns, storageUsage } from '../db/schema'
import type { Logger } from '../util/logger'

export type StorageUsageKind = 'jobsAndLogs' | 'traceFrames' | 'artifacts' | 'audit'

/** Per-row byte overhead assumed for kinds with no stored size column (jobsAndLogs, audit) — an estimate, not an exact accounting; documented on the API response too (§4.3). */
const ROW_OVERHEAD_BYTES = 96

function dirBytes(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      const st = statSync(full)
      total += st.isDirectory() ? dirBytes(full) : st.size
    } catch {
      // A file removed between readdir and stat (a concurrent sweep) is
      // simply not counted this pass; the next pass picks up the true state.
    }
  }
  return total
}

/**
 * Walks `<dataDir>/traces/` ONCE and recomputes every kind's usage row.
 * Called once at boot (deferred a tick) and once every 24h thereafter
 * (`createRetentionSweeper`'s own timer, §4.1) — never on the `GET
 * /api/storage/usage` request path, which only ever reads the table this
 * function writes (§4.3's own doc comment restates this).
 */
export function recomputeStorageUsage(deps: { db: Db; dataDir: string; log?: Logger }, traceDirRoot: string): void {
  const now = new Date()
  const artifactAgg = deps.db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${artifacts.sizeBytes}), 0)` }).from(artifacts).get()
  const jobRunsN = deps.db.select({ n: sql<number>`count(*)` }).from(jobRuns).get()
  const jobEventsAgg = deps.db.select({ n: sql<number>`count(*)`, len: sql<number>`coalesce(sum(length(${jobEvents.meta})), 0)` }).from(jobEvents).get()
  const deviceEventsAgg = deps.db.select({ n: sql<number>`count(*)`, len: sql<number>`coalesce(sum(length(${deviceEvents.meta})), 0)` }).from(deviceEvents).get()
  const auditAgg = deps.db
    .select({ n: sql<number>`count(*)`, len: sql<number>`coalesce(sum(length(${auditLog.meta}) + length(coalesce(${auditLog.target}, '')) + length(${auditLog.action})), 0)` })
    .from(auditLog)
    .get()

  const jobsAndLogsRows = (jobRunsN?.n ?? 0) + (jobEventsAgg?.n ?? 0) + (deviceEventsAgg?.n ?? 0)
  const jobsAndLogsBytes = jobsAndLogsRows * ROW_OVERHEAD_BYTES + (jobEventsAgg?.len ?? 0) + (deviceEventsAgg?.len ?? 0)
  const traceBytes = dirBytes(traceDirRoot)
  const auditBytes = (auditAgg?.n ?? 0) * ROW_OVERHEAD_BYTES + (auditAgg?.len ?? 0)

  const rows: Array<{ kind: StorageUsageKind; bytes: number; rows: number }> = [
    { kind: 'jobsAndLogs', bytes: jobsAndLogsBytes, rows: jobsAndLogsRows },
    { kind: 'traceFrames', bytes: traceBytes, rows: 0 }, // file count is not tracked; bytes is the number that matters on disk
    { kind: 'artifacts', bytes: artifactAgg?.bytes ?? 0, rows: artifactAgg?.n ?? 0 },
    { kind: 'audit', bytes: auditBytes, rows: auditAgg?.n ?? 0 },
  ]
  for (const row of rows) {
    deps.db
      .insert(storageUsage)
      .values({ kind: row.kind, bytes: row.bytes, rows: row.rows, computedAt: now })
      .onConflictDoUpdate({ target: storageUsage.kind, set: { bytes: row.bytes, rows: row.rows, computedAt: now } })
      .run()
  }
  deps.log?.info(`storage usage recomputed: ${rows.map((r) => `${r.kind}=${(r.bytes / 1024 ** 2).toFixed(1)}MB`).join(', ')}`)
}
```

### 4.3 Schema addition — `packages/core/src/db/schema.ts`

```ts
/**
 * The Storage usage cache (plan 224, MVP 09 §6): one row per kind, recomputed
 * once at boot and once every 24h by `retention/storage-usage.ts`, never on
 * the API request path. `GET /api/storage/usage` reads this table and
 * nothing else — a trace-directory byte count is the one figure here that
 * needs a filesystem walk to produce, and that walk happens on the sweeper's
 * own clock, not a client's.
 */
export const storageUsage = sqliteTable('storage_usage', {
  kind: text('kind').primaryKey(), // 'jobsAndLogs' | 'traceFrames' | 'artifacts' | 'audit'
  bytes: integer('bytes').notNull().default(0),
  rows: integer('rows').notNull().default(0),
  computedAt: integer('computed_at', { mode: 'timestamp' }).notNull(),
})

export type StorageUsageRow = typeof storageUsage.$inferSelect
```

Also edited: `artifacts` (§4.1.5 changes already landed by plan 211 rename `jobId`→`runId`, unchanged further by this plan), `jobEvents` (same), `auditLog` gains no column (only a new index would help the sweep's own `lt(auditLog.at, cutoff)` scan — `idx_audit_at` already exists on `at`, so no migration is needed there).

Migration: generated by `bun run --cwd packages/core db:generate` after the schema edit above, never hand-written (00-overview §4.2, plan 200 §3.3). One new table, no renames, no prompts.

### 4.4 `packages/protocol/src/api/storage.ts` (new)

```ts
import { z } from 'zod'

export const StorageUsageKindSchema = z.enum(['jobsAndLogs', 'traceFrames', 'artifacts', 'audit'])

export const StorageUsageRowSchema = z.object({
  kind: StorageUsageKindSchema,
  bytes: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  /** Unix seconds; when the cache was last recomputed, not when this response was served. */
  computedAt: z.number().int().nonnegative(),
})

/** `GET /api/storage/usage` (plan 224, MVP 09 §6). Always a cache read — see `packages/core/src/retention/storage-usage.ts`'s doc comment for why. */
export const StorageUsageResponseSchema = z.object({
  kinds: z.array(StorageUsageRowSchema),
  totalBytes: z.number().int().nonnegative(),
})
```

Exported from `packages/protocol/src/index.ts`'s barrel alongside the other `api/*` schemas.

### 4.5 `packages/core/src/api/storage.ts` (new route)

```ts
import { Hono } from 'hono'
import { StorageUsageResponseSchema } from '@enkaku/protocol'
import { desc, eq } from 'drizzle-orm'
import type { AuthEnv } from '../auth/middleware'
import type { Db } from '../db'
import { storageUsage } from '../db/schema'
import { typedJson } from './typed-json'

/**
 * `GET /api/storage/usage` — reads the cache `retention/storage-usage.ts`
 * writes (§4.2); performs no filesystem access and no aggregate query of its
 * own. No permission gate beyond authentication, matching `GET /api/settings`
 * (both are farm-descriptive reads, not device or job actions).
 */
export function createStorageRoutes(db: Db): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/usage', (c) => {
    const rows = db.select().from(storageUsage).all()
    const kinds = rows.map((r) => ({
      kind: r.kind as 'jobsAndLogs' | 'traceFrames' | 'artifacts' | 'audit',
      bytes: r.bytes,
      rows: r.rows,
      computedAt: r.computedAt ? Math.floor(r.computedAt.getTime() / 1000) : 0,
    }))
    const totalBytes = kinds.reduce((sum, r) => sum + r.bytes, 0)
    return typedJson(c, StorageUsageResponseSchema, { kinds, totalBytes })
  })

  return app
}
```

Wired in `daemon.ts` the same way `doctorRoutes`/`settingsRoutes` are (constructed once, passed into the HTTP server's deps object, mounted at `/api/storage`): `storageRoutes: createStorageRoutes(db)`.

### 4.6 `daemon.ts` wiring (edit)

Replaces the block quoted in §3.3:

```ts
// Retention sweep (MVP 09 §6, MVP 14 §5; plan 211's run/job interface plus
// events, traces, artifacts and audit) and the storage-usage cache it
// maintains for GET /api/storage/usage (§4.2-§4.5).
retention = createRetentionSweeper({
  db,
  dataDir: cfg.dataDir,
  settings: settingsStore,
  runs, // the RunStore instance plan 211 §4.11 already wires here
  createRunRetentionSweeper,
  log: log.child('retention'),
  intervalMinutes: cfg.retention.sweepIntervalMinutes,
  onSwept: (r) => audit.record({ userId: null, action: 'retention.sweep', meta: r }),
})
retention.start()
```

`createRunRetentionSweeper` (a new function this plan writes, satisfying plan 211's `CreateRunRetentionSweeper` type) lives in `packages/core/src/jobs/runs/sweeper.ts` beside the interface it implements — the one edit this plan makes to a file plan 211 shipped, filling in the function the type names but plan 211 deliberately left unwritten (`docs/plans/211-mvp-jobs-and-runs.md:867`: "Plan 211 ships this and only this: a sweeper that removes nothing"). Its body is exactly what `docs/plans/211-mvp-jobs-and-runs.md:857-864`'s doc comment specifies: delete the runs named by the policy (oldest-first, excluding each job's `latestRunId`, chunked), call `runs.deleteRuns`, and report the counts. `NO_OP_RUN_SWEEPER` stays exported for tests that construct a host without a real database.

`AuditAction` (`packages/core/src/auth/audit.ts:154`) — one line changed: `'retention.gc'` becomes `'retention.sweep'`, its comment updated to name the five things the sweep now covers (runs, jobs, artifacts, events, audit) instead of one.

### 4.7 Studio — the doctor popover (extends plan 213's `StatusBar.tsx`)

Resolves plan 213 §9 Q2 verbatim ("a popover on the dot") — quoted from that plan: *"Is that enough for a first run downloading three tools over a slow link, or does the detail need a home, a toast, a popover on the dot, or a Settings → Toolchain live section (plan 219)? ... Nothing in this plan blocks on it: the dot ships either way."* This plan takes the popover option.

`packages/studio/src/components/shell/DoctorPopover.tsx` (new): a small popover anchored to the status bar's existing health dot (`packages/studio/src/components/shell/StatusBar.tsx`, plan 213), opened on click, fetching `GET /api/doctor` (`DoctorResponseSchema`, already shipped — `packages/core/src/api/doctor.ts`, read in full in §3, unchanged by this plan) through Studio's existing `api()` helper, and rendering each check's `status`/`observed`/`remedy` as a short list — the same three fields `renderHuman` already prints on the CLI, so the browser and the terminal show the identical report (the doctor route's own doc comment already states this invariant; this plan is the first Studio caller of it). No new endpoint: this is a pure consumer of `GET /api/doctor`.

`StatusBar.tsx` gains one prop wiring: the health dot's `onClick` opens `DoctorPopover` instead of doing nothing. No change to the dot's own colour/state logic (plan 213 §4.3 rule 6, unchanged).

Zero tests (Studio has none, plan 200 §8.3); verified by `bun run typecheck` and the owner smoke in §7.4.

### 4.8 Studio — the Storage usage row (extends plan 219's Settings → Storage section)

`packages/studio/src/components/settings/StorageUsageRow.tsx` (new): fetches `GET /api/storage/usage` and renders four rows — kind label, a human byte size, a relative "as of" time from `computedAt` — spliced into the Storage section's render the same way plan 219 §3.3 decision 8 splices Access and Toolchain beside the schema-driven fields (a bespoke component appended by section id, not read from the schema). Mounted once, above the three `storage.*` fields `SchemaForm` already renders (historyDays, traceDays, artifacts).

Zero tests, same as §4.7; verified by typecheck and the owner smoke.

### 4.9 `docs/spec.md` edits (§16, §18)

Exact replacement text for the three markers named in §3.1 and §3.6, applied in step 224.10:

**§16 Retention** (replaces the whole section body):

> Per kind, with defaults: jobs and logs 30 days, trace frames 7 days, artifacts 30 days or a size cap, audit 90 days (`packages/protocol/src/settings.ts`'s `storage` block; `AUDIT_RETENTION_DAYS` in `packages/core/src/config/constants.ts`). Retention applies per run: old runs of a job expire individually; the job row stays while it has any run or while a schedule owns it, and is deleted by the same sweeper otherwise (`packages/core/src/retention/sweeper.ts`). The sweep runs on the existing hourly cadence (`ENKAKU_RETENTION_SWEEP_INTERVAL_MINUTES`, default 60 — looser than the nightly floor this section names, never looser than daily). A Storage row in Settings shows usage per kind (`GET /api/storage/usage`), computed from a cache the sweeper recomputes once at boot and once every 24 hours, never on the request path.

**§18 Release and packaging** (packaging line, replaces the `TBD` sentence only, the two lines before it unchanged):

> Packaging for the MVP: a single binary plus a browser. The desktop app (`apps/desktop`, Tauri) stays parked outside the MVP definition of done — not built, not wired to CI or the release workflow, not deleted. Decided by the CEO (`docs/mvp/README.md` Open decisions 6, MVP 09 §4), recorded by plan 224.

**§18 Release and packaging** (test strategy line, replaces the `TBD` sentence only):

> Test strategy: the full backend `bun test` is measured at «N» s on the maintainer's laptop (plan 224, §11 handoff report). «Either: "Under the 60 s target — `CLAUDE.md`'s 'never run a full test suite' rule and plan 200 §8.2's testing-policy table are retired; an executor runs the full backend suite instead of scoped files." Or: "At or over the 60 s target — deferred; «what is slow» is the named cause, and the rule stays in force until a later plan lowers the number."» One hardware smoke suite on the lab device on every merge to `main` remains a target, not yet built (plan 223 or later; not this plan's scope).

The executor fills in `«N»` and the bracketed branch from step 224.9's real measurement — never guesses ahead of running it (plan 200 §2.5: "never predict a result you have not seen").

## 5. Implementation steps

Read plan 200 §2 and `CLAUDE.md` before the first edit. Every `path:line` in this plan was verified by reading the file on 2026-09-03; match on the quoted content when a line has drifted because plans 205–222 landed first. Commit per step as `feat(mvp-224): …` or `chore(mvp-224): …`.

### 224.1 Verify preconditions

- Files read only: `docs/spec.md` (must already carry the plan-202 skeleton — G6/G12's grep targets), `packages/protocol/src/settings.ts` (must already carry `FarmSettingsSchema.storage` as §3.4 quotes it), `packages/core/src/jobs/runs/sweeper.ts` and `store.ts` (must already exist, plan 211), `.github/workflows/release.yml` (must already carry a `pin-guest-agent` step, plan 221).
- Verifiable result: G6's grep passes; if any of the other three checks fail, stop and report which dependency has not actually landed — do not proceed by re-implementing another plan's work.
- Do not: implement any part of plan 211, 212, 219 or 221's own scope "since it's missing." A missing dependency is a blocked plan, reported in §11, not a licence to expand this plan's own boundary.

### 224.2 Schema and migration

- Files changed: `packages/core/src/db/schema.ts` (§4.3: add `storageUsage`).
- Files created: `packages/core/drizzle/00XX_<name>.sql` and its `meta/` entries, via `bun run --cwd packages/core db:generate` — never hand-written.
- Verifiable result: a second `db:generate` prints `No schema changes, nothing to migrate`.
- Do not: add a `bytes`/`rows` column pair per kind as separate named columns ("jobsAndLogsBytes", "traceFramesBytes", ...). One row per kind keeps the table extensible without a migration if a fifth kind is ever added.

### 224.3 The run/job sweeper function

- Files changed: `packages/core/src/jobs/runs/sweeper.ts` (add `createRunRetentionSweeper`, satisfying `CreateRunRetentionSweeper`; `NO_OP_RUN_SWEEPER` and the three interfaces stay exactly as plan 211 wrote them).
- Test file: `packages/core/src/jobs/runs/sweeper.test.ts` (new): `createRunRetentionSweeper deletes only runs older than runDays`, `it never deletes a job's latest run`, `it recomputes run_count and latest_run_id after a delete`, `NO_OP_RUN_SWEEPER still returns zero for both counts` (a regression guard: this plan must not have quietly changed the no-op's behaviour).
- Verifiable result: `bun test packages/core/src/jobs/runs/sweeper.test.ts` passes.
- Do not: give `createRunRetentionSweeper` a signature that diverges from `CreateRunRetentionSweeper`. If the interface turns out to be wrong once real data is run through it, that is a discrepancy for §11, not licence to redefine the type plan 211 shipped.

### 224.4 The consolidated retention module

- Files created: `packages/core/src/retention/sweeper.ts` (§4.1), `packages/core/src/retention/sweeper.test.ts`, `packages/core/src/retention/storage-usage.ts` (§4.2), `packages/core/src/retention/storage-usage.test.ts`.
- Files deleted: `packages/core/src/maintenance/retention.ts`, `packages/core/src/maintenance/retention.test.ts` (§10).
- Test file `sweeper.test.ts`: `sweepOnce deletes exactly what dryRun reported` (G2 — seed 5 expired terminal runs across 2 jobs, 2 fresh runs, run both, compare field by field), `an orphan job with zero runs is swept` (G3 — a job created with no run at all, via `RunStore.createJob` and no `addRun`), `a schedule-owned job never loses its last run` (G3 — a job with `scheduleId` set, one run 200 days old, still present after the sweep, only its extra older runs gone), `device events respect storage.historyDays for main and the fixed constant for input`, `artifacts sweep is not gated by an enabled flag` (seed a farm settings row before plan 212's own migration would have added `enabled`; confirm removal proceeds anyway), `artifact quota deletes oldest-first once the total exceeds maxTotalGb`, `audit rows older than AUDIT_RETENTION_DAYS are deleted`, `a trace directory is removed only for a run that was actually swept`.
- Test file `storage-usage.test.ts`: `recomputeStorageUsage writes one row per kind`, `artifacts bytes matches the exact SUM(sizeBytes)` (an exact check, unlike the other three kinds' estimate), `a second call overwrites rather than duplicates rows` (`onConflictDoUpdate`), `an empty database still writes four rows, all zero`.
- Verifiable result: `bun test packages/core/src/retention/` passes; G1, G2, G3.
- Do not: gate any of the four sweeps (run/job, events, traces, audit) behind an `enabled` flag. Only the artifact sweep ever had one, and plan 212 already removed it.

### 224.5 Protocol and API route

- Files created: `packages/protocol/src/api/storage.ts` (§4.4), `packages/core/src/api/storage.ts` (§4.5), `packages/core/src/api/storage.test.ts`.
- Files changed: `packages/protocol/src/index.ts` (barrel export).
- Test file: `packages/core/src/api/storage.test.ts` (`GET /usage returns the four kinds in a fixed order`, `it never calls readdirSync/statSync` — a spy asserting the module under test performs zero filesystem calls on the request path, the mechanical form of G4).
- Verifiable result: `bun test packages/core/src/api/storage.test.ts` passes; G4.
- Do not: compute usage inline in the route handler "for freshness." The route is a cache read, full stop; freshness is the sweeper's job on its own clock (§4.1, §4.2).

### 224.6 `daemon.ts` and `auth/audit.ts` wiring

- Files changed: `packages/core/src/daemon.ts` (§4.6: replace the `createRetentionGc` import and call site with `createRetentionSweeper`; add `createStorageRoutes(db)` to the HTTP deps object beside `doctorRoutes`/`settingsRoutes`), `packages/core/src/auth/audit.ts` (rename `'retention.gc'` to `'retention.sweep'` in `AuditAction`, update its comment).
- Test file: none new (daemon.ts wiring is exercised by the smoke test in §7, not a unit test — matching how the pre-existing `retention` wiring was never unit-tested either).
- Verifiable result: `bun run typecheck` exits 0; `rg -n "retention.gc" packages/core/src` → empty; `rg -n "retention.sweep" packages/core/src/auth/audit.ts` → one line.
- Do not: keep `'retention.gc'` as a second, still-valid `AuditAction` value "for old rows already written under it." The audit log stores the string as free text (`action: text('action').notNull()`); an old row keeps reading back fine with its old string, and the type union is a write-time constraint only — 00-overview §4.3 applies (replace, never version).

### 224.7 Studio: the doctor popover and the Storage usage row

- Files created: `packages/studio/src/components/shell/DoctorPopover.tsx` (§4.7), `packages/studio/src/components/settings/StorageUsageRow.tsx` (§4.8).
- Files changed: `packages/studio/src/components/shell/StatusBar.tsx` (wire the dot's `onClick`), the Settings page's Storage section (mount `StorageUsageRow` above the schema-driven fields — the exact file and splice point are plan 219's `app/settings/page.tsx` as it stands once that plan has landed; match on its `id === 'storage'` branch by content, the same way plan 219 §3.3 decision 8 matches `id === 'access'`).
- Test file: none (plan 200 §8.3, Studio has zero tests).
- Verifiable result: `bun run typecheck` exits 0; G9's grep; owner smoke §7.4 steps 2-3.
- Do not: write a `*.test.tsx` for either component. Do not add `happy-dom` or `@testing-library`. Do not build a `/setup`-style standalone provisioning page — `/setup` already exists (first-admin bootstrap, `packages/studio/src/app/setup/page.tsx`, `AuthGate.tsx`'s existing `setupNeeded` gate) and means something else entirely; reusing or renaming it would break the auth flow plan 213 depends on.

### 224.8 Verify G6 and G7/G8 by inspection

- Files read only: `.github/workflows/release.yml`, `packages/toolchain/manifest/enkaku-tools.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/src/main.rs`.
- Files changed: none.
- Verifiable result: G6's two greps; `git diff --stat main -- apps/desktop` prints nothing (G8).
- Do not: "improve" `apps/desktop` while looking at it. Reading is not licence to edit a file this plan does not name (plan 200 §2.1).

### 224.9 Measure the backend test suite

- Files changed: none (a measurement step).
- Procedure, run once, sequentially, never concurrently with another test invocation (CLAUDE.md, "Never run two test invocations at once"):
  1. `bun run typecheck` (must be clean first — a red typecheck makes the timing meaningless).
  2. `time bun test` from the repo root, on a quiet machine (nothing else running a build or another test).
  3. Record the wall-clock time (the `real` line) and the pass/fail counts verbatim in this plan's own §11 handoff report.
- Verifiable result: one number, one transcript, committed in §11.
- Do not: run `bun test` more than once "to get a better number," and do not run it alongside `bun run --cwd plugins/* test` or any other invocation. One clean, isolated measurement is what CLAUDE.md's incident report (2026-08-17) says the whole rule exists to avoid re-triggering.

### 224.10 Close the spec markers

- Files changed: `docs/spec.md` (§16, §18 — exact text in §4.9, with `«N»` and the branch filled from step 224.9's measurement).
- Verifiable result: G12 (`rg -n "TBD by plan 224" docs/spec.md` → empty); G7.
- Do not: touch any other section of `docs/spec.md`. §4.9's Agents and §10 Plugins markers are not this plan's to close (§3.6).

### 224.11 Retire or defer the testing rule, per the measured number

Branches on step 224.9's result. Exactly one of the two runs.

**If under 60 s:**

- Files changed: `CLAUDE.md` (replace the "### NEVER run a full test suite..." section, from its heading through the `bun run typecheck is cheap and is the exception` line, with:)

  ```markdown
  ### The backend suite runs in under a minute; run it when a change touches more than one package

  Measured at «N» s on the maintainer's laptop by plan 224 (2026-09-03 baseline: about 170 Studio
  processes and 80s of DOM-toolchain overhead, deleted by plan 201; the backend suite alone is what
  this number measures). `bun test` from the repo root is safe to run directly.

  ```bash
  bun test packages/core/src/plugins/binding.test.ts          # a scoped change: still fine to scope
  bun test                                                     # a change that touches more than one package: run it
  ```

  Still true: never run two test invocations at once (concurrent runs share `packages/sdk/src/cli/.test-fixtures` and report inflated, fictional failure counts — 25 and 43 were observed for a tree that genuinely had 3). `bun run typecheck` is cheap and is run freely, as before.
  ```

- Files changed: `docs/plans/200-mvp-program.md` (§8.2's table — replace with:)

  ```markdown
  ### 8.2 Testing policy after the suite was measured under 60 s (plan 224)

  | Runs during the plan, by the executor | Runs once at the wave gate, by the owner |
  |---|---|
  | `bun run typecheck` (seconds) | every `owner` row in §0 (lab device, owner's farm) |
  | `bun test` from the repo root, or a scoped `bun test <file or dir>` for a single-package change (both under a minute) | the one hardware smoke suite on the lab device (plan 224 §18, once built) |
  | the §10 removal greps for the plan's own rows | `bash scripts/check-plan-status.sh`, `bash scripts/check-dead-code.sh` |
  | the union of every §10 grep in the wave | |
  ```

- Verifiable result: `rg -n "NEVER run a full test suite" CLAUDE.md` → empty; `rg -n "backend suite runs in under a minute" CLAUDE.md` → one line; §11's checklist row G11 records the branch taken.

**If at or over 60 s:**

- Files changed: `CLAUDE.md` (the "This is a hard rule until plan 224 measures..." sentence only, replaced with:)

  ```markdown
  **Measured by plan 224 at «N» s — still over the 60 s target, so this rule stays in force.** «what
  is slow, named from the transcript — e.g. "packages/core/src/jobs and packages/core/src/plugins
  together account for most of it"». The owner runs the full suite manually at wave gates; an agent
  never does.
  ```

- `docs/plans/200-mvp-program.md` §8.2's table and §8.3's closing sentence are **not** edited; the deferral is recorded only in `CLAUDE.md` and in this plan's own §11.
- Verifiable result: `rg -n "Measured by plan 224" CLAUDE.md` → one line naming the real number.

Do not, in either branch: edit `CLAUDE.md`'s testing rule speculatively before step 224.9 has produced a real number. Do not leave both branches half-applied — the plan status check (`scripts/check-plan-status.sh`) has no opinion on this, but a `CLAUDE.md` that names two different suite durations in two places is a defect this step exists to prevent.

### 224.12 The first-run procedure and the owner smoke

- Files changed: none (a documentation step inside this plan's own §7.4, not a code change).
- Verifiable result: the numbered procedure in §7.4 exists and is precise enough for the owner to run without asking a question first.

## 6. Acceptance criteria

1. `packages/core/src/retention/sweeper.ts` exists, exports `createRetentionSweeper`, and implements plan 211's `RunRetentionPolicy`/`RunRetentionSweeper` contract through `createRunRetentionSweeper` in `packages/core/src/jobs/runs/sweeper.ts`.
2. `packages/core/src/maintenance/` no longer exists.
3. A seeded database's `dryRun()` and `sweepOnce()` report identical counts (G2).
4. An orphan job (zero runs, no schedule, no parent workflow job) is deleted; a schedule-owned job's last run survives any age (G3).
5. `GET /api/storage/usage` answers all four kinds from a cache table, with zero filesystem calls on the request path (G4).
6. The retention defaults in `packages/protocol/src/settings.ts` are unchanged by this plan and match MVP 09 §6 (G5) — this plan is a consumer of plan 212's fields, not a second author of them.
7. The release workflow's guest-agent pin step exists (G6), and `apps/desktop/` carries no diff from this plan (G8).
8. `docs/spec.md` §18 states the packaging decision as fact, with no `TBD` (G7).
9. Studio's status bar exposes the doctor checks via a popover on the health dot (G9), and Settings → Storage shows a usage row per kind, both verified by typecheck and the owner smoke.
10. The owner has run the five-minute first-device procedure (§7.4) and timed it (G10).
11. The backend `bun test` duration is measured once and recorded, and exactly one of the two branches in step 224.11 is applied (G11).
12. `docs/spec.md` carries zero `TBD by plan 224` markers (G12), and every other open marker is listed with its owner in §3.6 (G13).
13. `bun run typecheck` is clean (G14).

## 7. Test plan

Scoped commands only — never a bare `bun test` before step 224.9, and only once, in isolation, at that step.

```bash
bun run typecheck

bun test packages/core/src/jobs/runs/sweeper.test.ts
bun test packages/core/src/retention/
bun test packages/core/src/api/storage.test.ts
```

### 7.1 What is deliberately not tested

Per plan 200 §8.3: no `*.test.tsx` for `DoctorPopover.tsx` or `StorageUsageRow.tsx`; no HTTP-route-wiring test beyond `storage.test.ts`'s one file (the route itself is three lines of glue over a table read, not logic). `dryRun`'s parity with `sweepOnce` (G2) is the one place this plan tests wiring-adjacent logic, because a dry run that lies about what it will delete is a data-loss risk, not a copy nit.

### 7.2 Device-dependent tests

None. Nothing in this plan touches a physical device; `ENKAKU_TEST_DEVICE=1` is not referenced.

### 7.3 CI

No workflow file is changed by this plan (§4.9 only touches `docs/spec.md`; §5 step 224.11's `CLAUDE.md`/plan-200 edits are documentation, not CI config). `.github/workflows/ci.yml`'s existing `bun test` step (owner/CI-only per CLAUDE.md) now includes `packages/core/src/retention/` and `packages/core/src/api/storage.test.ts` automatically, since `bunfig.toml`'s `root = "packages"` already scans new files under `packages/core/src`.

### 7.4 Manual smoke — the owner, timed, numbered

Run on a machine with no prior `~/Library/Application Support/Enkaku` (or platform equivalent) and no `ENKAKU_DATA_DIR` set, immediately after this plan's commits land and a release binary is built (`bash scripts/build-release.sh`). Start the stopwatch before step 1.

1. Download the built binary for the platform under test; extract it (`tar xzf` or unzip).
2. Run it: `./enkaku` (macOS: clear quarantine first if needed, per the release notes template in `release.yml`).
3. Open `http://127.0.0.1:7700` in a browser. Confirm the status bar's health dot shows a provisioning state, then click it: the `DoctorPopover` (§4.7) opens and lists the same checks `bun run doctor` prints on the terminal (cross-check by running `bun run doctor` in a separate terminal against the same `ENKAKU_DATA_DIR` and comparing the two reports by eye).
4. Wait for the dot to reach its steady "OK" state (tools provisioned).
5. Go to Devices → the Discovered sheet; plug in a phone with USB debugging enabled; confirm it appears; click Add.
6. Confirm the phone's tile goes live (a decoded frame visible) in the Screens view.
7. Stop the stopwatch. Record the elapsed time in §11's handoff report; it must read under 5 minutes for G10 to be marked done rather than left open.
8. Separately, open Settings → Storage: confirm the four usage rows render with a non-"unknown" value for each (the boot-time `queueMicrotask` computation in §4.1 should have completed well before this point in the procedure).

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| R1: A dependency plan (202, 211, 212, 219, 221) has not actually landed when this plan is executed, so `packages/protocol/src/settings.ts`'s `storage` block or `packages/core/src/jobs/runs/sweeper.ts`'s interface do not exist yet. | Step 224.1 checks this first and stops rather than half-implementing another plan's scope; recorded in §11 under "Open questions hit." |
| R2: `RunStore.deleteRuns`'s real implementation (plan 211, not yet read by this plan's author because the file does not exist on 2026-09-03) diverges from what §3.2's doc-comment quote promises — for example, it might already cascade `job_events`/`artifacts` itself, making this plan's own cascade a double-delete. | §5 step 224.3's test (`it recomputes run_count and latest_run_id after a delete`) is written against the REAL `RunStore` once it exists, not a mock; a double-delete shows up as a changed-row count of zero on the second pass, which a straightforward assertion catches before it reaches the acceptance criteria. |
| R3: The trace-directory byte walk (`dirBytes`, §4.2) grows expensive on a farm with tens of thousands of trace files, even run only once a day. | The 24-hour cadence bounds the cost to one walk per day regardless of farm size; if a future farm finds even that too slow, an incremental write-time counter is the natural follow-up (deliberately not built here — §2's non-goals row states this explicitly, so the scope is not silently expanded). |
| R4: The `jobsAndLogs`/`audit` byte estimates (`ROW_OVERHEAD_BYTES = 96`, §4.2) are visibly wrong on a farm whose rows are unusually large or small. | The estimate is documented in the code and, per §7.4 step 8, visually checked by the owner against a "not obviously wrong" bar rather than an exact one; `artifacts` (the kind most likely to actually fill a disk) uses the real `sizeBytes` sum, not an estimate. |
| R5: The measured `bun test` duration (step 224.9) lands close to the 60 s line and is noisy run to run (CI/laptop variance). | The step calls for exactly one measurement on a quiet machine, matching plan 200 §2.5 ("never predict a result you have not seen"); a borderline number is still a real number, and the branch in step 224.11 is taken from it as measured, not rounded in the rule's favour. |
| R6: `apps/desktop` drifts further out of date while parked, and a later contributor assumes this plan's packaging decision means it should be deleted. | §4.9's spec text says "not built, not wired to CI or the release workflow, not deleted" explicitly, and §2's non-goals row states the same; G8 proves this plan itself made no edit there, so the decision is legible without inference. |

## 9. Open questions

Only things a human must decide. Nothing in §5 blocks on these.

1. **Is the audit log's retention window a visible farm setting or a constant?** Inherited unresolved from plan 212 §9 Q1: this plan ships `AUDIT_RETENTION_DAYS = 90` as a constant (plan 212's own default choice), matching MVP 12 §1's visible list, which does not name it. If a later decision makes it visible, it becomes a fourth `storage.*` field and this plan's sweeper reads it from there instead of the constant — a small, contained change (§4.1's `sweepAudit` gains a `deps.settings.get().storage.auditDays` read in place of the constant import).
2. **Does plan 221's release-workflow pin step actually exist when this plan executes?** §3.5 records that, as of 2026-09-03 (before plan 221 has run), `release.yml` builds and signs the APK but does not yet write the pin. G6 is written to catch a genuine gap here rather than assume it; if it fails, this plan's own execution stops at step 224.1 and the discrepancy is recorded in §11 rather than this plan silently building `pin-guest-agent.ts` a second time.
3. **Should the hardware smoke suite `docs/spec.md` §18 still names as a target ("one hardware smoke suite on the lab device on every merge to `main`") be built by this plan, by plan 223, or by neither in the MVP's actual definition of done?** MVP 09 §5 proposes it; MVP 16 §3's wave 5 acceptance line only names "the numbers in 09, measured, in the README" without naming the suite as a deliverable. This plan's §4.9 spec text keeps it worded as "a target, not yet built" rather than claiming it, and does not build it — a scope call the CEO or CTO should confirm one way or the other before wave 5 closes.
4. **Is a once-daily full trace-tree walk (§4.2) an acceptable permanent design, or does it need the incremental counter R3 names as a possible follow-up?** Not decided here; §2's non-goals row states the scope boundary explicitly so this is a deliberate deferral, not an oversight.

## 10. Removed

`GREP_224`, cited by G15, is:

```bash
rg -n -i -w "lease|leases|cluster|clusters|co-control|assist|heldBy|assistedBy" packages/core/src/retention packages/core/src/api/storage.ts packages/protocol/src/api/storage.ts packages/studio/src/components/shell/DoctorPopover.tsx packages/studio/src/components/settings/StorageUsageRow.tsx
```

It must print nothing.

| What | Where it was | Proof |
|---|---|---|
| `packages/core/src/maintenance/` (the whole directory: `retention.ts`, `retention.test.ts`) | `packages/core/src/maintenance/` | `test ! -d packages/core/src/maintenance` |
| `createRetentionGc`, `RetentionGc` | `packages/core/src/maintenance/retention.ts` (deleted with the file) | `rg -n "createRetentionGc\|RetentionGc" packages/core/src` → empty |
| `sweepCommandRuns` and its doc comment | `packages/core/src/maintenance/retention.ts:106-135` (deleted with the file; already unreachable by this plan's execution time — `commandRuns`/`commandRunMembers` are removed by plan 207) | `rg -n "sweepCommandRuns" packages/core/src` → empty |
| `'retention.gc'` as an `AuditAction` value | `packages/core/src/auth/audit.ts:154` | `rg -n "'retention\.gc'" packages/core/src` → empty |
| `TBD by plan 224` | `docs/spec.md` §16, §18 (×2) | `rg -n "TBD by plan 224" docs/spec.md` → empty |

Nothing from `docs/mvp/13-removal-register.md` Part A or Part B is owned by this plan; the register's rows are all claimed by earlier waves (§0 of that document: "each row names the source document"). This plan's own §10 rows above are new to this plan, not inherited from the register.

## 10.1 Added at the R5 gate, 2026-09-04 — restore or account for five critical-list tests

Plan 211 deleted 53 test files broken by the job/run split, taking net backend coverage from 395 to 353. Five were on plan 200 §8.3's critical list (enumerated in §8.9). Before this plan measures the suite and retires the full-run prohibition, it must, for each of those five, either **restore it against the current schema** or **state in writing why the behaviour is covered elsewhere**. "It was broken by a schema change" is why they were deleted; it is not a reason for the behaviour to stay uncovered.

## 11. Handoff report

- **Checklist**: G1 ✅ G2 ✅ G3 ✅ G4 ✅ G5 ✅ (grep discrepancy, see below — behaviour verified another way) G6 ✅ G7 ✅ G8 ✅ G9 ✅ software (owner smoke step open) G10 ⏳ owner (needs a physical device, not available to this executor) G11 ✅ G12 ✅ G13 ✅ G14 ✅ G15 ✅

- **Commits** (worktree `worktree-agent-af2d233352653619b`, based on `mvp` at `1abb712`):
  - `40d9fc2` feat(mvp-224): add storage_usage table (migration 0072)
  - `729fc7d` feat(mvp-224): implement createRunRetentionSweeper (plan 211's interface)
  - `f7eb825` feat(mvp-224): consolidated retention sweeper, storage usage cache, GET /api/storage/usage; delete maintenance/retention.ts
  - `209b1d4` feat(mvp-224): status bar doctor popover, Settings Storage usage row
  - `7867f6d` docs(mvp-224): close spec's retention/packaging/test-strategy TBD markers; record the measured suite duration
  - `674187f` test(mvp-224): restore two of plan 211's five deleted critical-list tests (actions target/policy dispatch, activity warning throttle)
  - `7ac359c` test(mvp-224): restore schedule-target-backfill.test.ts, plan 211's third deleted critical-list test still live
  - `6f05988` docs(mvp-224): owner-smoke.md — the ordered hardware verification pass for every owner row in plans 201-223

- **Typecheck**: clean — `bun run typecheck` exits 0 across all 20 workspace packages (protocol, ui, adb, toolchain, drivers, scrcpy, sdk, session, harness, core, node, studio, probe-server, networking, proxy-manager, tiktok-automation-pack, mikrotik-routing, google-automation-pack, youtube-automation-pack, examples). `bun run build:studio` also clean (static export, 18 routes).

- **Tests run** (scoped, one invocation at a time, per plan 200 §2.3 — plus the one full-suite measurement step 224.9 explicitly calls for):
  - `bun test packages/core/src/jobs/runs/sweeper.test.ts` → 4 pass, 0 fail
  - `bun test packages/core/src/retention/` → 13 pass, 0 fail (`sweeper.test.ts` 8, `storage-usage.test.ts` 5)
  - `bun test packages/core/src/api/storage.test.ts` → 3 pass, 0 fail
  - `bun test packages/core/src/server/http.test.ts` → 14 pass, 0 fail (unaffected by the new `storageRoutes` field)
  - `bun test packages/core/src/actions/run.test.ts` → 7 pass, 0 fail (restored critical-list test, see below)
  - `bun test packages/core/src/actions/` → 16 pass, 0 fail
  - `bun test packages/core/src/server/ws-handlers-activity.test.ts` → 4 pass, 0 fail (restored critical-list test)
  - `bun test packages/core/src/db/migrations/schedule-target-backfill.test.ts` → 3 pass, 0 fail (restored critical-list test)
  - **Step 224.9's one full-suite measurement** (`time bun test` from the repo root, quiet machine, single invocation): **5274 pass, 1 skip, 10 fail, 20129 expect() calls, across 364 files, real 140.66 s** (`bunfig.toml`'s `root = "packages"` — this does not include `plugins/*` or `examples/`, which run under their own `package.json` `test` script and are not part of "the backend suite" this rule measures). Re-run per package to find what is slow, sequentially, one invocation at a time: `packages/core` 91.19 s (234 files, 2969 pass/1 skip/10 fail), `packages/protocol` 0.20 s (50 files), `packages/adb` 8.85 s (10 files), `packages/drivers` 18.02 s (23 files), `packages/harness` 0.13 s (3 files), `packages/node` 0.04 s (2 files), `packages/scrcpy` 2.15 s (7 files), `packages/sdk` 5.65 s (5 files), `packages/session` 14.53 s (27 files), `packages/toolchain` 0.31 s (3 files). Sum ≈ 141.1 s, consistent with the single full-suite run's 140.66 s (small run-to-run variance). **`packages/core` alone is 65% of the total.** Branch taken (step 224.11): **at or over 60 s — deferred.** `CLAUDE.md`'s rule is rewritten to name the measured number and `packages/core` as the cause; `docs/plans/200-mvp-program.md` §8.2/§8.3 are left untouched per the plan's own instruction for this branch.
  - The 10 failures are **pre-existing and outside this plan's scope**: all ten are in `packages/core/src/jobs/executors/script.test.ts`, all fail on the identical line (`ctx.run.runtimeOverride` read as `undefined`, `packages/core/src/jobs/executors/script.ts:121`), and `git log` shows that file was last touched by `fd13683` ("wip(mvp-211): script/remote executors thread runId, ctx.run; install/pull/push test fixtures") — a plan-211 commit this plan never touches. Per plan 200 §2.1 ("a test your change broke is yours to fix, whatever its path") this is explicitly the inverse case: the change did not happen here, so it is recorded rather than silently fixed. **Flagged for the owner as an open defect** — it is real, it fails every run, and no later round gate exists after this plan to catch it.

- **Removed, proven** (§10):
  - `test ! -d packages/core/src/maintenance` → true (directory removed).
  - `rg -n "createRetentionGc\|RetentionGc" packages/core/src` → empty.
  - `rg -n "sweepCommandRuns" packages/core/src` → empty.
  - `rg -n "'retention\.gc'" packages/core/src` → empty.
  - `rg -n "TBD by plan 224" docs/spec.md` → empty.
  - `GREP_224` (the vocabulary grep) over `packages/core/src/retention packages/core/src/api/storage.ts packages/protocol/src/api/storage.ts packages/studio/src/components/shell/DoctorPopover.tsx packages/studio/src/components/settings/StorageUsageRow.tsx` → empty.

- **Discrepancies between plan and code**:
  1. **§3.3's `traceStore.jobDir(runId)` citation is stale.** By execution time `packages/core/src/jobs/trace/frame-store.ts`'s accessor is already named `runDir(runId)`, not `jobDir` — plan 211 had already renamed it before this plan ran. Used `runDir` throughout; no functional difference, the plan's own comment even predicted this ("renamed to run-keyed by plan 211 §4.10 point 8; the store's own accessor name is unchanged" — the accessor name in fact WAS changed, the plan was wrong about that detail specifically).
  2. **G5's literal grep does not match the real code.** `packages/core/src/config/constants.ts` defines `AUDIT_RETENTION_DAYS` through the shared `num('ENKAKU_AUDIT_RETENTION_DAYS', 90, ...)` helper (`export const AUDIT_RETENTION_DAYS = num('ENKAKU_AUDIT_RETENTION_DAYS', 90, z.number().int().min(1).max(3_650))`), not the bare `AUDIT_RETENTION_DAYS = 90` the plan's grep expects — every constant in that file goes through the same override-capable helper, none is a bare literal. The constant's *value* is 90 and its env override is `ENKAKU_AUDIT_RETENTION_DAYS`, exactly as MVP 09 §6 and plan 212 specify; only the plan's own grep pattern was written against an assumption the file never had. Verified by reading the file directly instead.
  3. **§4.9's proposed spec text for the sweep interval named a nonexistent env var.** The plan's own replacement text for §16 said `ENKAKU_RETENTION_SWEEP_INTERVAL_MINUTES`; `packages/core/src/config.ts`'s `loadConfig()` shows `retention.sweepIntervalMinutes` has no per-field env override at all — only `enkaku.config.json`'s own `retention.sweepIntervalMinutes` key (unlike `heartbeat.*`/`scheduler.*`, which do get `intEnv(...)` treatment). Corrected the committed spec text to say so plainly, per plan 200 §2.2 ("the file wins for facts").
  4. **`dryRun()`'s job-orphan accounting needed a real design decision the plan's own elided code block did not fully specify.** §4.1's `dryRun()` body was explicitly "elided for length," and its sketch (`countRunIdsForJob`, iterating `jobsTouched`) does not by itself account for a job that had ZERO runs from creation (never touched by any run deletion at all) — exactly the scenario G3's own acceptance text names ("a job created with no run at all, via `RunStore.createJob` and no `addRun`"). Implemented `sweepOnce`'s run/job sweep with an explicit final pass over every `jobs` row with `run_count = 0 AND schedule_id IS NULL AND parent_workflow_job_id IS NULL` (catching both "reduced to zero this pass" and "was already zero"), and `dryRun()` mirrors it with the equivalent read-only union. Both are tested directly (`an orphan job with zero runs is swept`).
  5. **§4.5's example route reads `db.select().from(storageUsage).all()` unfiltered and unordered.** Implemented exactly as shown; no discrepancy, but worth recording that the plan never specifies an `orderBy`, and the shipped route relies on there being exactly one row per kind (the primary key) rather than any ordering — `GET /usage`'s test asserts membership, not order, for the same reason.

- **Observed, not done**:
  - **`lucide-react` removal (assigned beyond the plan's own body).** Verified the count fresh at execution time: `grep -rl "from 'lucide-react'" packages/studio/src packages/ui/src` → 44 files, none in the agent subsystem (which plan 220 already migrated). This is unchanged in scope from plan 220's own R7 finding ("49 files... all owned by other plans") — the small difference (44 vs 49) is a recount at a slightly different tree state, not progress made. Migrating 44 files' icon imports with zero Studio tests to catch a wrong icon swap is a dedicated pass of its own (the shape plan 204/220 already were), not something this plan's remaining scope has room for without risking a half-done, harder-to-audit state. `lucide-react` stays in `packages/studio/package.json`. The full remaining-importer list (for whoever picks this up next) is: `app/{recordings,recordings/detail,nodes,plugins/detail,scripts/detail,scripts/editor}/page.tsx`; `components/{DeviceLog,ViewerList,CrashesPanel,ReadinessControl,EnrollmentDialog,TileChips,TagEditor,AskAnAgentDialog,ConnectionBadge}.tsx`; `components/settings/{FarmNetworksEditor,RangeNetworksFields}.tsx`; `components/schema-form/controls/{ArtifactControl,NumberField,TableControl,ListControl,WorkspacePathControl}.tsx`; `components/schema-form/RuntimeOverrideSection.tsx`; `components/monitor/MonitorPane.tsx`; `components/kv/KvPanel.tsx`; `components/workspace/presenters/{download-presenter,image,video}.tsx`; `components/layout/EntityTabs.tsx`; `components/plugin-view/ReactView.tsx`; `components/workflow/{NodeCard,PredicateEditor,WorkflowCanvas,WorkflowBuilder,ParamsEditor}.tsx`; `components/recording/RecordPanel.tsx`; `components/device/{RotationQuickAction,CutoverDialog}.tsx`; `components/terminal/AdbEndpointCard.tsx`; `components/guest-agent/{PendingClearNotice,AgentAlertDetail,NetworkPanel,VpnAgentPrecondition,AgentAlertChip}.tsx`.
  - **Plan 200 §10.1's five deleted critical-list tests**, resolved individually rather than by one blanket action:
    1. `packages/core/src/api/actions.test.ts` (plan 207's 29 tests, all verbs + policy) — **restored** as `packages/core/src/actions/run.test.ts`, against the real code as it exists today: `api/actions.ts` is now a thin 45-line JSON/auth wrapper, and every rule the deleted test protected (target resolution, offline skip/allow, the activity-policy warn/forbid/force path, one result per device) lives in `actions/run.ts`'s `runAction`, which is what the new file exercises directly (7 tests: skip-vs-allow-offline, a vanished device, warn-then-force, forbid-even-with-force, no-conflict dispatch, and mixed per-device results in one operation).
    2. `packages/core/src/server/ws-handlers-activity.test.ts` (the `device.activity.warning` throttle) — **restored** at the same path, against the real `createWsMessageHandler`'s `admit()`/`warnOnce()` gate, driven through `input.tap` with no session wired (the gate fires and the throttle is provable before the message fails later for lack of a session). 4 tests: one warning per minute per connection, a fresh warning after the 60 s window (`Date.now()` monkey-patched forward — `warnOnce` has no injectable clock), no warning when nothing conflicts, and no forbid path reachable through a bare `job` conflict.
    3. `packages/core/src/plugins/runtime.test.ts` (the stage → verify → activate pipeline) — **not restored; covered elsewhere, verified by reading the real files.** `createPluginRuntime`'s `stage`/`verify`/`activate` sequence is exercised as the setup path of `runtime-service.test.ts`, `runtime-host.test.ts`, `runtime-host-reset.test.ts`, `service-routes.test.ts`, `webhook-service.test.ts`, and `auto-rebuild.test.ts` (all import and call the real function, not a mock), and the failure branch specifically — a broken bundle staged, verified, and landing on `status: 'failed'` — is asserted directly in `surface-registry.test.ts:157-160`. This is real, current coverage of the exact contract the deleted file protected; a new `runtime.test.ts` would duplicate it.
    4. `packages/core/src/db/migrations/artifacts-device-scope.test.ts` — **does not come back; its subject was genuinely removed.** The migration file `artifacts-device-scope.ts` itself no longer exists anywhere in the tree (only the `docs/plans/211-mvp-jobs-and-runs.md` and `200-mvp-program.md` citations of the deleted test remain) — plan 211's own `jobs-to-runs.ts` migration superseded it by re-keying `artifacts.jobId` → `artifacts.runId` directly, and that migration's own test (`jobs-to-runs.test.ts:78`) asserts the re-keyed artifact row. Writing a test for a deleted file's deleted subject would be a hollow replacement.
    5. `packages/core/src/db/migrations/schedule-target-backfill.test.ts` — **restored.** The migration (`schedule-target-backfill.ts`) is still live and still called from `daemon.ts` on every boot; only its test had been deleted. 3 tests: the no-op-conversion report against pre-existing schedules, the marker guard preventing a second run, and the empty-database case.

- **Open questions hit**: none blocked a step. Plan 200 §2.1 was followed for step 224.1's precondition check: all four dependencies (`docs/spec.md`'s skeleton, `packages/protocol/src/settings.ts`'s `storage` block, `packages/core/src/jobs/runs/sweeper.ts`, `.github/workflows/release.yml`'s `pin-guest-agent` step) were already landed, so no step was blocked or skipped for a missing dependency. The plan's own §9 open questions (audit retention visibility, the release-pin gap, the hardware smoke suite's owner, the once-daily trace walk) were not decided here, as instructed — they are restated, not resolved.

- **Processes**: `ps -Ao pid=,command= | grep -i "[o]penpf"` → no output (nothing left running beyond this shell).
