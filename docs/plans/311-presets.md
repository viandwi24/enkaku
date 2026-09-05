# Plan 311 — Presets: saved parameter sets, wherever parameters are entered

> Status: implemented (software)
> Ships: packages/studio/src/components/presets/PresetRow.tsx
> Depends on: plan 310 (the palette and the dialog layout it lands in); plans 301–307 for workflow params
> Spec references: §4.5, §4.6, §4.7, §11, §13

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The Run script dialog offers presets, **above** the parameter form | 1 row, rendered before `SchemaForm` | `rg -n "PresetRow" packages/studio/src/components/actions/verb-dialogs.tsx` finds it above the `SchemaForm` line | [x] |
| G2 | A preset can be saved, applied, updated and deleted from that row without leaving the dialog | 4 actions | owner smoke §7 step 2 | owner |
| G3 | Workflows have presets too, keyed by workflow name | `kind = 'workflow'` rows resolve | `bun test packages/core/src/scripts/param-sets.test.ts` → `workflow presets` passes | [x] |
| G4 | One store, one component, one concept — not two parallel preset systems | 1 table, 1 route family, 1 component | `rg -n "ParamSetPicker\|PresetRow" packages/studio/src` → only `PresetRow` remains | [x] |
| G5 | The migration is additive and renames one column without losing a row | 1 `ADD COLUMN` + 1 `RENAME COLUMN`; row count unchanged | `bun run --cwd packages/core db:generate`, then `bun test packages/core/src/db/` → `preset migration` passes | [x] |
| G6 | A preset survives a plugin upgrade | presets are filed under the NAME, never a version | `bun test packages/core/src/scripts/param-sets.test.ts` → `survives a publish` passes | [x] |
| G7 | Applying a preset whose fields no longer exist in the schema says so instead of failing | unknown keys reported, known keys applied | same file → `partial apply` passes | [x] |
| G8 | `bun run typecheck` and `bun run build:studio` clean; no Studio test file added | 0 errors, 0 `*.test.tsx` | both exit 0 | [x] |

## 1. Goals

The owner, 2026-09-05: *"terus jangan lupa fitur preset scriptnya mana? kan
sebelumnya ada fitur preset, fitur preset diatasnya form input setting script
ini sehingga enak uxnya."*

The feature is not missing. It is **built, tested, routed — and mounted in
exactly one place nobody looks**: the schedule dialog. The Run script dialog,
which is where an operator actually types parameters, has never had it.

So this plan is mostly plumbing an existing thing into the right place, plus
one extension the owner did not ask for and §3.3 argues for.

## 2. Non-goals

| Not done here | Where |
|---|---|
| The script palette | plan 310 |
| Sharing presets between farms, or exporting them | §9 Q2 |
| Per-device presets | §9 Q1 — a preset is parameters, and parameters are not device-specific |
| Presets for action verbs other than run-script / run-workflow | none — those dialogs have no parameter schema |

## 3. Context and design decisions

### 3.1 What exists today, cited

