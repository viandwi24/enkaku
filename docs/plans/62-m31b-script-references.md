# Plan 62 — M31b : Script References, and a `@latest` That Cannot Drift

> Status: implemented — `ScriptRefSchema`/`parseScriptRef`/`compareSemver`/`isPrereleaseVersion` in `@enkaku/protocol` (`script-ref.ts`, hand-written semver, no dependency), `resolveScriptRef` in `packages/core/src/scripts/resolve.ts` with its four coded errors, `schedules.script_id` renamed to `schedules.script_ref` via a hand-written `RENAME COLUMN` migration (`drizzle/0024_rename_schedules_script_ref.sql`, drizzle-kit's rename-detection prompt needs a TTY this environment does not have — same workaround plan 61 used), backfilled to each schedule's exact **pinned** version (never `@latest`) by `db/migrations/backfill-schedule-refs.ts`, guarded by a `migration_markers` row exactly like plan 22.0's cluster migration. `POST /api/jobs` accepts `scriptId` XOR `scriptRef`; `GET /api/scripts?group=name` and `GET /api/scripts/:name/versions` back the grouped list and the detail/schedule version selectors; `schedules/runner.ts` resolves once per firing before building the batch and records a `schedule.failed` audit entry (plus `scheduleRuns.outcome: 'error'`) naming the code when a reference cannot resolve. Studio: the scripts list is grouped one-row-per-name, the detail page gained a version selector, and `ScheduleEditorDialog` gained a name+version picker with a `@latest` toggle and a live "→ resolves to X today" line. **Deviations from this document, recorded rather than silent:** `job-service.ts` was left untouched — `scriptRef` resolution lives in the `api/jobs.ts` route layer instead, so `JobService.enqueue` still only ever sees a concrete `scriptId`; `protocol/messages/job.ts` was not touched either (jobs keep `scriptId` only, on the wire and over `/ws` — only the REST body gained the `scriptRef` alternative); `RunScriptDialog.tsx` needed **no changes** — it already grouped by name, defaulted to the newest version, and stored the concrete id before this plan.
> Ships: packages/core/src/scripts/resolve.ts
> Depends on: nothing. Independent of the agent series; ships value on its own and can land in any order relative to Plan 61.
> Spec references: §12 (scripts and jobs), §11.4 (published bundles).

---

## 1. Goals

- A script is referred to by **`name@version`**, and `@latest` is a valid version that resolves to the highest published semver.
- A **schedule stores the reference**; a **job stores the resolution**. A schedule written as `checkout@latest` picks up new versions; the job it created still records exactly which version ran.
- The scripts list shows **one row per script**, not one row per version. Versions live behind a selector on the detail page and in the run dialog.
- One firing of a schedule resolves `@latest` **once**, so a batch never straddles two versions.

## 2. Non-goals

- Mutable tags in general (`@stable`, `@beta`, user-defined). `@latest` is the only alias, and it is computed, not stored. If a second alias is ever wanted it is a separate plan with a separate table.
- Changing how scripts are published, bundled, or validated. `POST /api/scripts` keeps its body and its `409`.
- Deleting or garbage-collecting old versions.
- Rolling back a running job.

## 3. Context and design decisions

### 3.1 Three things are already right, and they make this cheap

Reading `packages/core/src/scripts/routes.ts` before designing anything:

- **Versions are already semver.** `routes.ts:13` — `z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/)`. So they sort properly; no format migration, no guessing.
- **Versions are already immutable.** `routes.ts:118-121` rejects a duplicate `(name, version)` with `409 script_version_exists`, backed by `uniqueIndex('idx_scripts_name_version')`. This is the thing Docker famously does *not* guarantee, and it is the reason a pinned reference here actually means something.
- **`name@version` is already the house notation.** `routes.ts:121` formats the conflict as `` `${name}@${version}` ``. So the reference syntax is not a new invention, it is the one already in the error messages.

The work is therefore additive: a resolver, a reference column on schedules, and two UI changes. No schema rewrite.

### 3.2 `latest` is computed, never stored

In a Docker registry, `latest` is an ordinary tag that somebody pushed. That is why `nginx:latest` has, more than once, been older than the actual latest release — the tag is a mutable pointer with no relationship to version order. It is a design mistake, not a feature, and copying it would import the bug.

Here, `latest` is never a row. It is resolved at query time as:

> the **highest semver** among that script's `enabled` versions, **excluding prereleases**.

Two consequences worth stating explicitly because both have bitten real systems:

- **Semver order, not publish order.** Publish `2.0.0`, then hotfix `1.9.9` onto the old line. Publish order says `1.9.9` is latest; that is wrong and would silently downgrade every schedule. The regex at `routes.ts:13` guarantees we can compare properly, so we do.
- **Prereleases are excluded.** `1.0.0-beta.1` is never `@latest`, matching npm. Someone publishing a beta must not silently take over every schedule in the farm. A prerelease is still runnable — by naming it exactly.

If a script has **only** prereleases, `@latest` does not resolve and the caller gets `script_ref_unresolved` naming the versions that do exist. It does not silently fall through to a prerelease.

### 3.3 The reference lives on the schedule; the resolution lives on the job

This is the whole design, and it maps cleanly onto what the tables already hold.

| Table | Column | Holds | Changes? |
|---|---|---|---|
| `jobs` | `scriptId` | the concrete `scripts.id` row that ran | **no change** — already exactly this |
| `schedules` | `scriptId` → `scriptRef` | `"checkout@latest"` or `"checkout@1.0.1"` | migrated |

`jobs.scriptId` (`schema.ts:215`) already stores a concrete version's primary key. So the reproducibility half is already true today and needs no work: every job in the database can already be traced to the exact bundle it ran. Nothing about that is loosened here — a reference is resolved *before* a job row is written, never after.

`schedules.scriptId` (`schema.ts:492`), by contrast, pins a version **forever and invisibly**. A schedule created today keeps running `1.0.1` after `2.0.0` is published; you fix a bug and the nightly run keeps executing the bug, with nothing in the UI to suggest anything is stale. That is the defect this plan exists to fix, and `@latest` fixes it by making the intent visible in the value itself.

### 3.4 Resolve once per firing, not once per job

A schedule can target a cluster of twenty devices and produce twenty jobs through Plan 20's batch dispatcher. If `@latest` were resolved per job, a publish landing mid-dispatch would give twelve devices `1.0.1` and eight devices `2.0.0` — a split-brain batch, and a genuinely miserable thing to diagnose because every individual job looks correct.

So: `@latest` resolves **once, at the moment the schedule fires**, and the resolved `scripts.id` is written to all jobs in that batch. The batch is the unit of consistency.

### 3.5 The scripts list is a list of scripts

`packages/studio/src/app/scripts/page.tsx` renders the `scripts` table directly, which is one row per version — so a script published fifteen times occupies fifteen rows and pushes everything else off the screen. Grouping by `name` is a query and presentation change only; the storage is already correct.

Three surfaces follow from it:

- **List** — one row per name: latest version, version count, last published, enabled state.
- **Detail** — a version selector, defaulting to latest, that switches the source view, the params schema, and the run button.
- **Run dialog** — pick script, then version. The selector defaults to latest but **stores the concrete version**, because a manual run is a one-off and reproducibility beats freshness. `@latest` is for standing intent, which is what a schedule is.

## 4. Technical design

### 4.1 The reference type — `packages/protocol/src/script-ref.ts`

```ts
/** `name@version`, where version is a semver or the literal `latest`. */
export const ScriptRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*@(?:latest|\d+\.\d+\.\d+(?:[-+].+)?)$/)
export type ScriptRef = z.infer<typeof ScriptRefSchema>

export function parseScriptRef(ref: ScriptRef): { name: string; version: string | 'latest' }
```

Declared in `@enkaku/protocol` because core, the SDK, Studio, and (from Plan 63) the capability registry all need the same one.

### 4.2 The resolver — `packages/core/src/scripts/resolve.ts`

```ts
/**
 * Resolves a reference to a concrete `scripts.id`.
 *
 * `@latest` is the highest semver among ENABLED, NON-PRERELEASE versions
 * (plan 62 §3.2) — deliberately not the most recently published, because a
 * hotfix onto an old line publishes later while sorting lower.
 */
export function resolveScriptRef(db: Db, ref: ScriptRef): ScriptRow  // throws EnkakuError
```

Errors, all distinguishable because "it did not run" is not an adequate answer:

| Code | When |
|---|---|
| `script_not_found` | no script by that name |
| `script_version_not_found` | the name exists, that exact version does not — the message lists the versions that do |
| `script_ref_unresolved` | `@latest` on a script with only prereleases or only disabled versions |
| `script_disabled` | the resolved version exists but `enabled = false` |

Semver comparison is written here, not pulled in as a dependency: the regex admits exactly four shapes and the comparison is about fifteen lines. Adding a package to the core's dependency tree to compare three integers is not a trade worth making.

### 4.3 Storage

```
ALTER TABLE schedules RENAME COLUMN script_id TO script_ref;
```

Backfill: every existing row holds a concrete `scripts.id`; convert each to `"<name>@<version>"` by joining `scripts`. **Existing schedules stay pinned** — they are not silently converted to `@latest`. Changing the behaviour of a schedule somebody already trusts, as a side effect of a migration, would be exactly the kind of invisible change this plan is trying to eliminate. Anyone who wants floating behaviour edits the schedule and sees themselves do it.

A one-shot marker in `migration_markers` guards the backfill, matching Plan 22.0 §4.1.

`jobs` is untouched.

### 4.4 API

- `POST /api/jobs` accepts **either** `scriptId` (concrete, unchanged) **or** `scriptRef`. Exactly one; both is a `400`. The reference is resolved before the job row is written, so the stored `scriptId` is always concrete.
- `GET /api/scripts` gains `?group=name`, returning one entry per script with `{ name, latestVersion, versionCount, lastPublishedAt, enabled }`. The ungrouped form stays for anything that wants raw versions.
- `GET /api/scripts/:name/versions` — the version list for the detail selector.
- `POST /api/schedules` takes `scriptRef`. The response echoes both the reference and what it resolves to **right now**, so the UI can show "→ 2.0.0" without a second call.

### 4.5 Schedule firing

In the scheduler (Plan 21), one resolution per firing, before the batch is built (§3.4). A resolution failure is a **schedule-level** failure: it records a `schedule.failed` event naming the code and does not enqueue a partial batch. Half a batch is worse than none, because half a batch looks like it worked.

### 4.6 Studio

- `app/scripts/page.tsx` — grouped list; the version count is a link into the detail.
- `app/scripts/detail/page.tsx` — version selector, defaulting to latest, driving the source view and params schema.
- `RunScriptDialog.tsx` — script picker, then version selector (default latest, stores concrete).
- Schedule editor — a reference field with a `latest` toggle, and a live "→ resolves to 2.0.0 today" line beneath it so the consequence of the toggle is visible before saving.
- The schedules list shows the raw reference (`checkout@latest`), which is self-documenting and removes the need for a staleness badge entirely.

## 5. Implementation steps

**62.1 — `ScriptRefSchema` and `parseScriptRef`** in `@enkaku/protocol` (§4.1), with the semver comparison and its tests. Pure functions, no I/O — write these first and completely, because everything else trusts them.

**62.2 — `resolveScriptRef`** (§4.2) and its four error codes.

**62.3 — Migration** (§4.3): rename, backfill pinned, marker guard.

**62.4 — API** (§4.4).

**62.5 — Scheduler** (§4.5): resolve once per firing.

**62.6 — Studio scripts list and detail** (§4.6).

**62.7 — Run dialog and schedule editor** (§4.6).

## 6. Acceptance criteria

1. `checkout@1.0.1` resolves to that exact version; `checkout@latest` resolves to the highest non-prerelease enabled semver.
2. With `1.9.9` published **after** `2.0.0`, `@latest` resolves to `2.0.0`.
3. With `2.0.0-beta.1` the highest version published, `@latest` resolves to `1.9.9`; naming the prerelease exactly still runs it.
4. A script with only prereleases fails `@latest` with `script_ref_unresolved` listing the versions that exist — it does not fall back to a prerelease.
5. A job row always stores a concrete `scripts.id`, whichever form the request used.
6. A schedule stores its reference verbatim; the schedules list displays it.
7. A schedule on `@latest` runs the new version on its next firing after a publish, with no edit.
8. A batch of twenty devices from one firing runs **one** version, even if a publish lands mid-dispatch.
9. Schedules that existed before the migration are **pinned to the version they were pinned to**, not converted to `@latest`.
10. The scripts list shows one row per name with a version count; the detail page's selector defaults to latest.
11. The run dialog defaults to latest and stores the concrete version it showed.
12. A schedule whose reference cannot resolve enqueues **nothing** and records a `schedule.failed` event naming the code.
13. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit — `parseScriptRef` / semver comparison:** valid and invalid reference shapes; `1.0.10 > 1.0.9` (string comparison gets this wrong, which is why it is a named case); `1.0.0 > 1.0.0-beta`; build metadata (`+build`) ignored in ordering.

**Unit — `resolveScriptRef`:** each of the four errors; §6.2, §6.3, §6.4 exactly; a disabled latest version falling through to the highest enabled one.

**Integration:** enqueue by reference → the job row holds a concrete id. A firing resolves once — assert by publishing between the resolve and the dispatch in a test and checking all jobs in the batch share a `scriptId`.

**Migration:** a database with three schedules on three versions → three pinned references, all correct, marker written; running it twice changes nothing.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# publish v1.0.0 and v1.0.1 of one script
# 1. scripts list shows ONE row, "2 versions", latest 1.0.1
# 2. detail → selector switches source between the two
# 3. schedule on name@latest → fires 1.0.1
# 4. publish 1.0.2, wait for the next firing → runs 1.0.2 with no edit
# 5. open the job → it names 1.0.2 exactly, not "latest"
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Someone publishes a broken version and every `@latest` schedule breaks at once. | That is the accepted cost of asking for `@latest`, and it is now *visible* in the schedule's value rather than hidden. Pinning stays one edit away, existing schedules are pinned by default (§4.3), and Plan 36's retry classification still applies to the resulting failures. |
| Semver comparison written by hand is wrong in a corner. | It is the first step (62.1), pure, and tested against the specific traps — `1.0.10` vs `1.0.9`, prerelease ordering, build metadata. Fifteen lines fully covered beats a dependency partially understood. |
| The backfill silently converts schedules to `@latest` and changes what runs tonight. | §4.3 and criterion 9 make pinning the migration's explicit behaviour, and the marker makes it idempotent. |
| Grouping the list hides an old version somebody needs. | Nothing is deleted; the count is a link, and the ungrouped API form remains. |

## 9. Open questions

1. Should `@latest` respect a per-script "channel" so a team can pin a whole cluster to a line (`1.x`)? Range references (`checkout@^1.0.0`) are the natural extension and are deliberately out of scope — the regex would accept them with one edit if it is ever wanted.
2. Should the schedules list flag a pinned schedule when a newer version exists? It was the original proposal; `@latest` makes it unnecessary for floating schedules, but a *deliberately* pinned one might still want the hint. Deferred until someone asks.