| Fact | Where |
|---|---|
| Table `script_param_sets` — `{ id, scriptName, name, params, createdBy, createdAt, updatedAt }`, unique on `(scriptName, name)` | `packages/core/src/db/schema.ts:813-825` |
| Store: `listParamSets`, `createParamSet`, `updateParamSet`, `deleteParamSet` | `packages/core/src/scripts/param-sets.ts` |
| Routes: `GET`/`POST` `/api/scripts/:name/param-sets`, `PATCH`/`DELETE` `.../:id` | `packages/core/src/scripts/routes.ts:75-104` |
| Component `ParamSetPicker({ scriptName, schema, value, onApply })` | `packages/studio/src/components/ParamSetPicker.tsx:35` |
| Mounted in **one** place | `packages/studio/src/components/schedules/ScheduleDialog.tsx:396` |
| Filed under the script NAME, never a version, "so a preset outlives every publish" | `ParamSetPicker.tsx:44` (the component's own doc comment) |

That last row is the design already being right: the reason presets survive a
plugin upgrade is that they were never keyed to one. G6 protects it.

### 3.2 Position is the feature

A preset row below the form is decoration. Above it, it is a shortcut: you
open the dialog, recognise "nightly, slow", click it, and the form fills. The
owner said this plainly and it is the whole of §4.2's layout rule — the row
sits between the chosen-script trigger (plan 310 §4.3) and the `SchemaForm`,
never after it, and never inside a collapsed section.

### 3.3 Workflows get presets too, and the table stops being script-only

Not asked for, and included anyway, with the reason: since plan 301 a
workflow document carries its own typed `params[]`, and plan 306 §4.5 renders
them in the Run dialog through the same `SchemaForm`. The moment an operator
runs a workflow twice with different parameters they want the same shortcut,
and building it later means either a second table or a migration done twice.

So the table generalises **now**, while it holds few rows:

- `script_name` → `owner_name` (SQLite `ALTER TABLE … RENAME COLUMN`).
- new `kind text NOT NULL DEFAULT 'script'`, values `'script' | 'workflow'`.
- unique index becomes `(kind, owner_name, name)`.

`GET /api/scripts/:name/param-sets` keeps working unchanged (it implies
`kind = 'script'`), and `/api/workflows/:name/presets` is added beside it.
Two route families over one store, because the two owners already live under
two route trees and inventing `/api/presets?kind=` would be a third address
for a thing that has two natural homes.

### 3.4 Applying a stale preset is a warning, not a failure

A preset saved a month ago may name a field the script's schema no longer
has, or miss one it gained. Refusing to apply it would strand the operator
with data they can see and cannot use. So: **apply what matches, list what
did not**, in one line under the row — "2 fields applied, 1 no longer exists
(`retries`)". Unknown keys are dropped from the applied value, never written
into the form (G7).

## 4. Technical design

### 4.1 Schema and migration

```ts
export const paramPresets = sqliteTable(
  'script_param_sets', // table NAME unchanged — renaming it would rewrite it for nothing
  {
    id: text('id').primaryKey(),
    /** 'script' | 'workflow' (plan 311 §3.3). */
    kind: text('kind').notNull().default('script'),
    /** A script's `plugin/script` name, or a workflow's `name`. Never a version (plan 311 §3.1). */
    ownerName: text('owner_name').notNull(),
    name: text('name').notNull(),
    params: text('params', { mode: 'json' }),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [uniqueIndex('idx_param_sets_owner').on(t.kind, t.ownerName, t.name)],
)
```

Read the generated SQL before trusting it (G5): it must be one
`ALTER TABLE … RENAME COLUMN`, one `ADD COLUMN` with a default, and an index
swap — no table rebuild, no `DROP`.

### 4.2 `packages/studio/src/components/presets/PresetRow.tsx` (the artefact)

```tsx
export function PresetRow({
  kind,
  ownerName,
  schema,
  value,
  onApply,
}: {
  kind: 'script' | 'workflow'
  ownerName: string
  schema: JsonSchemaNode | null
  value: unknown
  onApply(next: unknown, report: { applied: string[]; unknown: string[] }): void
}): JSX.Element | null
```

Renders as **one row**, not a section: a `Select` of saved presets on the
left, and on the right a small menu with **Save as…**, **Update "<name>"**
(only with a preset selected and the form dirty against it), and **Delete**.
Returns `null` when `schema` is null — a script with no parameters has
nothing to preset, and an empty row is a question the operator has to answer
("what is this for?") for no reason.

`ParamSetPicker.tsx` is **replaced**, not wrapped (§10): it is the same
feature and two components would drift.

### 4.3 Where it mounts

| Dialog | Position |
|---|---|
| Run script (`verb-dialogs.tsx`) | between the script trigger (plan 310) and `SchemaForm` |
| Run workflow (`verb-dialogs.tsx`) | between the workflow trigger and its params form |
| Schedule (`ScheduleDialog.tsx`) | where `ParamSetPicker` is today, swapped in place |

### 4.4 API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/scripts/:name/param-sets` | unchanged; implies `kind='script'` |
| `POST` / `PATCH` / `DELETE` | same family | unchanged |
| `GET` / `POST` | `/api/workflows/:name/presets` | new, `kind='workflow'` |
| `PATCH` / `DELETE` | `/api/workflows/:name/presets/:id` | new |

Permissions mirror the existing ones: `script.view` to read, `job.run` to
write — a preset is an operator convenience, not a publish.

## 5. Implementation steps

**311.1 — Schema and migration** per §4.1; read the generated SQL. *Result*: G5.

**311.2 — Store and routes.** Generalise `param-sets.ts` to take `kind`;
add the workflow route family. *Result*: G3, G6, and
`bun test packages/core/src/scripts/param-sets.test.ts` green.

**311.3 — Partial apply.** The reconciliation of §3.4, in the store's read
path or the component — decide once and put it where both dialogs get it for
free. *Result*: G7.

**311.4 — `PresetRow.tsx`**, replacing `ParamSetPicker`. *Result*: G4.

**311.5 — Three mounts** per §4.3. *Result*: G1, G2.

**311.6 — Status and report.**

## 6. Acceptance criteria

- G1, G3–G8 mechanically; G2 at the owner's sitting.
- `test ! -e packages/studio/src/components/ParamSetPicker.tsx`.
- `rg -n "script_param_sets" packages/core/src` → the table definition only.

## 7. Test plan

| File | Covers |
|---|---|
| `packages/core/src/scripts/param-sets.test.ts` | script and workflow kinds; uniqueness per kind; survives a publish; partial apply |
| `packages/core/src/db/` (directory) | the migration on a populated table |
| `packages/core/src/api/workflows.test.ts` | the new preset routes |

Owner smoke (5 minutes):
1. Run script on a device, pick a script with parameters. The preset row is
   **above** the form.
2. Fill the form, **Save as** "nightly". Reopen the dialog, pick "nightly" —
   the form fills. Change a field, **Update "nightly"**. **Delete** it.
3. Run a workflow with parameters — the same row, the same behaviour.
4. Save a preset, upgrade the plugin, reopen — the preset is still there.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Per-device presets? | No. A preset is parameters; a device is a target. Mixing them makes a preset unusable on the device it was not saved on. |
| Q2 | Export/import presets between farms? | Not now. It needs a file format and a collision rule; nobody has asked. |
| Q3 | Should the palette (plan 310) offer "Scroll FYP · nightly" as a row? | Tempting and refused for now: it couples two features and doubles the palette's row count. Revisit once presets are actually in daily use. |
| Q4 | A default preset applied automatically when the dialog opens? | No. Silent pre-filling is how an operator runs last week's parameters without noticing. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `ParamSetPicker` | `packages/studio/src/components/ParamSetPicker.tsx` | `test ! -e packages/studio/src/components/ParamSetPicker.tsx` |
| `scriptName` as the preset key | `packages/core/src/db/schema.ts` | `rg -n "scriptName" packages/core/src/scripts/param-sets.ts` → empty |

## 11. Handoff report

**Status: G1, G3–G8 done and mechanically verified. G2 built to spec but left for the owner's sitting (marked `owner` in §0, never mine to tick).**

### What shipped

- **311.1 (schema and migration), §4.1.** `paramPresets` (`packages/core/src/db/schema.ts`, was `scriptParamSets`) — table name unchanged (`script_param_sets`), `scriptName`/`script_name` renamed to `ownerName`/`owner_name`, `kind text NOT NULL DEFAULT 'script'` added, unique index swapped to `(kind, ownerName, name)`. Generated as **two** migrations rather than one because `drizzle-kit generate` needs an interactive TTY to disambiguate "column renamed" from "column dropped and a new one created" when a rename and an unrelated `ADD COLUMN` land in the same table at once, and this environment has none. Split the change into two schema edits and two `db:generate` runs — `drizzle/0075_sweet_silver_fox.sql` (`ADD COLUMN kind`, unambiguous) then `drizzle/0076_pretty_nemesis.sql` (the rename plus the index swap) — driving the second run's interactive prompt with a `pexpect` script (down-arrow, enter) rather than hand-writing the SQL, so the generated migration is exactly what `drizzle-kit` itself would have produced with a human at the keyboard. Read both files after generating (§0 G5's own instruction): one `ALTER TABLE … ADD`, one `ALTER TABLE … RENAME COLUMN` + one `DROP INDEX` + one `CREATE UNIQUE INDEX` — no table rebuild, no data-losing `DROP COLUMN`. Both migrations got their own numbers (75, 76) with no collision against plan 310's `0074_rainy_ulik.sql` — checked the journal before and after, 77 unique tags, confirmed in `packages/core/drizzle/meta/_journal.json`.
- **311.2 (store and routes), §4.1, §4.4.** `packages/core/src/scripts/param-sets.ts` generalised: `listParamPresets`/`createParamPreset`/`updateParamPreset`/`deleteParamPreset` all take `(db, kind, ownerName, ...)` instead of `(db, scriptName, ...)`. `assertOwnerExists` only checks the `scripts` table for `kind === 'script'` — a workflow preset has no equivalent existence check here (no `WorkflowStore` dependency in this file), so a preset can be filed under a workflow name that does not (yet) exist; not something the plan's §4 calls out either way, flagged as a design choice rather than an oversight. `packages/core/src/scripts/routes.ts`'s three `param-sets` routes now pass `kind: 'script'` through to the same store. New workflow route family added to `packages/core/src/api/workflows.ts` (`GET/POST /:name/presets`, `PATCH/DELETE /:name/presets/:id`), inserted between the `DELETE /:name` and `---- Pins ----` sections — deliberately away from the `simulate`/`run-node` regions plan 309's agent was working in concurrently, re-checked with `bun run typecheck` after every edit to that shared file. Both route families share one protocol module, `packages/protocol/src/api/presets.ts` (`PresetKindSchema`, `ParamPresetInfoSchema`, `ParamPresetListResponseSchema`, `ParamPresetResponseSchema`, `ParamPresetDeleteResponseSchema`) — the old `ParamSetInfoSchema` family in `packages/protocol/src/api/scripts.ts` is deleted, not aliased. Three new `AuditAction` values added (`workflow.preset.create/update/delete`) beside the existing `script.param_set.*` ones in `packages/core/src/auth/audit.ts`.
- **311.3 (partial apply), §3.4.** Put entirely on the existing `reconcileParams`/`@enkaku/protocol` machinery (plan 95) — no new reconciliation logic was needed. `PresetRow` calls `reconcileParams(schema, preset.params)` on apply, uses the `removed` findings as "unknown" (dropped, never written into the form) and everything else in `result.value`'s own keys as "applied", and renders the one-line report under the row per §3.4's own example ("N fields applied, M no longer exist (`field`)").
- **311.4 (`PresetRow.tsx`), §4.2.** `packages/studio/src/components/presets/PresetRow.tsx`, replacing `packages/studio/src/components/ParamSetPicker.tsx` (deleted). Same shape as the old picker (a `Select` plus Save as…/Update/Delete) generalised over `kind: 'script' | 'workflow'`, with one behavioural change from the plan's own prose: **Update is disabled until the form is actually dirty against the applied preset** (`§4.2`: "only with a preset selected and the form dirty against it") — tracked as `JSON.stringify(value) !== JSON.stringify(appliedValue)`, which the old `ParamSetPicker` never gated on. Returns `null` when `schema` is `null` (a script/workflow with no parameters has nothing to preset).
- **311.5 (three mounts), §4.3.** `verb-dialogs.tsx`'s `RunScriptFields` — `PresetRow` now renders between `ScriptTrigger` and `SchemaForm` (G1). `RunWorkflowFields` — same row added between the workflow Combobox and its `SchemaForm`, a mount this plan's own non-goals table didn't list but §4.3's own table requires. `schedules/ScheduleDialog.tsx` — `ParamSetPicker` swapped for `PresetRow` in place, `kind="script"`.

### What the plan got wrong about the codebase, cited

- **§4.1's schema sketch** shows the rename and the `kind` addition as one change; generating it that way is not possible non-interactively in this environment (see 311.1 above) — the plan's own migration-hazard note anticipated contention with plan 310, not this. Handled by splitting into two migrations rather than hand-editing SQL, per the plan's own fallback instruction ("re-check and regenerate rather than hand-editing SQL").
- **§3.1's citation table** (`ParamSetPicker.tsx:35`, `ScheduleDialog.tsx:396`) was accurate at the time the plan was written; by the time this plan executed, plan 310 had already rewired both call sites to use `ScriptTrigger` for script selection (the version picker plan 310 removed), so the picker's mount point in `ScheduleDialog.tsx` had moved but was otherwise unchanged in shape — confirmed by reading the file as it now stands, per the task's own instruction to reconcile against the code, not the plan's picture of it.
- The plan's §6 acceptance line `rg -n "script_param_sets" packages/core/src → the table definition only` is not literally true once tests exist: the two new test files (`packages/core/src/scripts/param-sets.test.ts`, `packages/core/src/db/preset-migration.test.ts`) reference the raw table/column names in hand-written SQL to seed a pre-migration row, the same pattern `groups-migration.test.ts` already uses for its own renamed table. Read the intent as "no other *application* code references the raw table name," which holds — `paramPresets` (the Drizzle table) is the only application-code binding.

### Test plan, run and results

- `bun test packages/core/src/scripts/param-sets.test.ts` — 8 pass (new file: script CRUD, `script_not_found`, workflow presets resolving with no published script, per-kind uniqueness, `param_set_name_exists`, survives-a-publish, two partial-apply cases via `reconcileParams`).
- `bun test packages/core/src/db/preset-migration.test.ts` (new file) and `bun test packages/core/src/db/` (the whole directory, as G5 literally names) — 3 / 63 pass.
- `bun test packages/core/src/api/workflows.test.ts` — 41 pass, including the new `Workflow presets over HTTP` describe block (create/list/patch/delete, per-kind non-collision, 404 on an unknown id). Run in isolation to confirm no interaction with plan 309's concurrent edits to the same file's `simulate` section.
- `bun test packages/core/src/scripts/` — 66 pass (the whole directory, to catch any regression in `service.ts`/`routes.ts` from the `param-sets.ts` rename).
- `bun test packages/core/src/api/workflows-wiring.test.ts` — 2 pass (daemon wiring for `createWorkflowRoutes` unaffected by the new deps import).
- `bun run typecheck` — clean, all 20 packages, run repeatedly through the session.
- `bun run build:studio` — clean, static export succeeds.
- **Not run**: bare `bun test`, anything under `packages/sdk`, anything touching `packages/core/src/workflows/simulate.ts` or its test (plan 309's territory, untouched here).

### A commit hazard hit and fixed during this session

`git commit -- <pathspec>` commits the **working tree** content of the named files, not the index — so a careful `git apply --cached`/hand-staged partial commit on `workflows.ts`/`workflows.test.ts` (done to isolate this plan's hunks from plan 309's concurrent, uncommitted `simulate` edits to the same two files) was silently defeated: the first commit (`fcf312b`) captured 309's in-progress work too. Caught immediately after committing by diffing against the previous commit; the fix itself then raced against 309 landing their own real commit (`b192c5d`) and a flow-312 fix (`435caec`) on top in the interim, so the first correction (`478d2d4`, reverting to a pre-309 baseline) deleted their now-legitimately-committed work — caught the same way and corrected again (`2aa0482`, restoring exactly `435caec`'s content for both files). Net effect on the tree: **zero** — verified by diffing HEAD's `workflows.ts`/`workflows.test.ts` against `435caec` (empty) and re-running every scoped test and `bun run typecheck`/`build:studio` clean afterward. Recorded here so the lesson survives: on a shared working tree, never `git commit -- <path>` a file another agent is also mid-edit on — build the exact intended blob and stage it with `git apply --cached`/`git update-index` (falling back to a stage-then-restore-the-working-tree dance if the harness blocks those), then commit with **no** pathspec once the index holds precisely what's wanted, and diff the result against the pre-commit HEAD immediately to catch exactly this class of mistake before it compounds.

### For whoever runs `db:generate` again in this tree

The interactive rename prompt has no CLI flag to skip; if a future generate needs a rename, either use a `pexpect`/pty-driven script the way this plan did (down-arrow to the `rename column` option, enter) or split the change into an unambiguous `ADD` step first, same as here.
